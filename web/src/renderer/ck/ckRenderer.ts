import type {
  Canvas, CanvasKit, Font, GrDirectContext, Image as SkImage, ImageFilter, Paint, Path, Shader, Surface,
} from "canvaskit-wasm";
import type { Camera } from "../../canvas/camera";
import { type Bounds, boundsIntersect, boundsOfNode, inflateBounds, strokeOutsetOfNode } from "../../canvas/geometry";
import { type Transform, localTransformOf } from "../../canvas/transform";
import { instanceDescentLocal, instanceOverrideMap, resolveInstance } from "../../store/instances";
import type { EffectLite, FillLite, InstanceOverrideLite, NodeLite, SceneState, StrokeLite } from "../../store/types";
import { anchorPoint, inHandlePoint, outHandlePoint, subpathFills } from "../../store/vectorGeometry";
import {
  CLIP_MIN_PX, LOD_FLAT_PX, SKIP_SUBTREE_PX, type ImageSource, resolvedFill, rootsOf, withOverride,
} from "../canvasRenderer";
import { effectsOutset, sceneIndexOf } from "../sceneIndex";
import { VECTOR_STROKE_PX, inkIsBox, nodeCenter } from "../shapes";
import { fontSizeOf, placeTextLines } from "../text";
import { hasRealStroke, vectorStyleOf } from "../vectorStyle";
import type { FontBook } from "./canvaskit";

// THE GPU RENDERER: the same drawing as renderer/canvasRenderer.ts, but with
// CanvasKit (Skia in WebAssembly) on a WebGL context instead of Canvas 2D.
//
// It is not a rewrite of what is drawn: the STRUCTURE is the same -- same
// indexes (sceneIndex), same discarding of what is not seen, same levels of
// detail, same order (fill, strokes; text; image; vector),
// same rules for instances, overrides, clipping frames and transparent frames --
// and only the primitives change. Where the two differ it is declared:
//   - text uses Inter (the only font the WASM has), without kerning;
//   - shadow and blur apply to the WHOLE node (a layer saved with a
//     filter), not to every single draw pass;
//   - the inner/outer stroke clips with the exact outline, not with a
//     widened rectangle.

const DEG = 1; // CanvasKit rotates in DEGREES, like the model.

// An image's placeholder (colors of canvasRenderer.ts::PLACEHOLDER_*).
const PLACEHOLDER_FILL_A = 0.06;
const PLACEHOLDER_LINE_A = 0.35;

interface Frame {
  scene: SceneState;
  zoom: number;
  px: number;
  view: Bounds | null;
  extent: { get(id: string): Bounds | undefined } | null;
  // Everything allocated in the WASM heap during the frame (paths, shaders,
  // filters) is freed when the frame ends: CanvasKit has no garbage collector.
  garbage: { delete(): void }[];
}

type Shape =
  | { kind: "rect"; rect: Float32Array }
  | { kind: "rrect"; rr: Float32Array }
  | { kind: "oval"; rect: Float32Array };

export class CanvasKitRenderer {
  private surface: Surface | null = null;
  private grCtx: GrDirectContext | null = null;
  private surfW = 0;
  private surfH = 0;
  private readonly fillP: Paint;
  private readonly strokeP: Paint;
  private frame: Frame | null = null;
  private readonly skImages = new Map<HTMLImageElement, SkImage>();
  private widths = new Map<Font, Map<string, number>>();
  private textLines = new WeakMap<NodeLite, ReturnType<typeof placeTextLines>>();
  lost = false;

