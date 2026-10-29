import type {
  Canvas, CanvasKit, Font, GrDirectContext, Image as SkImage, ImageFilter, Paint, Path, RuntimeEffect, Shader, Surface,
} from "canvaskit-wasm";
import type { Camera } from "@/canvas/camera";
import { type Bounds, boundsIntersect, boundsOfNode, inflateBounds, strokeOutsetOfNode, unionBounds } from "@/canvas/geometry";
import { type Transform, localTransformOf } from "@/canvas/transform";
import { instanceDescentLocal, instanceOverrideMap, resolveInstance } from "@/store/instances";
import type { EffectLite, FillLite, GradientLite, InstanceOverrideLite, MeshLite, NodeLite, SceneState, StrokeLite, TextStyleLite } from "@/store/types";
import { anchorPoint, inHandlePoint, outHandlePoint, subpathFills } from "@/store/vectorGeometry";
import {
  CLIP_MIN_PX, LOD_FLAT_PX, SKIP_SUBTREE_PX, type ImageSource, resolvedFill, rootsOf, withOverride,
} from "@/renderer/canvasRenderer";
import { effectsOutset, sceneIndexOf } from "@/renderer/sceneIndex";
import { MESH_BITMAP_SIZE, meshBitmap } from "@/renderer/mesh";
import { outlineCommands, type PathCmd } from "@/renderer/shapeGeometry";
import { hasArrowheads, strokeHeads } from "@/renderer/arrowheads";
import { sideBandRects } from "@/renderer/strokeSides";
import { variableStrokeCommands } from "@/vector/widthProfile";
import { brushStrokeCommands } from "@/vector/brush";
import { GRADIENT_BITMAP_SIZE, angularStart, gradientBitmap } from "@/renderer/gradientBitmap";
import { VECTOR_STROKE_PX, inkIsBox, nodeCenter } from "@/renderer/shapes";
import { decorationBars, fontSizeOf, hscaleOf, paragraphDecorations, piecesOfLine, piecesOfSegment, placeTextLines, trackedOffsets, type MeasureFor } from "@/renderer/text";
import { FX_TILE, blurBands, overlayEffects, overlayTile, progressiveBlur, tileUnit, withBandBlur, withExpandedGlass } from "@/renderer/effectsFx";
import { buildFx, type BuiltFx } from "@/animation/fx/apply";
import { DISPLACE_SKSL } from "@/animation/fx/timeFx";
import { makeLutShader, readHistogram } from "@/animation/fx/lutImage";
import { hasRealStroke, vectorStyleOf } from "@/renderer/vectorStyle";
import type { FontBook } from "@/renderer/ck/canvaskit";

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

const pad12 = (n: readonly number[]): number[] => { const o = n.slice(0, 12); while (o.length < 12) o.push(0); return o; };
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
  | { kind: "oval"; rect: Float32Array }
  // The computed outlines (polygon, star, arc / ring, smoothed or independent-corner rectangle).
  | { kind: "path"; path: Path };

