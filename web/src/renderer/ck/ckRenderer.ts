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
import type { FontBook } from "./canvaskit";

// IL RENDERER SU GPU: lo stesso disegno di renderer/canvasRenderer.ts, ma con
// CanvasKit (Skia in WebAssembly) su un contesto WebGL invece che con Canvas 2D.
//
// Non è una riscrittura di ciò che si disegna: la STRUTTURA è la stessa -- stessi
// indici (sceneIndex), stesso scarto di ciò che non si vede, stessi livelli di
// dettaglio, stesso ordine (riempimento, tratti; testo; immagine; vettoriale),
// stesse regole per istanze, override, frame ritaglianti e frame trasparenti --
// e cambiano solo le primitive. Dove i due si differenziano è dichiarato:
//   - il testo usa Inter (l'unico font che il WASM ha), senza crenatura;
//   - ombra e sfocatura valgono per l'INTERO nodo (un livello salvato con un
//     filtro), non per ogni singola passata di disegno;
//   - il tratto interno/esterno ritaglia col contorno esatto, non con un
//     rettangolo allargato.

const DEG = 1; // CanvasKit ruota in GRADI, come il modello.

// Il segnaposto di un'immagine (colori di canvasRenderer.ts::PLACEHOLDER_*).
const PLACEHOLDER_FILL_A = 0.06;
const PLACEHOLDER_LINE_A = 0.35;

interface Frame {
  scene: SceneState;
  zoom: number;
  px: number;
  view: Bounds | null;
  extent: { get(id: string): Bounds | undefined } | null;
  // Tutto ciò che si alloca nell'heap WASM durante il frame (percorsi, shader,
  // filtri) si libera a frame finito: CanvasKit non ha un garbage collector.
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
    if (!handle) throw new Error("WebGL non disponibile");
    this.grCtx = CK.MakeGrContext(handle);
    if (!this.grCtx) throw new Error("contesto Skia non creato");
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

  /** Le misure dei font sono cambiate (un peso è arrivato): si rifà il layout. */
  fontsChanged(): void {
    this.widths = new Map();
    this.textLines = new WeakMap();
  }

  private ensureSurface(w: number, h: number): Surface {
    if (this.surface && this.surfW === w && this.surfH === h) return this.surface;
    this.surface?.delete();
    this.surface = this.CK.MakeOnScreenGLSurface(this.grCtx as GrDirectContext, w, h, this.CK.ColorSpace.SRGB);
    if (!this.surface) throw new Error("superficie WebGL non creata");
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
    // Una scena derivata dalla riproduzione con scale animate non ha extent
    // affidabili per i nodi scalati (vedi AnimInfo): niente scarto per tutta la
    // scena finché dura -- costa nodi in più, mai nodi che spariscono.
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

  // --- traversata: stessa forma di canvasRenderer.ts::drawSiblings -----------

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
      if (!n.visible || seen.has(n.id)) continue;
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
    // Dentro l'istanza i nodi del master hanno l'extent al posto d'origine, non
    // dove l'istanza li disegna: niente scarto (cull = false).
    this.drawSiblings(sk, [resolved.masterRoot], children, new Set(), instanceOverrideMap(n), next, false);
    sk.restore();
  }

  // --- il nodo ---------------------------------------------------------------

  private drawNode(sk: Canvas, n: NodeLite, overrides: ReadonlyMap<string, InstanceOverrideLite> | null): void {
    if (n.kind === "group" || n.kind === "instance") return;
    const f = this.frame as Frame;
    const eff = withOverride(n, overrides?.get(n.id));
    if (inkIsBox(eff) && (eff.width <= 0 || eff.height <= 0)) return;

    // Livello di dettaglio: come nel renderer 2D, a pochi pixel un nodo è un
    // rettangolo piatto del suo colore.
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

    // Scala animata (solo scene derivate dalla riproduzione): come nel 2D, attorno
    // allo stesso centro della rotazione.
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
      // Un frame senza riempimento è trasparente (il grigio di default è delle forme).
      if (!(eff.kind === "frame" && eff.fills.length === 0)) {
        this.drawShape(sk, shape, this.fillPaint(resolvedFill(eff), eff, eff.opacity));
      }
      this.drawStrokes(sk, eff, shape);
    }