  constructor(
    private readonly CK: CanvasKit,
    readonly canvas: HTMLCanvasElement,
    private readonly fonts: FontBook,
    private readonly images: ImageSource,
  ) {
    const handle = CK.GetWebGLContext(canvas, {
      alpha: 1, depth: 0, stencil: 8, antialias: 0, premultipliedAlpha: 1, preserveDrawingBuffer: 0,
      enableExtensionsByDefault: 1, majorVersion: 2,
    });
    if (!handle) throw new Error("WebGL not available");
    this.grCtx = CK.MakeGrContext(handle);
    if (!this.grCtx) throw new Error("Skia context not created");
    this.fillP = new CK.Paint();
    this.fillP.setAntiAlias(true);
    this.strokeP = new CK.Paint();
    this.strokeP.setAntiAlias(true);
    this.strokeP.setStyle(CK.PaintStyle.Stroke);
    canvas.addEventListener("webglcontextlost", this.onLost);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  /** The font measures changed (a weight arrived): the layout is redone. */
  fontsChanged(): void {
    this.widths = new Map();
    this.textLines = new WeakMap();
  }

  private ensureSurface(w: number, h: number): Surface {
    if (this.surface && this.surfW === w && this.surfH === h) return this.surface;
    this.surface?.delete();
    this.surface = this.CK.MakeOnScreenGLSurface(this.grCtx as GrDirectContext, w, h, this.CK.ColorSpace.SRGB);
    if (!this.surface) throw new Error("WebGL surface not created");
    this.surfW = w;
    this.surfH = h;
    return this.surface;
  }

  draw(scene: SceneState, cam: Camera, pageId: string | null): void {
    const CK = this.CK;
    const { canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    if (w <= 0 || h <= 0 || this.lost) return;
    const surface = this.ensureSurface(w, h);
    const sk = surface.getCanvas();
    sk.clear(CK.TRANSPARENT);

    const dpr = canvas.clientWidth > 0 ? w / canvas.clientWidth : window.devicePixelRatio || 1;
    const index = sceneIndexOf(scene);
    const px = 1 / (cam.zoom || 1);
    const cssW = w / dpr;
    const cssH = h / dpr;
    // A playback-derived scene with animated scales has no reliable extents
    // for the scaled nodes (see AnimInfo): no discarding for the whole
    // scene while it lasts -- it costs extra nodes, never nodes that vanish.
    const culling = cssW > 0 && cssH > 0 && cam.zoom > 0 && !(scene.anim && scene.anim.scaled.size > 0);
    const view = culling
      ? inflateBounds({ x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: cssW / cam.zoom, height: cssH / cam.zoom }, 2 * px)
      : null;
    this.frame = { scene, zoom: cam.zoom, px, view, extent: culling ? index.extent : null, garbage: [] };

    sk.save();
    sk.translate(cam.x * dpr, cam.y * dpr);
    sk.scale(cam.zoom * dpr, cam.zoom * dpr);
    this.drawSiblings(sk, rootsOf(scene, index.children, pageId), index.children, new Set(), null, new Set(), true);
    sk.restore();
    surface.flush();

    for (const g of this.frame.garbage) g.delete();
    this.frame = null;
  }

  // --- traversal: same shape as canvasRenderer.ts::drawSiblings --------------

  private drawSiblings(
    sk: Canvas,
    siblings: NodeLite[],
    children: Map<string, NodeLite[]>,
    seen: Set<string>,
    overrides: ReadonlyMap<string, InstanceOverrideLite> | null,
    visited: ReadonlySet<string>,
    cull: boolean,
  ): void {
    const f = this.frame as Frame;
    for (const n of siblings) {
      if (!n.visible || seen.has(n.id) || overrides?.get(n.id)?.hidden) continue;
      if (cull && f.extent && f.view) {
        const e = f.extent.get(n.id);
        if (!e || !boundsIntersect(e, f.view)) continue;
        if (n.kind !== "vector" && e.width / f.px < SKIP_SUBTREE_PX && e.height / f.px < SKIP_SUBTREE_PX) continue;
      }
      seen.add(n.id);
      this.drawNode(sk, n, overrides);
      if (n.kind === "instance") {
        this.drawInstance(sk, children, n, visited);
        continue;
      }
      const kids = children.get(n.id);
      if (!kids || kids.length === 0) continue;
      sk.save();
      concat(sk, localTransformOf(n));
      if (n.kind === "frame" && n.clipsContent && Math.max(n.width, n.height) / f.px >= CLIP_MIN_PX) {
        sk.clipRect(this.CK.XYWHRect(0, 0, n.width, n.height), this.CK.ClipOp.Intersect, true);
      }
      this.drawSiblings(sk, kids, children, seen, overrides, visited, cull);
      sk.restore();
    }
  }

  private drawInstance(sk: Canvas, children: Map<string, NodeLite[]>, n: NodeLite, visited: ReadonlySet<string>): void {
    const f = this.frame as Frame;
    if (!n.instance || visited.has(n.instance.componentId)) return;
    const resolved = resolveInstance(f.scene, n);
    if (!resolved) return;
    const next = new Set(visited).add(n.instance.componentId);
    sk.save();
    concat(sk, instanceDescentLocal(n, resolved.masterRoot));
    // Inside the instance the master's nodes have their extent at the place of origin, not
    // where the instance draws them: no discarding (cull = false).
    this.drawSiblings(sk, [resolved.masterRoot], children, new Set(), instanceOverrideMap(f.scene, n), next, false);
    sk.restore();
  }

  // --- the node --------------------------------------------------------------

  private drawNode(sk: Canvas, n: NodeLite, overrides: ReadonlyMap<string, InstanceOverrideLite> | null): void {
    if (n.kind === "group" || n.kind === "instance") return;
    const f = this.frame as Frame;
    const eff = withOverride(n, overrides?.get(n.id));
    if (inkIsBox(eff) && (eff.width <= 0 || eff.height <= 0)) return;

    // Level of detail: as in the 2D renderer, at a few pixels a node is a
    // flat rectangle of its color.
    const flatSize = eff.kind === "text" ? fontSizeOf(eff.text?.style) : Math.max(eff.width, eff.height);
    if (eff.kind !== "vector" && flatSize / f.px < LOD_FLAT_PX) {
      if (eff.kind === "frame" && eff.fills.length === 0) return;
      const fill = resolvedFill(eff);
      const p = this.fillP;
      p.setShader(null);
      p.setImageFilter(null);
      p.setColor(this.CK.Color4f(fill.r, fill.g, fill.b, fill.a * (eff.kind === "text" ? eff.opacity * 0.5 : eff.opacity)));
      sk.drawRect(this.CK.XYWHRect(eff.x, eff.y, eff.width, eff.height), p);
      return;
    }

    // Animated scale (only playback-derived scenes): as in 2D, around
    // the same center as the rotation.
    const scaled = eff.animScale !== undefined && eff.animScale !== 1;
    const rotated = eff.rotation % 360 !== 0 || scaled;
    if (rotated) {
      const c = eff.animPivot ?? nodeCenter(eff);
      sk.save();
      sk.rotate(eff.rotation * DEG, c.x, c.y);
      if (scaled) {
        sk.translate(c.x, c.y);
        sk.scale(eff.animScale as number, eff.animScale as number);
        sk.translate(-c.x, -c.y);
      }
    }
    const layered = this.beginEffects(sk, eff);

    if (eff.kind === "text") {
      this.drawText(sk, eff);
    } else if (eff.kind === "image") {
      this.drawImage(sk, eff);
    } else if (eff.kind === "vector") {
      this.drawVector(sk, eff);
    } else {
      const shape = this.shapeOf(eff);
      // A frame without a fill is transparent (the default gray belongs to shapes).
      if (!(eff.kind === "frame" && eff.fills.length === 0)) {
        this.drawShape(sk, shape, this.fillPaint(resolvedFill(eff), eff, eff.opacity));
      }
      this.drawStrokes(sk, eff, shape);
    }

    if (layered) sk.restore();
    if (rotated) sk.restore();
  }

  // --- effects: a layer saved with a filter, for the whole node ---------------

  private beginEffects(sk: Canvas, n: NodeLite): boolean {
    const filter = this.effectsFilter(n.effects);
    if (!filter) return false;
    const lp = new this.CK.Paint();
    lp.setImageFilter(filter);
    // A bound on the layer, in local coordinates: without it, every node with an
    // effect allocates a layer as large as the whole surface.
    const bounds = n.kind === "text" ? null : inflateBounds(boundsOfNode(n), effectsOutset(n) + strokeOutsetOfNode(n) + 1);
    sk.saveLayer(lp, bounds ? this.CK.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height) : null);
    lp.delete();
    return true;
  }

  // The FIRST shadow and the FIRST blur, as in the 2D renderer. The shadow then the
  // blur: the blur applies to the shadow too, in the same order as the
  // canvas. The shadow's `blur` is the canvas radius (sigma = blur / 2).
  private effectsFilter(effects: readonly EffectLite[] | undefined): ImageFilter | null {
    if (!effects) return null;
    const CK = this.CK;
    const f = this.frame as Frame;
    const shadow = effects.find((e): e is Extract<EffectLite, { kind: "dropShadow" }> => e.kind === "dropShadow");
    const blur = effects.find((e): e is Extract<EffectLite, { kind: "layerBlur" }> => e.kind === "layerBlur" && e.radius > 0);
    let filter: ImageFilter | null = null;
    if (shadow) {
      const s = Math.max(0, shadow.blur) / 2;
      filter = CK.ImageFilter.MakeDropShadow(
        shadow.offsetX, shadow.offsetY, s, s, CK.Color4f(shadow.color.r, shadow.color.g, shadow.color.b, shadow.color.a), null,
      );
      f.garbage.push(filter);
    }
    if (blur) {
      filter = CK.ImageFilter.MakeBlur(blur.radius, blur.radius, CK.TileMode.Decal, filter);
      f.garbage.push(filter);
    }
    return filter;
  }

  // --- forme e pitture -------------------------------------------------------

  private shapeOf(n: NodeLite): Shape {
    const CK = this.CK;
    const rect = CK.XYWHRect(n.x, n.y, n.width, n.height);
    if (n.kind === "ellipse") return { kind: "oval", rect };
    if (n.kind === "rect" && n.cornerRadius > 0) {
      const r = Math.min(n.cornerRadius, n.width / 2, n.height / 2);
      return { kind: "rrect", rr: CK.RRectXY(rect, r, r) };
    }
    return { kind: "rect", rect };
  }

  private drawShape(sk: Canvas, s: Shape, paint: Paint): void {
    if (s.kind === "rect") sk.drawRect(s.rect, paint);
    else if (s.kind === "rrect") sk.drawRRect(s.rr, paint);
    else sk.drawOval(s.rect, paint);
  }

  private clipShape(sk: Canvas, s: Shape, op: import("canvaskit-wasm").ClipOp): void {
    const CK = this.CK;
    if (s.kind === "rect") sk.clipRect(s.rect, op, true);
    else if (s.kind === "rrect") sk.clipRRect(s.rr, op, true);
    else {
      const b = new CK.PathBuilder();
      b.addOval(s.rect);
      const path: Path = b.detachAndDelete();
      (this.frame as Frame).garbage.push(path);
      sk.clipPath(path, op, true);
    }
  }

  // Sets the shared paint for a fill (flat color or gradient).
  // `opacity` is the node's: in the 2D renderer it is globalAlpha, here it is merged
  // into the paint's alpha.
  private fillPaint(fill: FillLite, n: NodeLite, opacity: number): Paint {
    return this.paintFor(this.fillP, fill, n, opacity);
  }

  private paintFor(p: Paint, fill: FillLite, n: NodeLite, opacity: number): Paint {
    const CK = this.CK;
    const g = fill.gradient;
    p.setImageFilter(null);
    p.setShader(null);
    if (g && g.stops.length >= 2) {
      const x1 = n.x + g.x1 * n.width;
      const y1 = n.y + g.y1 * n.height;
      const x2 = n.x + g.x2 * n.width;
      const y2 = n.y + g.y2 * n.height;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len > 0) {
        const stops = [...g.stops].sort((a, b) => a.position - b.position);
        const colors = stops.map((s) => CK.Color4f(s.color.r, s.color.g, s.color.b, s.color.a));
        const pos = stops.map((s) => Math.min(1, Math.max(0, s.position)));
        const shader: Shader =
          g.kind === "linear"
            ? CK.Shader.MakeLinearGradient([x1, y1], [x2, y2], colors, pos, CK.TileMode.Clamp)
            : CK.Shader.MakeRadialGradient([x1, y1], len, colors, pos, CK.TileMode.Clamp);
        (this.frame as Frame).garbage.push(shader);
        p.setColor(CK.BLACK);
        p.setShader(shader);
        p.setAlphaf(opacity);
        return p;
      }
    }
    p.setColor(CK.Color4f(fill.r, fill.g, fill.b, fill.a * opacity));
    return p;
  }

