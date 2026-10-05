import type { SceneState, NodeLite, FillLite, StrokeLite, InstanceOverrideLite, EffectLite, AnimInfo } from "../store/types";
import type { Camera } from "../canvas/camera";
import { type Bounds, boundsIntersect, boundsOfNode, inflateBounds, intersectBounds, worldVisualAabbOfNode } from "../canvas/geometry";
import {
  IDENTITY,
  applyTransform,
  compose,
  invertTransform,
  localTransformOf,
  mapBounds,
  type Transform,
} from "../canvas/transform";
import { sceneIndexOf } from "./sceneIndex";
import { contentWorldBounds } from "../store/groups";
import { instanceDescentLocal, instanceOverrideMap, resolveInstance } from "../store/instances";
import {
  nodePath, hitTestNode, inkIsBox, nodeCenter, vectorPaths, hasInk, selectionBoundsOfNode,
  VECTOR_FILL_RULE, VECTOR_STROKE_PX,
} from "./shapes";
import { drawText, strokeText } from "./text";
import { hasRealStroke, vectorStyleOf } from "./vectorStyle";
import { drawDash, perimeterOf, vectorDrawSubpaths } from "./animDraw";
import { imageCache, type CachedImage } from "./imageCache";

const DEG_TO_RAD = Math.PI / 180;

// Exported because the DRAW ORDER is not only the canvas's business:
// the export (export/region.ts) must choose and order nodes exactly
// as whoever draws chooses and orders them, or the exported image would not be
// the one that is seen.
export function sortedVisible(state: SceneState): NodeLite[] {
  return [...state.nodes.values()]
    .filter((n) => n.visible)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

// THE TREE, no longer the flat map.
//
// A node's coordinates are relative to its parent (see
// canvas/transform.ts), so drawing can no longer read x/y and place them:
// it must DESCEND, accumulating the transform of every container. From here
// follow, with no extra choices, order and visibility too:
//   - a container is drawn BEFORE its children (it sits behind its own
//     content), siblings in order key order;
//   - a node unreachable from a page is not drawn: it has no place
//     in the world (same rule as tree.ts::parentExists);
//   - an invisible container takes its whole subtree away with it -- you cannot
//     draw the child of something that is not there.
// Hit-test walks the same path in reverse, and it is the only way for what
// is seen to be exactly what is clicked.
//
// A children-by-parent index (store/tree.ts::childIndexOf) built once
// per call instead of a childrenOf per node: the latter is a scan
// of the map, and the renderer runs on every frame.
type ChildIndex = Map<string, NodeLite[]>;

// The root nodes of the CURRENT PAGE: its direct children, in order key
// order. The canvas shows ONE page at a time, so drawing, hit-test and
// marquee all descend from here -- it is the only point where the page
// choice enters the renderer, and it is what keeps see-vs-select in agreement (the
// three share rootsOf, so they cannot diverge on the page).
//
// currentPageId is a PARAMETER, not a scene field: the current page is
// view state of the store (store.ts), and the renderer remains a pure function.
// Absent (or null) falls back to the FIRST page -- the store's default -- so
// single-page scenes do not need to say it.
export function rootsOf(state: SceneState, children: ChildIndex, currentPageId?: string | null): NodeLite[] {
  const pageId = currentPageId ?? state.pages[0]?.id;
  return pageId !== undefined ? children.get(pageId) ?? [] : [];
}

// The tint with which a node is actually filled, DEFAULT INCLUDED: a
// node without tints is light gray, and that gray is a renderer decision
// (like the text defaults in renderer/text.ts) that does not live in the model.
// Exported because it serves anyone who must reproduce the same fill
// elsewhere -- the SVG export writes `fill` in separate attributes and not in a
// CSS string, but the default must stay the SAME.
export function resolvedFill(n: NodeLite): FillLite {
  return n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 };
}

// Exported because a node's color is also needed OUTSIDE the canvas: the
// editing textarea (ui/TextEditorOverlay.tsx) must write with the same
// color with which the canvas will draw that text. A second
// RGBA-float -> CSS conversion elsewhere would be the usual pair destined to diverge.
export function cssColor(n: NodeLite): string {
  // resolvedFill (track 3, gray default) + cssRgba (track 2, float->CSS):
  // the default lives in one place, the conversion in another.
  return cssRgba(resolvedFill(n));
}