    if (layered) sk.restore();
    if (rotated) sk.restore();
  }

  // --- effetti: un livello salvato con un filtro, per l'intero nodo -----------

  private beginEffects(sk: Canvas, n: NodeLite): boolean {
    const filter = this.effectsFilter(n.effects);
    if (!filter) return false;
    const lp = new this.CK.Paint();
    lp.setImageFilter(filter);
    // Un limite al livello, in coordinate locali: senza, ogni nodo con un
    // effetto alloca un livello grande quanto l'intera superficie.
    const bounds = n.kind === "text" ? null : inflateBounds(boundsOfNode(n), effectsOutset(n) + strokeOutsetOfNode(n) + 1);
    sk.saveLayer(lp, bounds ? this.CK.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height) : null);
    lp.delete();
    return true;
  }

  // La PRIMA ombra e la PRIMA sfocatura, come nel renderer 2D. L'ombra poi la
  // sfocatura: la sfocatura vale anche per l'ombra, nello stesso ordine del
  // canvas. `blur` dell'ombra è il raggio del canvas (sigma = blur / 2).
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

  // Imposta la pittura condivisa per un riempimento (colore piatto o gradiente).
  // `opacity` è quella del nodo: nel renderer 2D è globalAlpha, qui si fonde
  // nell'alfa della pittura.
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

  // --- tratti ----------------------------------------------------------------

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
      // Il testo traccia sempre centrato (il canvas non dà il contorno dei glifi).
      p.setStrokeWidth(s.weight);
      this.paintText(sk, n, p);
      return;
    }
    if (s.align === "center") {
      p.setStrokeWidth(s.weight);
      this.drawShape(sk, shape, p);
      return;
    }
    // Interno/esterno: tratto doppio, ritagliato dal contorno esatto.
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
    const font = this.fonts.fontFor(t.style.fontWeight, fontSizeOf(t.style));
    if (!font) return;
    let lines = this.textLines.get(n);
    if (!lines) {
      lines = placeTextLines(this.measureFor(font), n);
      this.textLines.set(n, lines);
    }
    for (const line of lines) sk.drawText(line.text, line.x, line.y, paint, font);
  }

  // --- immagini --------------------------------------------------------------

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
    // Il segnaposto: stesso aspetto del canvas 2D (rettangolo tenue, bordo, croce se manca).
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
    fillB.setFillType(CK.FillType.EvenOdd);
    const fillPath = fillB.detachAndDelete();
    const strokePath = strokeB.detachAndDelete();
    f.garbage.push(fillPath, strokePath);

    if (hasFill) sk.drawPath(fillPath, this.fillPaint(resolvedFill(n), n, n.opacity));
    if (hasStroke) {
      const p = this.strokeP;
      p.setShader(null);
      p.setImageFilter(null);
      const c = resolvedFill(n);
      p.setColor(CK.Color4f(c.r, c.g, c.b, c.a * n.opacity));
      // Spessore costante sullo schermo: dividendo per lo zoom (la matrice del
      // canvas già contiene zoom e dpr).
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

// Una Transform del modello (a b c d e f, semantica del canvas 2D) come matrice 3x3
// di Skia, per righe: [a c e; b d f; 0 0 1].
export function skMatrix(t: Transform): number[] {
  return [t.a, t.c, t.e, t.b, t.d, t.f, 0, 0, 1];
}

function concat(sk: Canvas, t: Transform): void {
  sk.concat(skMatrix(t));
}

// Come shapes.ts::traceSubpath, su un PathBuilder.
function trace(b: import("canvaskit-wasm").PathBuilder, n: NodeLite, sp: import("../../store/types").SubPathLite): void {
  const count = sp.anchors.length;
  const first = anchorPoint(n, sp.anchors[0]);
  b.moveTo(first.x, first.y);
  if (count === 1) {
    // Un solo ancoraggio: segmento di lunghezza nulla, che col capo tondo è un pallino.
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