  // --- strokes ---------------------------------------------------------------

  private drawStrokes(sk: Canvas, n: NodeLite, shape: Shape | null): void {
    const CK = this.CK;
    for (const s of n.strokes) {
      if (!(s.weight > 0)) continue;
      const p = this.paintFor(this.strokeP, s.color, n, n.opacity);
      p.setStyle(CK.PaintStyle.Stroke);
      p.setStrokeCap(CK.StrokeCap.Butt);
      p.setStrokeJoin(CK.StrokeJoin.Miter);
      this.strokeOne(sk, n, shape, s, p);
    }
  }

  private strokeOne(sk: Canvas, n: NodeLite, shape: Shape | null, s: StrokeLite, p: Paint): void {
    const CK = this.CK;
    if (shape === null) {
      // Text always strokes centered (the canvas does not give the glyph outline).
      p.setStrokeWidth(s.weight);
      this.paintText(sk, n, p);
      return;
    }
    if (s.align === "center") {
      p.setStrokeWidth(s.weight);
      this.drawShape(sk, shape, p);
      return;
    }
    // Inner/outer: double stroke, clipped by the exact outline.
    sk.save();
    this.clipShape(sk, shape, s.align === "inside" ? CK.ClipOp.Intersect : CK.ClipOp.Difference);
    p.setStrokeWidth(s.weight * 2);
    this.drawShape(sk, shape, p);
    sk.restore();
  }