// RGBA float 0..1 -> CSS string. A single function for fills and strokes:
// they are the same Color in the proto, and two independent conversions would diverge
// at the first different rounding.
export function cssRgba(c: FillLite): string {
  const to255 = (v: number) => Math.round(v * 255);
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${c.a})`;
}

// The canvas style (CSS color or CanvasGradient) of a fill on the box of
// `n`. The gradient's normalized coordinates are denormalized on the UNROTATED box:
// the node's rotation is already in the context, so the gradient rotates
// with the shape. A degenerate gradient (null axis or radius, fewer than two stops)
// falls back to the flat color, which is always valid.
export function paintStyle(ctx: CanvasRenderingContext2D, f: FillLite, n: NodeLite): string | CanvasGradient {
  const g = f.gradient;
  if (!g || g.stops.length < 2) return cssRgba(f);
  const x1 = n.x + g.x1 * n.width, y1 = n.y + g.y1 * n.height;
  const x2 = n.x + g.x2 * n.width, y2 = n.y + g.y2 * n.height;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0)) return cssRgba(f);
  const grad = g.kind === "linear"
    ? ctx.createLinearGradient(x1, y1, x2, y2)
    : ctx.createRadialGradient(x1, y1, 0, x1, y1, len);
  for (const st of g.stops) grad.addColorStop(Math.min(1, Math.max(0, st.position)), cssRgba(st.color));
  return grad;
}

// --- THE EFFECTS ---------------------------------------------------------------
//
// Canvas 2D has ONE shadow state and ONE filter, so the renderer
// draws the FIRST shadow and the FIRST blur of a node (the model keeps
// the whole list). Offset and blur are in WORLD coordinates, but shadow* and
// filter do NOT go through the context's transform: they must be scaled by hand
// by zoom * dpr, otherwise the shadow would stay a fixed size while the
// node scales up.
type DropShadowLite = Extract<EffectLite, { kind: "dropShadow" }>;
type LayerBlurLite = Extract<EffectLite, { kind: "layerBlur" }>;

export function firstShadow(n: NodeLite): DropShadowLite | undefined {
  return n.effects?.find((e): e is DropShadowLite => e.kind === "dropShadow");
}
export function firstBlur(n: NodeLite): LayerBlurLite | undefined {
  return n.effects?.find((e): e is LayerBlurLite => e.kind === "layerBlur" && e.radius > 0);
}

// Backing-store pixels per world unit: zoom * dpr, read from the
// transform that drawScene has already put on the context (rotation does not
// change it). Reading it from there and not from window.devicePixelRatio is what makes
// the PNG export right too, which draws with dpr 1 on an offscreen canvas.
// A context without getTransform (the test doubles) falls back to the zoom.
function deviceScale(ctx: CanvasRenderingContext2D, cam: Camera): number {
  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  return m ? Math.hypot(m.a, m.b) : cam.zoom;
}

// Sets shadow and blur on the context for drawing the node. Returns true
// if it did a save(): the caller must do the matching restore. No
// effect = no save, no cost.
function applyEffects(ctx: CanvasRenderingContext2D, n: NodeLite, scale: number): boolean {
  const shadow = firstShadow(n);
  const blur = firstBlur(n);
  if (!shadow && !blur) return false;
  ctx.save();
  if (shadow) {
    ctx.shadowColor = cssRgba(shadow.color);
    ctx.shadowOffsetX = shadow.offsetX * scale;
    ctx.shadowOffsetY = shadow.offsetY * scale;
    ctx.shadowBlur = Math.max(0, shadow.blur) * scale;
  }
  // `radius` is the standard deviation of the gaussian, as in CSS blur().
  if (blur) ctx.filter = `blur(${blur.radius * scale}px)`;
  return true;
}

// The camera always stays in CSS pixels: devicePixelRatio must never
// enter the model or the tools, only here in the actual drawing on the canvas.
function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Aligns the canvas backing-store resolution to its CSS size
// * devicePixelRatio, to avoid blur on HiDPI screens. Returns true if the
// size changed (useful to avoid superfluous resize/clear on every frame).
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = devicePixelRatio();
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

// Draw options. `dpr` exists for a single reason: an OFFSCREEN canvas
// has no device. When drawing for export (export/png.ts) the
// scale is chosen by the user (1x/2x/3x) and the machine's devicePixelRatio must
// not enter into it -- the same document exported at 2x must give the same
// image on a HiDPI laptop and on an external monitor.
export interface DrawOptions {
  dpr?: number;
  // Where already-decoded images come from. The default is the shared
  // cache (renderer/imageCache.ts); it is injected in tests, where no
  // real loading exists.
  images?: ImageSource;
  // The page to draw (store view state). Absent/null falls back to the
  // first page -- see rootsOf. It lives here along with dpr/images because
  // drawScene has a single options parameter: whoever passes only the page can
  // also pass it as a bare string (see drawScene's signature).
  currentPageId?: string | null;
}

/** The minimum that drawing asks of the image cache. */
export interface ImageSource {
  get(docId: string, hash: string): CachedImage;
}

// The PLACEHOLDER colors -- an image that is not there (or has not arrived yet).
// A node whose asset is missing must be SEEN: vanishing would mean a hole in the
// document without explanation, and throwing would mean shutting down the render loop
// for the whole scene.
const PLACEHOLDER_FILL = "rgba(0, 0, 0, 0.06)";
const PLACEHOLDER_LINE = "rgba(0, 0, 0, 0.35)";

// The placeholder. Drawn with fillRect/strokeRect/moveTo and NOT with a Path2D:
// so it stays the only branch of drawScene fully verifiable in this suite
// (jsdom has no Path2D), which is exactly the branch for which it matters most to know
// that it does not throw.
//
// `px` is how much ONE screen pixel is worth in world coordinates: the ctx here is already
// transformed by the camera, so a constant lineWidth would vanish at low
// zoom and thicken at high zoom.
function drawImagePlaceholder(
  ctx: CanvasRenderingContext2D,
  n: NodeLite,
  px: number,
  missing: boolean,
): void {
  ctx.fillStyle = PLACEHOLDER_FILL;
  ctx.fillRect(n.x, n.y, n.width, n.height);
  ctx.strokeStyle = PLACEHOLDER_LINE;
  ctx.lineWidth = px;
  // The border is inset by half a pixel to stay INSIDE the box: a strokeRect on the
  // exact edge draws half the stroke outside, and the image would come out larger
  // than its selection handles.
  ctx.strokeRect(n.x + px / 2, n.y + px / 2, n.width - px, n.height - px);
  // The cross distinguishes "the asset is not there" from "it is arriving": without it, the two states
  // would be the same gray rectangle and a lost image would look like
  // loading forever.
  if (!missing) return;
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(n.x + n.width, n.y + n.height);
  ctx.moveTo(n.x + n.width, n.y);
  ctx.lineTo(n.x, n.y + n.height);
  ctx.stroke();
}

// An image node: the pixels if they exist, the placeholder otherwise.
//
// The image is stretched onto the node's box (`drawImage` with four coordinates), not
// cropped nor letterboxed: the box is born from the file's natural aspect
// (tools/imageDrop.ts) and from there on resizing it is a user choice,
// who must see the effect they ask for. The "fill/fit" modes are a
// separate function, not a default to guess.
function drawImageNode(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  n: NodeLite,
  px: number,
  images: ImageSource,
): void {
  const entry = images.get(state.id, n.image?.assetHash ?? "");
  if (entry.status === "ready" && entry.image) {
    ctx.drawImage(entry.image, n.x, n.y, n.width, n.height);
    return;
  }
  drawImagePlaceholder(ctx, n, px, entry.status === "missing");
}

// The fourth argument is POLYMORPHIC: a DrawOptions (export/png.ts, the image
// tests) OR directly the current page id (ui/App.tsx, the nesting
// tests). They are the same information as two different conveniences --
// whoever only needs to choose the page does not want to build an object -- and drawScene
// normalizes them right away. null/absent = store default (first page, shared
// cache, device dpr).
export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  optsOrPageId?: DrawOptions | string | null,
): void {
  const opts: DrawOptions =
    typeof optsOrPageId === "string" ? { currentPageId: optsOrPageId } : optsOrPageId ?? {};
  const { canvas } = ctx;
  const dpr = opts.dpr ?? devicePixelRatio();
  const images = opts.images ?? imageCache;
  const currentPageId = opts.currentPageId ?? null;
  // One screen pixel in world units, for strokes that must stay the
  // same thickness at every zoom (today: the placeholder's border).
  const px = 1 / (cam.zoom || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  const index = sceneIndexOf(state);
  const children = index.children;
  // The VIEW in the world, to skip what is not seen. Without a valid
  // canvas measurement (test doubles, a canvas not yet sized) nothing is
  // discarded: everything is drawn, as before.
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const cull: Cull | null =
    cssW > 0 && cssH > 0 && cam.zoom > 0
      ? {
          extent: index.extent,
          // Widened by 2 screen px: a zero-area path (the pen
          // tool's point, a horizontal segment) has an extent of size zero and the
          // rectangle comparison is strict; the same margin covers
          // antialiasing and strokes of constant on-screen thickness.
          view: inflateBounds(
            { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: cssW / cam.zoom, height: cssH / cam.zoom },
            2 * px,
          ),
          px,
          anim: state.anim,
        }
      : null;
  drawSiblings(ctx, state, children, rootsOf(state, children, currentPageId), cam, px, images, new Set(), null, new Set(), cull);
  ctx.globalAlpha = 1;
}

// What drawSiblings needs to discard subtrees that do not appear:
// the WORLD extent of every node (renderer/sceneIndex.ts), the view in the world and
// the size of a screen pixel in world units.
interface Cull {
  extent: { get(id: string): Bounds | undefined };
  view: Bounds;
  px: number;
  // Only in scenes derived from playback: see AnimInfo.
  anim?: AnimInfo;
}

// Below this size (screen px) an entire subtree paints nothing
// visible: it is skipped. Below LOD_FLAT_PX a SINGLE node is no longer worth its
// full drawing (path, stroke, gradient, text): it becomes a flat
// rectangle of its color, which at that size is indistinguishable.
export const SKIP_SUBTREE_PX = 0.3;
export const LOD_FLAT_PX = 4;
// A clipping frame smaller than this (screen px) does not clip: what
// overflows by a few pixels is indistinguishable, and creating a Path2D + clip for every
// frame costs more than the rest of the frame.
export const CLIP_MIN_PX = 12;

// The map of overrides that descends together with an instance's subtree
// (masterNodeId -> override), or `null` outside any instance (the page, the
// content of a normal group or frame). See store/instances.ts.
type OverrideMap = ReadonlyMap<string, InstanceOverrideLite> | null;

// The master's node WITH its override applied, if there is one: the override's
// `fills` in place of its own if present, and -- for a text -- the override's `text`
// in place of its content if present. Returns the node UNTOUCHED
// when there is no override (no needless copy). It never touches the geometry
// (x/y/width/height/rotation): an override changes only what the node paints,
// not where it sits -- the same choice as the bounds in store/groups.ts.
export function withOverride(n: NodeLite, ov: InstanceOverrideLite | undefined): NodeLite {
  if (!ov) return n;
  let eff = n;
  if (ov.fills !== undefined) eff = { ...eff, fills: ov.fills };
  if (ov.text !== undefined && eff.text) eff = { ...eff, text: { ...eff.text, content: ov.text } };
  return eff;
}

// Draws a list of siblings (already sorted) in the ctx's CURRENT space,
// descending into each.
//
// Recursion and not an explicit stack like tree.ts::subtreeOf: here the descent is
// COUPLED to the ctx's save/restore, and an explicit stack would have to rebuild by
// hand precisely that coupling. `seen` still bounds the depth
// by the NUMBER of nodes -- a cycle in a malformed document cannot make it descend
// forever.
function drawSiblings(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  children: ChildIndex,
  siblings: NodeLite[],
  cam: Camera,
  px: number,
  images: ImageSource,
  seen: Set<string>,
  overrides: OverrideMap,
  visited: ReadonlySet<string>,
  cull: Cull | null,
): void {
  for (const n of siblings) {
    if (!n.visible || seen.has(n.id)) continue;
    // Out of view, or too small to be seen: skip the WHOLE subtree.
    // `cull` is null inside an instance -- the master's nodes have their extent
    // at their place of origin, not where the instance draws them.
    // A node with animated scale (and its ancestors, whose extent is the union
    // of the children) has in the index an extent that does NOT know the scale: it might
    // declare it out of view while it is coming in. For them no culling -- they
    // are always drawn; it costs one extra node, while skipping it would be a
    // "vanishes mid-animation".
    const anim = cull?.anim;
    if (cull && !(anim && (anim.scaled.has(n.id) || anim.ancestors.has(n.id)))) {
      const e = cull.extent.get(n.id);
      if (!e || !boundsIntersect(e, cull.view)) continue;
      // A vector is not discarded by size: it has a constant on-screen-thickness stroke
      // and may have a null box (a point), but it is seen anyway.
      if (n.kind !== "vector" && e.width / cull.px < SKIP_SUBTREE_PX && e.height / cull.px < SKIP_SUBTREE_PX) continue;
    }
    seen.add(n.id);
    drawNode(ctx, state, n, cam, px, images, overrides);
    // An INSTANCE has no children in `children` (its subtree is virtual):
    // it draws the master under the descent transform, with its OWN
    // overrides, and without descending further here. drawNode has already skipped its box.
    if (n.kind === "instance") {
      drawInstance(ctx, state, children, n, cam, px, images, visited);
      continue;
    }
    const kids = children.get(n.id);
    if (!kids || kids.length === 0) continue;
    // The container enters the transform ONLY for its children: its own
    // coordinates (and its rotation) have already been used above,
    // in its parent's space. save/restore instead of applying the inverse by
    // hand: the ctx already knows how to undo exactly what was composed onto it.
    // localTransformOf NOW also includes the node's rotation (transform.ts),
    // so the children of a rotated container rotate with it.
    ctx.save();
    const t = localTransformOf(n);
    ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
    // A FRAME with clipsContent clips the children to its OWN box. The clip sits
    // here, INSIDE the save/restore and AFTER the transform: it is therefore in the
    // children's local space, where the frame's box is (0,0,width,height) --
    // the frame's origin is the children's origin. It is the SAME clipping that pickIn
    // applies to the point and collectIn to the band (via intersectBounds): see-vs-
    // select, what the clip hides from drawing is not clicked and the marquee
    // does not take it. A frame without clipsContent lets the children overflow.
    if (n.kind === "frame" && n.clipsContent && Math.max(n.width, n.height) / px >= CLIP_MIN_PX) {
      const clip = new Path2D();
      clip.rect(0, 0, n.width, n.height);
      ctx.clip(clip);
    }
    // ...and the subtree of a scaled node moves with it: the descendants'
    // extents are in their base place, so inside it nothing is discarded.
    drawSiblings(ctx, state, children, kids, cam, px, images, seen, overrides, visited, anim?.scaled.has(n.id) ? null : cull);
    ctx.restore();
  }
}

// The VIRTUAL subtree of an instance. As for a normal container the
// content enters the transform inside a save/restore, but the matrix is
// the DESCENT one (instanceDescentLocal: the instance's position plus the
// offset that brings the master's origin to the instance's origin), and the
// "siblings" are only the master's root -- from there drawSiblings' recursion
// descends the rest as for any tree.
//
// `visited` are the componentIds already being rendered on this branch: if the
// instance's component is already inside, we stop (a component whose master
// contains an instance of itself would recurse forever). A FRESH `seen` for the
// master, not the page's: the same component rendered by two
// instances must be drawn twice, and with the shared `seen` the second would
// skip it as "already seen".
function drawInstance(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  children: ChildIndex,
  n: NodeLite,
  cam: Camera,
  px: number,
  images: ImageSource,
  visited: ReadonlySet<string>,
): void {
  if (!n.instance || visited.has(n.instance.componentId)) return;
  const resolved = resolveInstance(state, n);
  if (!resolved) return;
  const nextVisited = new Set(visited).add(n.instance.componentId);
  const overrides = instanceOverrideMap(n);
  ctx.save();
  const t = instanceDescentLocal(n, resolved.masterRoot);
  ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
  drawSiblings(ctx, state, children, [resolved.masterRoot], cam, px, images, new Set(), overrides, nextVisited, null);
  ctx.restore();
}

// The node and nothing else, in its parent's space (which is the ctx's current one).
// The PER-NODE body of the four tracks: size guard (shapes.ts::
// inkIsBox), rotation of the CONTEXT around the center (track 2), and the if-chain
// text/image/vector/shape with their respective strokes (tracks 2/3/4).
function drawNode(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  n: NodeLite,
  cam: Camera,
  px: number,
  images: ImageSource,
  overrides: OverrideMap,
): void {
  // A GROUP is not drawn: a container without geometry of its own (its
  // bounds are the union of the children, store/groups.ts) and what is seen are the
  // children. Explicit and not left to the size guard: a group with
  // width/height != 0 -- written by someone who does not know, or by a document from another
  // version -- would appear as a solid rectangle never drawn by the user.
  // An INSTANCE is not drawn here for the same reason: it has no box of its own,
  // its content is the master (drawInstance draws it after this call).
  if (n.kind === "group" || n.kind === "instance") return;
  // The node WITH its override, if it is descending into an instance that
  // overrides it: from here on `eff` is drawn, not `n`. The override touches only
  // fills/text -- the geometry (box, rotation) stays the master's, so
  // the guards and rotation centers below are identical with or without it.
  const eff = withOverride(n, overrides?.get(n.id));
  // The size guard only applies to shapes whose ink IS the box
  // (rect, ellipse, image, frame): for text and vector a zero side is
  // a legitimate, drawable state. The list of exceptions lives in ONE place
  // only (shapes.ts::inkIsBox), shared with hit-test: a node that is drawn
  // but not clicked -- or the reverse -- is how the two diverge.
  if (inkIsBox(eff) && (eff.width <= 0 || eff.height <= 0)) return;
  // LEVEL OF DETAIL: at a few pixels a node has no more shape, stroke or
  // text to distinguish. A flat rectangle of its color costs a fraction
  // of the full drawing, and it is what allows framing a whole
  // document without paying for every node as if at full size. The
  // vector stays out (a one-anchor path has zero size and is seen
  // anyway), and text counts in font size, not in box.
  const flatSize = eff.kind === "text" ? (eff.text?.style.fontSize || 16) : Math.max(eff.width, eff.height);
  if (eff.kind !== "vector" && flatSize / px < LOD_FLAT_PX) {
    if (eff.kind === "frame" && eff.fills.length === 0) return;
    ctx.globalAlpha = eff.kind === "text" ? eff.opacity * 0.5 : eff.opacity;
    ctx.fillStyle = cssColor(eff);
    ctx.fillRect(eff.x, eff.y, eff.width, eff.height);
    return;
  }
  // ROTATION (track 2): it is the CONTEXT that rotates around the box center
  // (nodeCenter, the same function hit-test uses in the opposite direction), not
  // the geometry -- nodePath and drawText stay axis-aligned. The node is
  // drawn in its own parent's space (the ctx's current one); this
  // rotation is ITS OWN, distinct from the one drawSiblings applies when descending
  // into its children. save/restore ONLY when needed.
  // ANIMATED SCALE (only playback-derived scenes): uniform around the
  // same center as the rotation, so the two compose in the same
  // save/restore. `animPivot` is for groups, which have no box of their own.
  const scaled = eff.animScale !== undefined && eff.animScale !== 1;
  const rotated = eff.rotation % 360 !== 0 || scaled;
  if (rotated) {
    const c = eff.animPivot ?? nodeCenter(eff);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(eff.rotation * DEG_TO_RAD);
    if (scaled) ctx.scale(eff.animScale as number, eff.animScale as number);
    ctx.translate(-c.x, -c.y);
  }
  ctx.globalAlpha = eff.opacity;
  const color = cssColor(eff);
  ctx.fillStyle = paintStyle(ctx, resolvedFill(eff), eff);
  // Effects apply to everything the node draws below: shape, text,
  // image, vector.
  const fx = applyEffects(ctx, eff, deviceScale(ctx, cam));
  if (eff.kind === "text") {
    drawText(ctx, eff);
    drawStrokes(ctx, eff, null);
  } else if (eff.kind === "image") {
    // An image draws itself on its own box (track 3): no
    // fill underneath, and the stroke is not part of its design.
    drawImageNode(ctx, state, eff, px, images);
  } else if (eff.kind === "vector") {
    // The vector has its double pass (even-odd fill + stroke of
    // every outline): it is NOT the model's box, so it does not go through the
    // rectangle branch below. The vector stroke is drawVector's, not
    // drawStrokes' (which is for a box's perimeter).
    drawVector(ctx, eff, color, cam.zoom);
  } else {
    // rect / ellipse / FRAME. A frame is drawn like a rectangle with its
    // fills (nodePath keeps it sharp-cornered even with a cornerRadius), behind
    // its own content -- drawNode runs BEFORE the descent into the children. A SINGLE
    // Path2D per node: the fill's is also the stroke's.
    const path = nodePath(eff);
    // A FRAME without a fill is transparent: it is a container, and the default gray
    // (resolvedFill) is for shapes. Without this exception a frame
    // just wrapped around a selection would hide it under a
    // gray rectangle.
    if (!(eff.kind === "frame" && eff.fills.length === 0)) ctx.fill(path);
    // With a visible fill the shadow has already been given by it: giving it again from the stroke
    // would overlap two shadows on the edge and darken it.
    if (fx && eff.fills.length > 0) ctx.shadowColor = "transparent";
    drawStrokes(ctx, eff, path);
  }
  if (fx) ctx.restore();
  if (rotated) ctx.restore();
}

// --- THE STROKE ---------------------------------------------------------------
//
// Canvas 2D strokes ONLY centered on the path: `lineWidth` is split half
// inside and half outside, and there is no alignment property. The other
// two recipes are obtained by doubling the width -- so the half that
// survives is EXACTLY the requested weight -- and clipping the extra side:
//
//   INSIDE   clip(path)                  -> the inner half remains
//   OUTSIDE  clip(complement, evenodd)  -> the outer half remains
//
// It is the standard technique, and it is exact (not an approximation) for the
// SIMPLE shapes the project draws: rectangle, rounded rectangle, ellipse.
//
// TEXT is a case of its own: a glyph has no Path2D (canvas 2D does not
// expose the text outline), so its stroke is always centered --
// the approximation is declared in renderer/text.ts::strokeText, and
// canvas/geometry.ts::strokeOutsetOfNode counts the overhang with the same
// rule, so measure and drawing stay the same thing.
function drawStrokes(ctx: CanvasRenderingContext2D, n: NodeLite, path: Path2D | null): void {
  // animated `draw` (< 1) on a box: the stroke is drawn for the given fraction of the
  // perimeter. At 1 it is the whole stroke, without dashing (no observable
  // difference and no cost). Text has no perimeter: it ignores `draw`.
  const dashed = n.animDraw !== undefined && n.animDraw < 1 && path !== null;
  if (dashed) ctx.setLineDash(drawDash(perimeterOf(n), n.animDraw as number));
  for (const s of n.strokes) {
    // A non-positive weight is NOT a very thin stroke: it is not a stroke. Canvas
    // with lineWidth 0 draws nothing, and the bounds count no
    // overhang (canvas/geometry.ts::strokeOutset) -- the two things must
    // skip the same stroke.
    if (!(s.weight > 0)) continue;
    ctx.strokeStyle = paintStyle(ctx, s.color, n);
    if (path === null) {
      ctx.lineWidth = s.weight;
      strokeText(ctx, n);
      continue;
    }
    strokeShape(ctx, n, path, s);
  }
  if (dashed) ctx.setLineDash([]);
}

function strokeShape(ctx: CanvasRenderingContext2D, n: NodeLite, path: Path2D, s: StrokeLite): void {
  if (s.align === "center") {
    ctx.lineWidth = s.weight;
    ctx.stroke(path);
    return;
  }
  ctx.save();
  if (s.align === "inside") ctx.clip(path);
  else ctx.clip(outsideClip(n, path, s.weight), "evenodd");
  ctx.lineWidth = s.weight * 2;
  ctx.stroke(path);
  ctx.restore();
}

// The COMPLEMENT of the shape, as a clip region: a rectangle that
// covers the whole outer band PLUS the shape's path, evaluated with evenodd.
// A point inside the shape crosses two edges (even) and therefore stays OUTSIDE
// the region; one in the band crosses only one (odd) and stays
// inside. No path to invert, and the shape is the same as the fill's.
const OUTSIDE_CLIP_MARGIN = 1;

function outsideClip(n: NodeLite, path: Path2D, weight: number): Path2D {
  const b = inflateBounds(boundsOfNode(n), weight + OUTSIDE_CLIP_MARGIN);
  const clip = new Path2D();
  clip.rect(b.x, b.y, b.width, b.height);
  clip.addPath(path);
  return clip;
}

// A vector node in TWO passes: EVERY outline is stroked, and in addition those
// that have area are filled. The stroke is not decoration -- it is what keeps
// an open outline and a closed zero-area outline visible (two
// anchors, or three aligned: two states the pen tool reaches in three clicks,
// and that the fill alone would not paint at all).
//
// The two Path2Ds are separate because an open outline put in the fill's
// would be implicitly closed by the canvas and filled -- and that is why
// vectorPaths returns two of them.
function drawVector(ctx: CanvasRenderingContext2D, n: NodeLite, color: string, zoom: number): void {
  // animated DRAW-ON (< 1): only the stroke is seen, each outline for the given fraction
  // of its own length; the fill appears when the path is
  // complete (at 1 it falls back to the normal drawing below).
  if (n.animDraw !== undefined && n.animDraw < 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = VECTOR_STROKE_PX / zoom;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const sp of vectorDrawSubpaths(n)) {
      ctx.setLineDash(drawDash(sp.length, n.animDraw));
      ctx.stroke(sp.path);
    }
    ctx.setLineDash([]);
    return;
  }
  const { fill, stroke } = vectorPaths(n);
  // The even-odd rule is a CHOICE (motivated on shapes.ts::VECTOR_FILL_RULE)
  // and not the canvas default, so it must be passed to every fill. It is the same
  // one hit-test uses: a hole that is seen but clicked would be the signature of
  // two different rules.
  const vs = vectorStyleOf(n);
  if (fill) ctx.fill(fill, vs.fillRule ?? VECTOR_FILL_RULE);
  if (stroke && hasRealStroke(n)) {
    // REAL STROKE (nodes imported from SVG, or with a stroke from the panel): weight
    // in world units, own color/gradient, and caps/joins/dashing from the
    // meta (renderer/vectorStyle.ts). It replaces the 1.5px hairline, which
    // exists only to make a path visible without any other ink.
    ctx.lineCap = vs.cap;
    ctx.lineJoin = vs.join;
    ctx.miterLimit = vs.miter;
    ctx.setLineDash(vs.dash);
    ctx.lineDashOffset = vs.dashOffset;
    for (const s of n.strokes) {
      if (!(s.weight > 0)) continue;
      ctx.strokeStyle = paintStyle(ctx, s.color, n);
      ctx.lineWidth = s.weight;
      ctx.stroke(stroke);
    }
    ctx.setLineDash([]);
  } else if (stroke && vs.hairline) {
    ctx.strokeStyle = color;
    // The ctx is in WORLD transform (drawScene applies zoom * dpr), so
    // a constant on-screen thickness is obtained by dividing by the zoom --
    // dpr takes care of itself, being in the same matrix. Without it, a path's
    // line would thicken along with the drawing and at zoom 64 would be a band.
    ctx.lineWidth = VECTOR_STROKE_PX / zoom;
    // Round joins and caps: they are also what makes an outline of a SINGLE
    // anchor visible, which shapes.ts strokes as a zero-length
    // segment (the pen tool's dot after the first click).
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(stroke);
  }
}

// hitTest in WORLD coordinates. Returns the topmost node -- the INNERMOST
// where subtrees overlap, because a child is drawn on top of its
// container. Whoever will select the GROUP instead of the child (a click
// selects the group, a double click enters) climbs from here with the tree: it is
// a selection policy, not a hit-test one, and it must not be hidden in here.
//
// It carries BOTH pieces of information from the parallel tracks: `zoom` (track 4)
// goes all the way to hitTestNode because the grab around an OPEN vector
// outline is in SCREEN px (shapes.ts::VECTOR_HIT_PX); `currentPageId` (track 1)
// chooses the page to descend from -- the same scoping as drawScene, so what
// is seen is what is clicked.
export function hitTest(
  state: SceneState,
  wx: number,
  wy: number,
  zoom: number,
  currentPageId?: string | null,
): string | null {
  const index = sceneIndexOf(state);
  const children = index.children;
  // The WORLD point and the tolerance (the grab around an open path is in
  // screen px, see shapes.ts::VECTOR_HIT_PX): they serve to skip subtrees
  // whose extent cannot contain it.
  const prune: Prune = { extent: index.extent, x: wx, y: wy, pad: HIT_PRUNE_PX / (zoom || 1) };
  return pickIn(state, children, rootsOf(state, children, currentPageId), wx, wy, zoom, new Set(), new Set(), prune);
}

// The SAME walk as drawSiblings, in reverse: siblings from last to
// first (the last is the topmost) and, within each, first the subtree and
// then the node itself.
//
// (px, py) is the point in the LOCAL space of these siblings, that is the one in
// which their coordinates are written: that is where hitTestNode compares them. To
// descend into a container the INVERSE of the transform the renderer applies
// to the ctx is applied to the point -- the same localTransformOf (rotation
// included), read in the other direction.
// Like Cull, for hit-test: the point in the WORLD (pickIn's px/py are in the siblings'
// LOCAL space and change on every descent) and the tolerance in world units.
// `null` inside an instance, for the same reason as drawSiblings.
interface Prune {
  extent: { get(id: string): Bounds | undefined };
  x: number;
  y: number;
  pad: number;
}
// Margin with which a subtree is tried before being discarded (screen px): it covers
// the grab around open paths and what an estimated extent may miss.
const HIT_PRUNE_PX = 12;

function pickIn(
  state: SceneState,
  children: ChildIndex,
  siblings: NodeLite[],
  px: number,
  py: number,
  zoom: number,
  seen: Set<string>,
  visited: ReadonlySet<string>,
  prune: Prune | null,
): string | null {
  for (let i = siblings.length - 1; i >= 0; i--) {
    const n = siblings[i];
    if (!n.visible || seen.has(n.id)) continue;
    if (prune && n.kind !== "instance") {
      const e = prune.extent.get(n.id);
      if (!e || prune.x < e.x - prune.pad || prune.x > e.x + e.width + prune.pad ||
          prune.y < e.y - prune.pad || prune.y > e.y + e.height + prune.pad) continue;
    }
    seen.add(n.id);
    // An INSTANCE is OPAQUE to selection from outside: we descend into the master (with the
    // point brought into the master's space by the descent inverse) and, if
    // something there is hit, the answer is the INSTANCE -- never a node of the
    // master, which from outside is not selectable on its own. If nothing is
    // hit, `continue`: an instance has no box of its own to hit (like a
    // group), so it does not steal the click from what lies under it.
    if (n.kind === "instance") {
      if (hitInstance(state, children, n, px, py, zoom, visited)) return n.id;
      continue;
    }
    const kids = children.get(n.id);
    if (kids && kids.length > 0) {
      const inner = applyTransform(invertTransform(localTransformOf(n)), px, py);
      // A FRAME with clipsContent hides the children outside its own box: if the
      // point (already in the frame's local space, where the box is
      // (0,0,width,height)) falls outside, those children are clipped away -- they are not
      // drawn there (drawSiblings) and must not be clicked. Same geometry,
      // same result: see-vs-select. The frame itself stays hittable on its
      // box (hitTestNode below). Without a clip the descent is as always.
      const clipsAway =
        n.kind === "frame" && n.clipsContent &&
        !(inner.x >= 0 && inner.x <= n.width && inner.y >= 0 && inner.y <= n.height);
      if (!clipsAway) {
        const hit = pickIn(state, children, kids, inner.x, inner.y, zoom, seen, visited, prune);
        if (hit) return hit;
      }
    }
    if (hitTestNode(n, px, py, zoom)) return n.id;
  }
  return null;
}

// The hit-test of an instance's VIRTUAL subtree: brings the point into the master's space
// (inverse of the descent transform) and tries it on the master;
// `true` if it HITS something in there -- the caller then returns the
// INSTANCE's id, not that of the master node hit. `visited` and the fresh `seen`
// as in drawInstance: the cycle of a self-referential component stops, and
// the same master hit by two instances does not "self-exclude".
function hitInstance(
  state: SceneState,
  children: ChildIndex,
  n: NodeLite,
  px: number,
  py: number,
  zoom: number,
  visited: ReadonlySet<string>,
): boolean {
  if (!n.instance || visited.has(n.instance.componentId)) return false;
  const resolved = resolveInstance(state, n);
  if (!resolved) return false;
  const inner = applyTransform(invertTransform(instanceDescentLocal(n, resolved.masterRoot)), px, py);
  const nextVisited = new Set(visited).add(n.instance.componentId);
  return pickIn(state, children, [resolved.masterRoot], inner.x, inner.y, zoom, new Set(), nextVisited, null) !== null;
}

// The nodes whose WORLD box intersects `bounds`, in DRAW order. It is the
// marquee's question ("what is inside this rectangle"), and it lives here with
// drawScene/hitTest because it must answer with the SAME nodes: a marquee
// that selects what the renderer does not draw is the same see-vs-click
// divergence hit-test avoids, only taken from the other side.
// Hence the same descent: we start from the pages' children (whoever is not
// reachable has no place in the world) and an invisible container takes
// its whole subtree away with it.
//
// Unlike pickIn here the transform is accumulated GOING DOWN (local ->
// world) instead of inverted: the marquee rectangle is a single one and sits in the
// world, while the boxes to compare are one per node.
//
// Like hitTest, it NEVER answers with a group (see collectIn): it answers with
// what is seen, and climbing up to groups is the selection policy's job.
export function nodesIntersecting(state: SceneState, bounds: Bounds, currentPageId?: string | null): string[] {
  const index = sceneIndexOf(state);
  const children = index.children;
  const out: string[] = [];
  // The marquee also grabs what is nearby (the band widens on degenerate
  // paths, selectionBoundsOfNode): it is tried with a margin before discarding.
  const probe = inflateBounds(bounds, MARQUEE_PRUNE_PAD);
  collectIn(state, children, rootsOf(state, children, currentPageId), IDENTITY, bounds, out, new Set(), { extent: index.extent, probe });
  return out;
}

// `toWorld` brings to the world the space in which the coordinates of
// THESE siblings are written, that is that of their parent (identity for a page's
// children): the same direction as the warning on worldTransformOf.
//
// The descent is not pruned when a container's box misses the marquee: a
// group does not necessarily contain its own children (its box is its own, not
// the union), so a child inside the marquee would stay out of the
// selection. Only what is not seen is skipped.
const MARQUEE_PRUNE_PAD = 16;

function collectIn(
  state: SceneState,
  children: ChildIndex,
  siblings: NodeLite[],
  toWorld: Transform,
  bounds: Bounds,
  out: string[],
  seen: Set<string>,
  prune: { extent: { get(id: string): Bounds | undefined }; probe: Bounds } | null,
): void {
  for (const n of siblings) {
    if (!n.visible || seen.has(n.id)) continue;
    // The subtree whose extent does not even touch the widened band has
    // nothing to offer. Not inside an instance (extent in the place of origin) and not
    // for an instance itself, which has its derived bounds below. `probe` is
    // the ORIGINAL band inside a clipping frame? No: a clipping frame's extent
    // is already narrowed to its box, so the comparison stays valid.
    if (prune && n.kind !== "instance") {
      const e = prune.extent.get(n.id);
      if (!e || !boundsIntersect(e, prune.probe)) continue;
    }
    seen.add(n.id);
    // An INSTANCE enters the marquee on its DERIVED bounds (the master's subtree
    // mapped by the descent, store/groups.ts::contentWorldBounds -- the
    // same frame the overlay draws): no descent into the master (its
    // children are not selectable from outside), the instance is added and that is all.
    // A missing master has no bounds and does not enter, as it is not drawn and not
    // hit. The cycle guard is inside contentWorldBounds.
    if (n.kind === "instance") {
      const b = contentWorldBounds(state, n);
      if (b && boundsIntersect(b, bounds)) out.push(n.id);
      continue;
    }
    // The box on which the MARQUEE grabs the node is the VISUAL one, not the raw
    // model box (track 2/4): worldVisualAabbOfNode for shapes whose
    // ink IS the box -- rotation included and stroke overhang included -- and
    // selectionBoundsOfNode for the vector, which widens only the degenerate
    // axis (a horizontal segment, a one-anchor path) so a
    // marquee passing next to it takes it anyway. `hasInk` keeps out a
    // vector with NO anchor: it is not seen and not clicked, so it must not
    // even end up in a marquee. A GROUP NEVER enters on its own account,
    // as it is not drawn (drawNode) and not hit (hitTestNode): selecting
    // it is the job of the POLICY (store/groups.ts), which climbs to groups
    // from the CHILDREN taken below.
    if (n.kind !== "group" && hasInk(n)) {
      const visual = n.kind === "vector" ? selectionBoundsOfNode(n) : worldVisualAabbOfNode(n);
      if (boundsIntersect(mapBounds(toWorld, visual), bounds)) out.push(n.id);
    }
    const kids = children.get(n.id);
    if (!kids || kids.length === 0) continue;
    // The clip of a FRAME with clipsContent uses the MODEL's box (not the
    // visual one): it is the box it clips to, and it narrows the band to its own
    // WORLD box before descending -- the children count only for the part that is SEEN
    // inside the frame, as drawing clips them (drawSiblings) and hit-test
    // hides them (pickIn). intersectBounds returns null when the band does not touch
    // the frame's box at all.
    const frameBox = mapBounds(toWorld, boundsOfNode(n));
    let childBounds: Bounds | null = bounds;
    if (n.kind === "frame" && n.clipsContent) {
      childBounds = intersectBounds(bounds, frameBox);
      if (!childBounds) continue;
    }
    collectIn(state, children, kids, compose(toWorld, localTransformOf(n)), childBounds, out, seen, prune);
  }
}