export class CanvasKitRenderer {
  private surface: Surface | null = null;
  private grCtx: GrDirectContext | null = null;
  private surfW = 0;
  private surfH = 0;
  private readonly fillP: Paint;
  private readonly strokeP: Paint;
  private frame: Frame | null = null;
  // Effect-track layers opened by beginEffects and not yet closed (animation/fx), innermost last.
  private dpr = 1;
  private readonly fxLayers: ({ fx: BuiltFx; box: Bounds; reach: Bounds } | null)[] = [];
  private readonly runtimeEffects = new Map<string, RuntimeEffect | null>();
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
    this.dpr = dpr;
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
    // Masks clip the siblings after them: one save() each, closed at the end.
    let masks = 0;
    for (const n of siblings) {
      if (!n.visible || seen.has(n.id) || overrides?.get(n.id)?.hidden) continue;
      if (n.isMask && (n.kind === "rect" || n.kind === "ellipse" || n.kind === "frame" || n.kind === "vector" || n.kind === "polygon" || n.kind === "star")) {
        seen.add(n.id);
        sk.save();
        masks++;
        this.clipByMask(sk, n);
        continue;
      }
      if (cull && f.extent && f.view) {
        const e = f.extent.get(n.id);
        if (!e || !boundsIntersect(e, f.view)) continue;
        if (n.kind !== "vector" && e.width / f.px < SKIP_SUBTREE_PX && e.height / f.px < SKIP_SUBTREE_PX) continue;
      }
      seen.add(n.id);
      this.drawNode(sk, n, overrides);
      if (n.kind === "instance") {
        this.drawInstance(sk, children, n, visited, overrides);
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
    while (masks-- > 0) sk.restore();
  }

  // Clips by the mask node's outline in the parent's space (see the 2D renderer).
  private clipByMask(sk: Canvas, n: NodeLite): void {
    const CK = this.CK;
    const f = this.frame as Frame;
    const c = nodeCenter(n);
    const rotated = n.rotation % 360 !== 0;
    if (rotated) {
      // The clip is made under the rotation, then the matrix is put back by hand:
      // Skia keeps the clip, not the matrix, across a counter-rotation.
      sk.rotate(n.rotation * DEG, c.x, c.y);
    }
    if (n.kind === "vector") {
      const b = new CK.PathBuilder();
      for (const sp of n.vector?.subpaths ?? []) if (sp.anchors.length > 0 && subpathFills(sp)) trace(b, n, sp);
      b.setFillType(vectorStyleOf(n).fillRule === "nonzero" ? CK.FillType.Winding : CK.FillType.EvenOdd);
      const path = b.detachAndDelete();
      f.garbage.push(path);
      sk.clipPath(path, CK.ClipOp.Intersect, true);
    } else {
      this.clipShape(sk, this.shapeOf(n), CK.ClipOp.Intersect);
    }
    if (rotated) sk.rotate(-n.rotation * DEG, c.x, c.y);
  }

  private drawInstance(
    sk: Canvas, children: Map<string, NodeLite[]>, n: NodeLite, visited: ReadonlySet<string>,
    outer: ReadonlyMap<string, InstanceOverrideLite> | null,
  ): void {
    const f = this.frame as Frame;
    if (!n.instance) return;
    // A swap property of the instance this one sits in may have pointed it at another component.
    const resolved = resolveInstance(f.scene, n, outer);
    if (!resolved || visited.has(resolved.componentId)) return;
    const next = new Set(visited).add(resolved.componentId);
    sk.save();
    concat(sk, instanceDescentLocal(n, resolved.masterRoot));
    // Inside the instance the master's nodes have their extent at the place of origin, not
    // where the instance draws them: no discarding (cull = false).
    this.drawSiblings(sk, [resolved.masterRoot], children, new Set(), instanceOverrideMap(f.scene, n, outer), next, false);
    sk.restore();
  }

  // --- the node --------------------------------------------------------------

  // Device pixels per local unit for an offscreen surface covering `reach`, capped so the surface stays reasonable.
  private offscreenScale(reach: Bounds): number {
    const f = this.frame as Frame;
    const MAX = 4096;
    return Math.min(Math.max(0.05, f.zoom * this.dpr), MAX / Math.max(1, reach.width), MAX / Math.max(1, reach.height));
  }

  // Time Displacement: the node posed at several moments is drawn offscreen, one image each, and a shader picks per
  // pixel which one to show from the map (the node now, the last sample). See DISPLACE_SKSL.
  private drawDisplaced(sk: Canvas, echo: NonNullable<NodeLite["animEcho"]>, reach: Bounds | null, overrides: ReadonlyMap<string, InstanceOverrideLite> | null): void {
    const CK = this.CK;
    const f = this.frame as Frame;
    const area = reach ?? inflateBounds(boundsOfNode(echo.samples[echo.samples.length - 1].node), 64);
    const effect = this.runtimeEffect(DISPLACE_SKSL);
    if (!effect) return;
    const s = this.offscreenScale(area);
    const w = Math.max(1, Math.ceil(area.width * s)), h = Math.max(1, Math.ceil(area.height * s));
    const toLocal = [1 / s, 0, area.x, 0, 1 / s, area.y, 0, 0, 1];
    const shaders = echo.samples.map(({ node }) => {
      const surface = CK.MakeRenderTarget(this.grCtx as GrDirectContext, w, h) ?? CK.MakeSurface(w, h);
      if (!surface) return null;
      const c = surface.getCanvas();
      c.clear(CK.TRANSPARENT);
      c.save();
      c.scale(s, s);
      c.translate(-area.x, -area.y);
      this.drawNode(c, node, overrides);
      c.restore();
      const img = surface.makeImageSnapshot();
      const sh = img.makeShaderOptions(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Linear, CK.MipmapMode.None, toLocal);
      f.garbage.push(surface, img, sh);
      return sh;
    });
    if (shaders.some((x) => x === null)) return;
    const now = shaders[shaders.length - 1] as Shader;
    const shader = effect.makeShaderWithChildren([0, 0, 0, 0, ...pad12(echo.uniforms ?? [])], [now, ...(shaders.slice(0, -1) as Shader[])]);
    f.garbage.push(shader);
    const p = new CK.Paint();
    p.setShader(shader);
    sk.drawRect(CK.XYWHRect(area.x, area.y, area.width, area.height), p);
    p.delete();
  }

  // A node with a time effect (animation/fx/timeFx.ts): the node posed at several moments, each drawn as a layer
  // with its weight, combined inside an isolated layer so they blend with each other and not with the backdrop.
  private drawEchoes(sk: Canvas, n: NodeLite, echo: NonNullable<NodeLite["animEcho"]>, overrides: ReadonlyMap<string, InstanceOverrideLite> | null): void {
    const CK = this.CK;
    const BM = CK.BlendMode;
    const mode = { plus: BM.Plus, screen: BM.Screen, lighten: BM.Lighten, darken: BM.Darken, over: BM.SrcOver, difference: BM.Difference, displace: BM.SrcOver }[echo.mode];
    const reach = n.kind === "text" ? null : unionBounds(echo.samples.map(({ node }) =>
      inflateBounds(boundsOfNode(node), Math.hypot(node.width, node.height) * 0.5 * (node.animScale ?? 1) + effectsOutset(node) + strokeOutsetOfNode(node) + 2)));
    if (echo.mode === "displace") {
      this.drawDisplaced(sk, echo, reach, overrides);
      return;
    }
    sk.saveLayer(undefined, reach ? CK.XYWHRect(reach.x, reach.y, reach.width, reach.height) : null);
    echo.samples.forEach(({ node, weight }, i) => {
      const lp = new CK.Paint();
      lp.setAlphaf(Math.min(1, Math.max(0, weight)));
      lp.setBlendMode(i === 0 ? BM.SrcOver : mode);
      sk.saveLayer(lp, reach ? CK.XYWHRect(reach.x, reach.y, reach.width, reach.height) : null);
      lp.delete();
      this.drawNode(sk, node, overrides);
      sk.restore();
    });
    sk.restore();
  }

  private drawNode(sk: Canvas, n: NodeLite, overrides: ReadonlyMap<string, InstanceOverrideLite> | null): void {
    if (n.kind === "group" || n.kind === "instance") return;
    if (n.animEcho) {
      this.drawEchoes(sk, n, n.animEcho, overrides);
      return;
    }
    const f = this.frame as Frame;
    const eff = withExpandedGlass(withOverride(n, overrides?.get(n.id)));
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
    const outline = eff.kind === "rect" || eff.kind === "ellipse" || eff.kind === "frame" || eff.kind === "polygon" || eff.kind === "star" ? this.shapeOf(eff) : null;
    const bb = eff.effects?.find((e): e is Extract<EffectLite, { kind: "backgroundBlur" }> => e.kind === "backgroundBlur" && e.radius > 0);
    if (bb && outline) this.drawBackdropBlur(sk, outline, bb.radius);
    // A progressive backdrop blur: the same blur in bands, each of its own radius.
    const pbb = progressiveBlur(eff, true);
    if (pbb && outline) {
      for (const band of blurBands(eff, pbb, 1 / f.px)) {
        sk.save();
        this.clipPolygon(sk, band.polygon);
        this.drawBackdropBlur(sk, outline, band.radius);
        sk.restore();
      }
    }

    const drawBody = (c: Canvas = sk) => {
      if (eff.kind === "text") {
        this.drawText(c, eff);
      } else if (eff.kind === "image") {
        this.drawImage(c, eff);
      } else if (eff.kind === "vector") {
        this.drawVector(c, eff);
      } else {
        const shape = this.shapeOf(eff);
        // A frame without a fill is transparent (the default gray belongs to shapes).
        if (!(eff.kind === "frame" && eff.fills.length === 0)) {
          this.drawShape(c, shape, this.fillPaint(resolvedFill(eff), eff, eff.opacity));
        }
        this.drawStrokes(c, eff, shape);
      }
    };
    const pb = progressiveBlur(eff, false);
    if (pb) {
      // A progressive layer blur: the node once per band, clipped to it, with the band's radius.
      for (const band of blurBands(eff, pb, 1 / f.px)) {
        sk.save();
        this.clipPolygon(sk, band.polygon);
        const layered = this.beginEffects(sk, withBandBlur(eff, pb, band.radius));
        this.drawLayerBody(sk, eff, layered, drawBody);
        if (layered) this.endEffects(sk);
        sk.restore();
      }
    } else {
      const layered = this.beginEffects(sk, eff);
      this.drawLayerBody(sk, eff, layered, drawBody);
      if (layered) this.endEffects(sk);
    }
    if (outline) this.drawInnerShadows(sk, eff, outline);
    if (outline || eff.kind === "image") this.drawOverlays(sk, eff, outline);
    if (rotated) sk.restore();
  }

  private clipPolygon(sk: Canvas, pts: readonly (readonly [number, number])[]): void {
    const CK = this.CK;
    const b = new CK.PathBuilder();
    pts.forEach(([x, y], i) => (i === 0 ? b.moveTo(x, y) : b.lineTo(x, y)));
    b.close();
    const path: Path = b.detachAndDelete();
    (this.frame as Frame).garbage.push(path);
    sk.clipPath(path, CK.ClipOp.Intersect, true);
  }

  // Noise and texture: the seeded tile (effectsFx.ts, the same grain as the 2D renderer) as a
  // repeating image shader in world space, anchored at the node's corner, over its box and
  // clipped to its outline.
  private readonly overlayImages = new WeakMap<object, SkImage | null>();

  private overlayImage(e: Parameters<typeof overlayTile>[0]): SkImage | null {
    if (this.overlayImages.has(e)) return this.overlayImages.get(e) ?? null;
    const CK = this.CK;
    const img = CK.MakeImage(
      { width: FX_TILE, height: FX_TILE, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
      overlayTile(e), FX_TILE * 4,
    );
    this.overlayImages.set(e, img);
    return img;
  }

  private drawOverlays(sk: Canvas, n: NodeLite, shape: Shape | null): void {
    const CK = this.CK;
    const f = this.frame as Frame;
    for (const e of overlayEffects(n)) {
      const img = this.overlayImage(e);
      if (!img) continue;
      const u = tileUnit(e);
      const shader: Shader = img.makeShaderOptions(CK.TileMode.Repeat, CK.TileMode.Repeat, CK.FilterMode.Nearest, CK.MipmapMode.None, [u, 0, n.x, 0, u, n.y, 0, 0, 1]);
      f.garbage.push(shader);
      const p = new CK.Paint();
      p.setShader(shader);
      p.setAlphaf(n.opacity);
      sk.save();
      if (shape) this.clipShape(sk, shape, CK.ClipOp.Intersect);
      sk.drawRect(CK.XYWHRect(n.x, n.y, n.width, n.height), p);
      sk.restore();
      p.delete();
    }
  }

  // The frosted glass: what is already drawn, inside the outline, blurred.
  private drawBackdropBlur(sk: Canvas, shape: Shape, radius: number): void {
    const CK = this.CK;
    const backdrop = CK.ImageFilter.MakeBlur(radius, radius, CK.TileMode.Clamp, null);
    (this.frame as Frame).garbage.push(backdrop);
    sk.save();
    this.clipShape(sk, shape, CK.ClipOp.Intersect);
    sk.saveLayer(undefined, null, backdrop);
    sk.restore();
    sk.restore();
  }

  // The shadow of everything outside the outline, cast inward: the shadow-only
  // filter over a ring (a big rectangle with the outline cut out), inside a clip.
  private drawInnerShadows(sk: Canvas, n: NodeLite, shape: Shape): void {
    const inner = n.effects?.filter((e): e is Extract<EffectLite, { kind: "innerShadow" }> => e.kind === "innerShadow");
    if (!inner || inner.length === 0) return;
    const CK = this.CK;
    const f = this.frame as Frame;
    for (const sh of inner) {
      const m = Math.max(Math.abs(sh.offsetX), Math.abs(sh.offsetY)) + Math.max(0, sh.blur) * 2 + 8;
      const b = new CK.PathBuilder();
      b.addRect(CK.XYWHRect(n.x - m, n.y - m, n.width + m * 2, n.height + m * 2));
      if (shape.kind === "rect") b.addRect(shape.rect);
      else if (shape.kind === "rrect") b.addRRect(shape.rr);
      else if (shape.kind === "path") b.addPath(shape.path);
      else b.addOval(shape.rect);
      b.setFillType(CK.FillType.EvenOdd);
      const ring: Path = b.detachAndDelete();
      f.garbage.push(ring);
      const s = Math.max(0, sh.blur) / 2;
      const filter = CK.ImageFilter.MakeDropShadowOnly(sh.offsetX, sh.offsetY, s, s, CK.Color4f(sh.color.r, sh.color.g, sh.color.b, sh.color.a), null);
      f.garbage.push(filter);
      const p = new CK.Paint();
      p.setColor(CK.BLACK);
      p.setImageFilter(filter);
      sk.save();
      this.clipShape(sk, shape, CK.ClipOp.Intersect);
      sk.drawPath(ring, p);
      sk.restore();
      p.delete();
    }
  }

  // --- effects: a layer saved with a filter, for the whole node ---------------

  private beginEffects(sk: Canvas, n: NodeLite): boolean {
    const f = this.frame as Frame;
    const track = (o: { delete(): void }) => f.garbage.push(o as never);
    // Effect tracks (animation/fx): their image filters wrap the node's own, their shaders are
    // drawn over the node inside its layer (endEffects).
    const fx = buildFx(this.CK, n.animFx, track);
    let filter = this.effectsFilter(n.effects);
    if (fx?.filter) {
      // the classic effects first, then the animated ones on top of them
      filter = filter ? this.CK.ImageFilter.MakeCompose(fx.filter, filter) : fx.filter;
      if (filter !== fx.filter) f.garbage.push(filter);
    }
    const blend = n.blendMode ? this.blendModeOf(n.blendMode) : null;
    if (!filter && !blend && !fx?.overlays.length && !(fx?.kernels.length && n.kind !== "group")) return false;
    const lp = new this.CK.Paint();
    if (filter) lp.setImageFilter(filter);
    if (blend) lp.setBlendMode(blend);
    // A bound on the layer, in local coordinates: without it, every node with an
    // effect allocates a layer as large as the whole surface.
    const bounds = n.kind === "text" ? null : inflateBounds(boundsOfNode(n), effectsOutset(n) + strokeOutsetOfNode(n) + 1);
    sk.saveLayer(lp, bounds ? this.CK.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height) : null);
    lp.delete();
    this.fxLayers.push(fx && n.kind !== "group" ? { fx, box: boundsOfNode(n), reach: bounds ?? inflateBounds(boundsOfNode(n), 64) } : null);
    return true;
  }

  // The node's pixels inside the layer: drawn straight, or -- with effect kernels (animation/fx) -- drawn
  // OFFSCREEN and passed through each kernel's shader, which reads them as `src`.
  private drawLayerBody(sk: Canvas, n: NodeLite, layered: boolean, drawBody: (c: Canvas) => void): void {
    const top = layered ? this.fxLayers[this.fxLayers.length - 1] : null;
    if (!top || top.fx.kernels.length === 0 || n.kind === "group") {
      drawBody(sk);
      return;
    }
    const CK = this.CK;
    const f = this.frame as Frame;
    const { box, reach } = top;
    // device pixels per local unit, capped so the offscreen surface stays reasonable
    const s = this.offscreenScale(reach);
    const w = Math.max(1, Math.ceil(reach.width * s)), h = Math.max(1, Math.ceil(reach.height * s));
    const rect = CK.XYWHRect(reach.x, reach.y, reach.width, reach.height);
    let paint: (c: Canvas) => void = drawBody;
    for (const k of top.fx.kernels) {
      const effect = this.runtimeEffect(k.sksl);
      if (!effect) continue;
      const surface = CK.MakeRenderTarget(this.grCtx as GrDirectContext, w, h) ?? CK.MakeSurface(w, h);
      if (!surface) break;
      const c = surface.getCanvas();
      c.clear(CK.TRANSPARENT);
      c.save();
      c.scale(s, s);
      c.translate(-reach.x, -reach.y);
      paint(c);
      c.restore();
      const img = surface.makeImageSnapshot();
      // image pixels -> the node's local space, so the kernel works in world units
      const src = img.makeShaderOptions(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Linear, CK.MipmapMode.None, [1 / s, 0, reach.x, 0, 1 / s, reach.y, 0, 0, 1]);
      // a kernel that looks at the whole node first (Auto Levels, Equalize): count the pixels it receives, build its lookup table
      const children = [src];
      if (k.lut) {
        const hist = readHistogram(CK, img);
        const lut = hist ? makeLutShader(CK, k.lut(hist)) : null;
        if (!lut) { f.garbage.push(surface, img, src); continue; }
        children.push(lut.shader);
        f.garbage.push(lut.image, lut.shader);
      }
      const shader = effect.makeShaderWithChildren([box.x, box.y, box.width, box.height, ...k.uniforms], children);
      f.garbage.push(surface, img, src, shader);
      paint = (target) => {
        const p = new CK.Paint();
        p.setShader(shader);
        target.drawRect(rect, p);
        p.delete();
      };
    }
    paint(sk);
  }

  // Closes the layer opened by beginEffects: first the effects that are shaders (grain,
  // gradients, wipes), drawn over the node's pixels, then the layer is composited.
  private endEffects(sk: Canvas): void {
    const pending = this.fxLayers.pop();
    if (pending) {
      const CK = this.CK;
      const { box, reach } = pending;
      for (const { overlay, values } of pending.fx.overlays) {
        const effect = this.runtimeEffect(overlay.sksl);
        if (!effect) continue;
        const shader = effect.makeShader([box.x, box.y, box.width, box.height, ...overlay.uniforms(values)]);
        const paint = new CK.Paint();
        paint.setShader(shader);
        paint.setBlendMode(overlay.blend === "dstin" ? CK.BlendMode.DstIn : overlay.blend === "srcover" ? CK.BlendMode.SrcOver : CK.BlendMode.SrcATop);
        sk.drawRect(CK.XYWHRect(reach.x, reach.y, reach.width, reach.height), paint);
        paint.delete();
        shader.delete();
      }
    }
    sk.restore();
  }

  private runtimeEffect(src: string) {
    let e = this.runtimeEffects.get(src);
    if (e === undefined) {
      e = this.CK.RuntimeEffect.Make(src, (err) => console.warn("[fx] SkSL error:", err)) ?? null;
      this.runtimeEffects.set(src, e);
    }
    return e;
  }

  private blendModeOf(b: NonNullable<NodeLite["blendMode"]>) {
    const BM = this.CK.BlendMode;
    const table = {
      multiply: BM.Multiply, screen: BM.Screen, overlay: BM.Overlay, darken: BM.Darken, lighten: BM.Lighten,
      "color-dodge": BM.ColorDodge, "color-burn": BM.ColorBurn, "hard-light": BM.HardLight, "soft-light": BM.SoftLight,
      difference: BM.Difference, exclusion: BM.Exclusion, hue: BM.Hue, saturation: BM.Saturation, color: BM.Color,
      luminosity: BM.Luminosity,
    };
    return table[b];
  }

  // The drop shadows (the first alone is MakeDropShadow; several are shadow-only
  // filters stacked under the content, the last lowest) and the FIRST blur. The shadow then the
  // blur: the blur applies to the shadow too, in the same order as the
  // canvas. The shadow's `blur` is the canvas radius (sigma = blur / 2).
  private effectsFilter(effects: readonly EffectLite[] | undefined): ImageFilter | null {
    if (!effects) return null;
    const CK = this.CK;
    const f = this.frame as Frame;
    const shadows = effects.filter((e): e is Extract<EffectLite, { kind: "dropShadow" }> => e.kind === "dropShadow");
    const shadow = shadows[0];
    const blur = effects.find((e): e is Extract<EffectLite, { kind: "layerBlur" }> => e.kind === "layerBlur" && e.radius > 0);
    let filter: ImageFilter | null = null;
    if (shadows.length > 1) {
      for (let i = shadows.length - 1; i >= 0; i--) {
        const sh = shadows[i];
        const s = Math.max(0, sh.blur) / 2;
        const only = CK.ImageFilter.MakeDropShadowOnly(
          sh.offsetX, sh.offsetY, s, s, CK.Color4f(sh.color.r, sh.color.g, sh.color.b, sh.color.a), null,
        );
        filter = CK.ImageFilter.MakeBlend(CK.BlendMode.SrcOver, only, filter);
        f.garbage.push(only, filter);
      }
    } else if (shadow) {
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
    const cmds = outlineCommands(n);
    if (cmds) return { kind: "path", path: this.pathOf(cmds) };
    if (n.kind === "ellipse") return { kind: "oval", rect };
    if (n.kind === "rect" && n.cornerRadius > 0) {
      const r = Math.min(n.cornerRadius, n.width / 2, n.height / 2);
      return { kind: "rrect", rr: CK.RRectXY(rect, r, r) };
    }
    return { kind: "rect", rect };
  }

  // Path commands (renderer/shapeGeometry.ts) as a Skia path, freed with the frame. Even-odd, like the
  // 2D canvas's rings and holes (an arc's ring is two opposite circles); `winding` for brush stamps, which
  // are all wound the same way and must merge where they overlap.
  private pathOf(cmds: readonly PathCmd[], winding = false): Path {
    const CK = this.CK;
    const b = new CK.PathBuilder();
    for (const c of cmds) {
      if (c[0] === "M") b.moveTo(c[1], c[2]);
      else if (c[0] === "L") b.lineTo(c[1], c[2]);
      else if (c[0] === "C") b.cubicTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else b.close();
    }
    b.setFillType(winding ? CK.FillType.Winding : CK.FillType.EvenOdd);
    const path: Path = b.detachAndDelete();
    (this.frame as Frame).garbage.push(path);
    return path;
  }

  private drawShape(sk: Canvas, s: Shape, paint: Paint): void {
    if (s.kind === "rect") sk.drawRect(s.rect, paint);
    else if (s.kind === "rrect") sk.drawRRect(s.rr, paint);
    else if (s.kind === "path") sk.drawPath(s.path, paint);
    else sk.drawOval(s.rect, paint);
  }

  private clipShape(sk: Canvas, s: Shape, op: import("canvaskit-wasm").ClipOp): void {
    const CK = this.CK;
    if (s.kind === "rect") sk.clipRect(s.rect, op, true);
    else if (s.kind === "rrect") sk.clipRRect(s.rr, op, true);
    else if (s.kind === "path") sk.clipPath(s.path, op, true);
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
    if (fill.mesh) {
      const img = this.meshImage(fill.mesh);
      if (img) {
        const f = this.frame as Frame;
        const sx = n.width / MESH_BITMAP_SIZE, sy = n.height / MESH_BITMAP_SIZE;
        const shader: Shader = img.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Linear, CK.MipmapMode.None, [sx, 0, n.x - sx, 0, sy, n.y - sy, 0, 0, 1]);
        f.garbage.push(shader);
        p.setColor(CK.BLACK);
        p.setShader(shader);
        p.setAlphaf(opacity);
        return p;
      }
    }
    if (fill.image) {
      const f = this.frame as Frame;
      const entry = this.images.get(f.scene.id, fill.image.assetHash);
      const img = entry.status === "ready" && entry.image ? this.skImage(entry.image) : null;
      if (img && img.width() > 0 && img.height() > 0) {
        const mode = fill.image.mode;
        const iw = img.width(), ih = img.height();
        const scale = mode === "tile" ? 1 : mode === "fit" ? Math.min(n.width / iw, n.height / ih) : Math.max(n.width / iw, n.height / ih);
        const ox = mode === "tile" ? n.x : n.x + (n.width - iw * scale) / 2;
        const oy = mode === "tile" ? n.y : n.y + (n.height - ih * scale) / 2;
        const tile = mode === "tile" ? CK.TileMode.Repeat : CK.TileMode.Decal;
        const shader: Shader = img.makeShaderOptions(tile, tile, CK.FilterMode.Linear, CK.MipmapMode.None, [scale, 0, ox, 0, scale, oy, 0, 0, 1]);
        f.garbage.push(shader);
        p.setColor(CK.BLACK);
        p.setShader(shader);
        p.setAlphaf(opacity);
        return p;
      }
      // The image has not arrived: the flat base color, like the 2D renderer.
    }
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
        if (g.kind === "diamond") {
          // No native diamond shader: the bitmap (renderer/gradientBitmap.ts), stretched over the box like a mesh.
          const img = this.diamondImage(g, n.width, n.height);
          if (img) {
            const sx = n.width / GRADIENT_BITMAP_SIZE, sy = n.height / GRADIENT_BITMAP_SIZE;
            const ds: Shader = img.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Linear, CK.MipmapMode.None, [sx, 0, n.x - sx, 0, sy, n.y - sy, 0, 0, 1]);
            (this.frame as Frame).garbage.push(ds);
            p.setColor(CK.BLACK);
            p.setShader(ds);
            p.setAlphaf(opacity);
            return p;
          }
          p.setColor(CK.Color4f(fill.r, fill.g, fill.b, fill.a * opacity));
          return p;
        }
        let shader: Shader;
        if (g.kind === "linear") shader = CK.Shader.MakeLinearGradient([x1, y1], [x2, y2], colors, pos, CK.TileMode.Clamp);
        else if (g.kind === "angular") {
          // A sweep gradient starts at +x and runs clockwise (y points down), like the 2D canvas's conic one.
          const start = (angularStart(g, n.width, n.height) * 180) / Math.PI;
          shader = CK.Shader.MakeSweepGradient(x1, y1, colors, pos, CK.TileMode.Clamp, null, 0, start, start + 360);
        } else shader = CK.Shader.MakeRadialGradient([x1, y1], len, colors, pos, CK.TileMode.Clamp);
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
      const vs = n.meta ? vectorStyleOf(n) : null;
      p.setStrokeCap(vs?.cap === "round" ? CK.StrokeCap.Round : vs?.cap === "square" ? CK.StrokeCap.Square : CK.StrokeCap.Butt);
      p.setStrokeJoin(vs?.join === "round" ? CK.StrokeJoin.Round : vs?.join === "bevel" ? CK.StrokeJoin.Bevel : CK.StrokeJoin.Miter);
      if (vs) p.setStrokeMiter(vs.miter);
      if (vs && vs.dash.length > 0) {
        const intervals = vs.dash.length % 2 === 0 ? vs.dash : [...vs.dash, ...vs.dash];
        const fx = CK.PathEffect.MakeDash(intervals, vs.dashOffset);
        (this.frame as Frame).garbage.push(fx);
        p.setPathEffect(fx);
      }
      this.strokeOne(sk, n, shape, s, p);
      p.setPathEffect(null);
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
    if (s.sides && (n.kind === "rect" || n.kind === "frame")) {
      this.strokeSides(sk, n, shape, s);
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

  // Per-side weights: the band between two rectangles (renderer/strokeSides.ts), filled even-odd with the
  // stroke's paint; inside and outside are clipped by the outline like the uniform stroke.
  private strokeSides(sk: Canvas, n: NodeLite, shape: Shape, s: StrokeLite): void {
    const CK = this.CK;
    const { outer, inner } = sideBandRects(n, s);
    const b = new CK.PathBuilder();
    b.addRect(CK.XYWHRect(outer.x, outer.y, outer.width, outer.height));
    b.addRect(CK.XYWHRect(inner.x, inner.y, inner.width, inner.height));
    b.setFillType(CK.FillType.EvenOdd);
    const band: Path = b.detachAndDelete();
    (this.frame as Frame).garbage.push(band);
    const p = this.paintFor(this.fillP, s.color, n, n.opacity);
    sk.save();
    if (s.align !== "center") this.clipShape(sk, shape, s.align === "inside" ? CK.ClipOp.Intersect : CK.ClipOp.Difference);
    sk.drawPath(band, p);
    sk.restore();
  }

  // The arrowheads of a vector's strokes (renderer/arrowheads.ts).
  private drawArrowheads(sk: Canvas, n: NodeLite): void {
    const CK = this.CK;
    for (const s of n.strokes) {
      if (!(s.weight > 0) || (!s.startCap && !s.endCap)) continue;
      for (const g of strokeHeads(n, s.startCap, s.endCap, s.weight)) {
        if (g.filled.length > 0) sk.drawPath(this.pathOf(g.filled), this.paintFor(this.fillP, s.color, n, n.opacity));
        if (g.open.length > 0) {
          const p = this.paintFor(this.strokeP, s.color, n, n.opacity);
          p.setStyle(CK.PaintStyle.Stroke);
          p.setStrokeWidth(s.weight);
          p.setStrokeCap(CK.StrokeCap.Butt);
          p.setStrokeJoin(CK.StrokeJoin.Miter);
          p.setPathEffect(null);
          sk.drawPath(this.pathOf(g.open), p);
        }
      }
    }
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
    const font = n.text ? this.fonts.fontFor(n.text.style.fontWeight, fontSizeOf(n.text.style), n.text.style.fontFamily, n.text.style.italic === true) : null;
    if (font && n.text?.rich) {
      for (const d of paragraphDecorations(this.styleMeasure, n)) {
        const p = new this.CK.Paint();
        p.setAntiAlias(true);
        p.setColor(this.CK.Color4f(d.color.r, d.color.g, d.color.b, d.color.a));
        if (d.kind === "border") { p.setStyle(this.CK.PaintStyle.Stroke); p.setStrokeWidth(d.weight ?? 1); }
        sk.drawRect(this.CK.XYWHRect(d.x, d.y, d.width, d.height), p);
        p.delete();
      }
    }
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
      lines = placeTextLines(this.measureFor(font), n, this.styleMeasure);
      this.textLines.set(n, lines);
    }
    // A piece with letter spacing goes character by character, as on the 2D canvas.
    const put = (text: string, x: number, y0: number, f: Font, style: TextStyleLite, angle = 0) => {
      if (text === "") return;
      const spacing = style.letterSpacing ?? 0, sx = (style.horizontalScale ?? 1) * hscaleOf(style);
      const y = y0 - (style.baselineShift ?? 0);
      // A piece with its own colour is painted with a copy of the node's paint.
      const own = style.color ? paint.copy() : null;
      if (own && style.color) own.setColor(this.CK.Color4f(style.color.r, style.color.g, style.color.b, style.color.a));
      const p = own ?? paint;
      if (sx !== 1 || angle) {
        sk.save();
        sk.translate(x, y);
        if (angle) sk.rotate((angle * 180) / Math.PI, 0, 0);
        sk.scale(sx, 1);
        if (!spacing) sk.drawText(text, 0, 0, p, f);
        else for (const c of trackedOffsets(text, 0, spacing / sx, this.measureFor(f))) sk.drawText(c.ch, c.x, 0, p, f);
        sk.restore();
      } else if (!spacing) sk.drawText(text, x, y, p, f);
      else for (const c of trackedOffsets(text, x, spacing, this.measureFor(f))) sk.drawText(c.ch, c.x, y, p, f);
      own?.delete();
    };
    for (const line of lines) {
      if (!line.segments) {
        for (const p of piecesOfLine(line)) {
          // Small caps and scripts are runs at another size; the font is cached per size.
          const f = p.scale === 1 ? font
            : this.fonts.fontFor(t.style.fontWeight, fontSizeOf(t.style) * p.scale, t.style.fontFamily, t.style.italic === true) ?? font;
          put(p.text, p.x, p.y, f, t.style);
        }
        this.drawBars(sk, [{ x: line.x, width: line.width, style: t.style }], line.y, paint);
        continue;
      }
      // Rich text: every piece in its own font, on the line's baseline (or its own: scripts, small caps).
      for (const seg of line.segments) {
        for (const p of piecesOfSegment(seg, line.y)) {
          const f = this.fonts.fontFor(seg.style.fontWeight, fontSizeOf(seg.style) * p.scale, seg.style.fontFamily, seg.style.italic === true) ?? font;
          put(p.text, p.x, p.y, f, seg.style, seg.angle);
        }
      }
      this.drawBars(sk, line.segments, line.y, paint);
    }
  }

  // The measure of any style (rich text lays out pieces in several fonts); no font -> an estimate.
  private readonly styleMeasure: MeasureFor = (style) => {
    const f = this.fonts.fontFor(style.fontWeight, fontSizeOf(style), style.fontFamily, style.italic === true);
    return f ? this.measureFor(f) : (s) => s.length * fontSizeOf(style) * 0.55;
  };

  // Underline / strikethrough bars under pieces whose style asks for them.
  private drawBars(sk: Canvas, pieces: readonly { x: number; width: number; style: Parameters<typeof decorationBars>[0]; angle?: number }[], baseline: number, paint: Paint): void {
    for (const piece of pieces) {
      if (piece.angle !== undefined) continue; // no underline along a path
      for (const bar of decorationBars(piece.style, baseline - (piece.style.baselineShift ?? 0))) sk.drawRect(this.CK.XYWHRect(piece.x, bar.y, piece.width, bar.height), paint);
    }
  }

  // --- mesh gradients ----------------------------------------------------------
  private readonly meshImages = new WeakMap<MeshLite, SkImage | null>();

  // The mesh's bitmap (renderer/mesh.ts) as a GPU image, made once per mesh.
  private meshImage(mesh: MeshLite): SkImage | null {
    if (this.meshImages.has(mesh)) return this.meshImages.get(mesh) ?? null;
    const CK = this.CK;
    const total = MESH_BITMAP_SIZE + 2;
    const img = CK.MakeImage(
      { width: total, height: total, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
      meshBitmap(mesh, MESH_BITMAP_SIZE, 1), total * 4,
    );
    this.meshImages.set(mesh, img);
    return img;
  }

  private readonly diamondImages = new WeakMap<GradientLite, { key: string; img: SkImage | null }>();

  // A diamond gradient's bitmap as a GPU image; it depends on the box's size, so it is remade when that changes.
  private diamondImage(g: GradientLite, w: number, h: number): SkImage | null {
    const key = `${w}x${h}`;
    const hit = this.diamondImages.get(g);
    if (hit && hit.key === key) return hit.img;
    const CK = this.CK;
    const total = GRADIENT_BITMAP_SIZE + 2;
    const img = CK.MakeImage(
      { width: total, height: total, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
      gradientBitmap(g, w, h, GRADIENT_BITMAP_SIZE, 1), total * 4,
    );
    this.diamondImages.set(g, { key, img });
    return img;
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
        if (s.brush) {
          // BRUSH: tips stamped along the path (vector/brush.ts), filled NON-ZERO so overlapping stamps merge.
          sk.drawPath(this.pathOf(brushStrokeCommands(n, s), true), this.paintFor(this.fillP, s.color, n, n.opacity));
          continue;
        }
        if (s.widthProfile && s.widthProfile.length > 0) {
          // VARIABLE WIDTH: the stroke's region (vector/widthProfile.ts), filled with its paint.
          const region = this.pathOf(variableStrokeCommands(n, s));
          sk.drawPath(region, this.paintFor(this.fillP, s.color, n, n.opacity));
          continue;
        }
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
      if (hasArrowheads(n)) this.drawArrowheads(sk, n);
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
function trace(b: import("canvaskit-wasm").PathBuilder, n: NodeLite, sp: import("@/store/types").SubPathLite): void {
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