  // --- testo -----------------------------------------------------------------

  private measureFor(font: Font): (s: string) => number {
    let cache = this.widths.get(font);
    if (!cache) {
      cache = new Map();
      this.widths.set(font, cache);
    }
    const c = cache;
    return (s) => {
      const hit = c.get(s);
      if (hit !== undefined) return hit;
      const ids = font.getGlyphIDs(s);
      const ws = font.getGlyphWidths(ids);
      let sum = 0;
      for (let i = 0; i < ws.length; i++) sum += ws[i];
      if (c.size > 20000) c.clear();
      c.set(s, sum);
      return sum;
    };
  }

  private drawText(sk: Canvas, n: NodeLite): void {
    this.paintText(sk, n, this.fillPaint(resolvedFill(n), n, n.opacity));
    this.drawStrokes(sk, n, null);
  }

  private paintText(sk: Canvas, n: NodeLite, paint: Paint): void {
    const t = n.text;
    if (n.kind !== "text" || !t || t.content === "") return;
    const font = this.fonts.fontFor(t.style.fontWeight, fontSizeOf(t.style), t.style.fontFamily, t.style.italic === true);
    if (!font) return;
    let lines = this.textLines.get(n);
    if (!lines) {
      lines = placeTextLines(this.measureFor(font), n);
      this.textLines.set(n, lines);
    }
    for (const line of lines) sk.drawText(line.text, line.x, line.y, paint, font);
  }

  // --- images ----------------------------------------------------------------

  private skImage(el: HTMLImageElement): SkImage | null {
    let img = this.skImages.get(el) ?? null;
    if (!img) {
      try {
        img = this.CK.MakeImageFromCanvasImageSource(el);
      } catch {
        return null;
      }
      if (this.skImages.size > 256) {
        for (const old of this.skImages.values()) old.delete();
        this.skImages.clear();
      }
      this.skImages.set(el, img);
    }
    return img;
  }

  private drawImage(sk: Canvas, n: NodeLite): void {
    const CK = this.CK;
    const f = this.frame as Frame;
    const entry = this.images.get(f.scene.id, n.image?.assetHash ?? "");
    if (entry.status === "ready" && entry.image) {
      const img = this.skImage(entry.image);
      if (img) {
        const p = this.fillP;
        p.setShader(null);
        p.setImageFilter(null);
        p.setColor(CK.Color4f(1, 1, 1, n.opacity));
        sk.drawImageRectOptions(
          img, CK.XYWHRect(0, 0, img.width(), img.height()), CK.XYWHRect(n.x, n.y, n.width, n.height),
          CK.FilterMode.Linear, CK.MipmapMode.None, p,
        );
        return;
      }
    }
    // The placeholder: same look as canvas 2D (faint rectangle, border, cross if missing).
    const px = f.px;
    const p = this.fillP;
    p.setShader(null);
    p.setImageFilter(null);
    p.setColor(CK.Color4f(0, 0, 0, PLACEHOLDER_FILL_A * n.opacity));
    sk.drawRect(CK.XYWHRect(n.x, n.y, n.width, n.height), p);
    const sp = this.strokeP;
    sp.setShader(null);
    sp.setImageFilter(null);
    sp.setStyle(CK.PaintStyle.Stroke);
    sp.setColor(CK.Color4f(0, 0, 0, PLACEHOLDER_LINE_A * n.opacity));
    sp.setStrokeWidth(px);
    sk.drawRect(CK.XYWHRect(n.x + px / 2, n.y + px / 2, n.width - px, n.height - px), sp);
    if (entry.status === "missing") {
      sk.drawLine(n.x, n.y, n.x + n.width, n.y + n.height, sp);
      sk.drawLine(n.x + n.width, n.y, n.x, n.y + n.height, sp);
    }
  }

  // --- vettoriale ------------------------------------------------------------

  private drawVector(sk: Canvas, n: NodeLite): void {
    const CK = this.CK;
    const f = this.frame as Frame;
    const fillB = new CK.PathBuilder();
    const strokeB = new CK.PathBuilder();
    let hasFill = false;
    let hasStroke = false;
    for (const sp of n.vector?.subpaths ?? []) {
      if (sp.anchors.length === 0) continue;
      hasStroke = true;
      trace(strokeB, n, sp);
      if (subpathFills(sp)) {
        hasFill = true;
        trace(fillB, n, sp);
      }
    }
    const vs = vectorStyleOf(n);
    fillB.setFillType(vs.fillRule === "nonzero" ? CK.FillType.Winding : CK.FillType.EvenOdd);
    const fillPath = fillB.detachAndDelete();
    const strokePath = strokeB.detachAndDelete();
    f.garbage.push(fillPath, strokePath);

    if (hasFill) sk.drawPath(fillPath, this.fillPaint(resolvedFill(n), n, n.opacity));
    if (hasStroke && hasRealStroke(n)) {
      // Real stroke (see renderer/vectorStyle.ts): same drawing as 2D.
      const cap = vs.cap === "round" ? CK.StrokeCap.Round : vs.cap === "square" ? CK.StrokeCap.Square : CK.StrokeCap.Butt;
      const join = vs.join === "round" ? CK.StrokeJoin.Round : vs.join === "bevel" ? CK.StrokeJoin.Bevel : CK.StrokeJoin.Miter;
      for (const s of n.strokes) {
        if (!(s.weight > 0)) continue;
        const p = this.paintFor(this.strokeP, s.color, n, n.opacity);
        p.setStyle(CK.PaintStyle.Stroke);
        p.setStrokeWidth(s.weight);
        p.setStrokeCap(cap);
        p.setStrokeJoin(join);
        p.setStrokeMiter(vs.miter);
        if (vs.dash.length > 0) {
          const intervals = vs.dash.length % 2 === 0 ? vs.dash : [...vs.dash, ...vs.dash];
          const fx = CK.PathEffect.MakeDash(intervals, vs.dashOffset);
          f.garbage.push(fx);
          p.setPathEffect(fx);
        }
        sk.drawPath(strokePath, p);
        p.setPathEffect(null);
      }
    } else if (hasStroke && vs.hairline) {
      const p = this.strokeP;
      p.setShader(null);
      p.setImageFilter(null);
      const c = resolvedFill(n);
      p.setColor(CK.Color4f(c.r, c.g, c.b, c.a * n.opacity));
      // Constant on-screen thickness: dividing by the zoom (the canvas
      // matrix already contains zoom and dpr).
      p.setStyle(CK.PaintStyle.Stroke);
      p.setStrokeWidth(VECTOR_STROKE_PX / f.zoom);
      p.setStrokeCap(CK.StrokeCap.Round);
      p.setStrokeJoin(CK.StrokeJoin.Round);
      sk.drawPath(strokePath, p);
    }
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    for (const i of this.skImages.values()) i.delete();
    this.skImages.clear();
    this.fillP.delete();
    this.strokeP.delete();
    this.surface?.delete();
    this.surface = null;
    this.grCtx?.releaseResourcesAndAbandonContext();
    this.grCtx = null;
  }
}

// A model Transform (a b c d e f, canvas 2D semantics) as a Skia 3x3
// matrix, by rows: [a c e; b d f; 0 0 1].
export function skMatrix(t: Transform): number[] {
  return [t.a, t.c, t.e, t.b, t.d, t.f, 0, 0, 1];
}

function concat(sk: Canvas, t: Transform): void {
  sk.concat(skMatrix(t));
}

// Like shapes.ts::traceSubpath, on a PathBuilder.
function trace(b: import("canvaskit-wasm").PathBuilder, n: NodeLite, sp: import("../../store/types").SubPathLite): void {
  const count = sp.anchors.length;
  const first = anchorPoint(n, sp.anchors[0]);
  b.moveTo(first.x, first.y);
  if (count === 1) {
    // A single anchor: zero-length segment, which with a round cap is a dot.
    b.lineTo(first.x, first.y);
    return;
  }
  const segments = sp.closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const a = sp.anchors[i];
    const c = sp.anchors[(i + 1) % count];
    const c1 = outHandlePoint(n, a);
    const c2 = inHandlePoint(n, c);
    const to = anchorPoint(n, c);
    b.cubicTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
  }
  if (sp.closed) b.close();
}
