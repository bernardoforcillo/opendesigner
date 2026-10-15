import type { EffectLite, FillLite, NodeLite } from "../store/types";
import type { Bounds } from "../canvas/geometry";
import { firstBlur, firstShadow, resolvedFill } from "../renderer/canvasRenderer";
import { fontFamilyOf, fontSizeOf, fontWeightOf, placeTextLines } from "../renderer/text";
import type { MeasureText } from "../renderer/text";
import { hasRealStroke, vectorStyleOf } from "../renderer/vectorStyle";
import { subPathsToD } from "../svg/pathData";
import { meshBitmap } from "../renderer/mesh";
import { encodePng, pngDataUri } from "./rawPng";

// SVG EXPORT — markup from the NODES.
//
// Pure function: nodes in, text out. No DOM, no canvas, no
// camera. It is the reason the correctness of the SVG export is verifiable on
// paper, while that of the PNG requires pixels.
//
// Text comes out as a REAL <text> and not as a path: text converted to
// a path is no longer selectable, editable or searchable in any
// downstream tool, and the only advantage (independence from the installed font)
// is not worth that loss in a design editor.

// The text measure is a PARAMETER and not an internal detail because measuring
// glyphs requires a 2D context: in production it comes from a canvas (see
// export/exportScene.ts), so the SVG's wrapping is EXACTLY the
// canvas's; in tests a fake, deterministic measure comes in. The type lives in
// renderer/text.ts (it shares it with export/region.ts) and is re-exported from here
// because it is part of nodesToSvg's signature.
export type { MeasureText };

// Decimal digits kept in the markup. 3 is amply below a pixel at every
// reasonable scale, and removes floating-point tails
// (0.1 + 0.2 must not end up in the file as 0.30000000000000004).
const DECIMALS = 3;

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const p = 10 ** DECIMALS;
  // + 0 normalizes negative zero: Math.round(-0.0001 * p) / p is -0, and
  // String(-0) is "-0", which is valid but is noise in a text file.
  return String(Math.round(v * p) / p + 0);
}

// The five characters that cannot appear as themselves in XML. They are
// escaped in attributes too and not only in content: `font-family` comes
// from the model, so from a string the user can write.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function channel(v: number): number {
  // The clamp is not needed for the model's values (RGBA float 0..1) but protects
  // the FILE: an out-of-range rgb() is invalid markup, and a document that does not
  // open is worse than an approximated color.
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

interface Attr { name: string; value: string }

function attrs(list: readonly (Attr | null)[]): string {
  return list
    .filter((a): a is Attr => a !== null)
    .map((a) => ` ${a.name}="${a.value}"`)
    .join("");
}

function attr(name: string, value: string | number): Attr {
  return { name, value: typeof value === "number" ? fmt(value) : esc(value) };
}

// A node's fill attributes: color, tint alpha and node
// opacity.
//
// They are THREE distinct things and stay distinct, as in the model and in the
// canvas: `fill-opacity` is the tint's alpha and `opacity` is the node's, and
// the viewer multiplies them exactly as ctx multiplies globalAlpha
// by fillStyle's alpha. The two opacities are omitted when they are 1, which is
// their default value in SVG: neutral attributes on every element are just
// noise in a file someone will read.
function paintAttrs(n: NodeLite, defs: string[]): (Attr | null)[] {
  // Opacity and blend mode travel together: mix-blend-mode is a CSS property, so
  // it goes in `style` (SVG viewers that support blend modes read it from there).
  const opacity = n.opacity === 1 ? null : attr("opacity", n.opacity);
  const blend = n.blendMode ? attr("style", `mix-blend-mode:${n.blendMode}`) : null;
  // A frame without a fill is transparent (as in the canvas), not gray: the
  // default gray of resolvedFill is for shapes.
  if (n.kind === "frame" && n.fills.length === 0) {
    const fx = effectsRef(n, defs);
    return [fx === null ? null : attr("filter", fx), attr("fill", "none"), opacity, blend];
  }
  const f = resolvedFill(n);
  // The gradient before the effect: ids in <defs> follow the order of
  // creation, and a stable file is easier to read and to compare.
  const ref = gradientRef(n, f, defs);
  const fx = effectsRef(n, defs);
  return [
    fx === null ? null : attr("filter", fx),
    attr("fill", ref ?? `rgb(${channel(f.r)},${channel(f.g)},${channel(f.b)})`),
    f.a === 1 || ref !== null ? null : attr("fill-opacity", f.a),
    opacity,
    blend,
  ];
}

// Effects become ONE <filter> in <defs>: the first shadow (feDropShadow) and
// then the first blur (feGaussianBlur), in the same order in which the canvas
// applies them -- the blur applies to the shadow too. As in the canvas, the
// renderer picks the node's first shadow and first blur
// (renderer/canvasRenderer.ts::firstShadow).
//
// The shadow's `blur` is the canvas 2D radius, whose standard deviation is
// half of it (feDropShadow wants the deviation); the blur's `radius` is already a
// standard deviation. The filter region is in document coordinates,
// wide enough to contain offset and blur: the default (-10%/120%)
// would crop a distant shadow.
function effectsRef(n: NodeLite, defs: string[]): string | null {
  const shadows = n.effects?.filter((e): e is Extract<EffectLite, { kind: "dropShadow" }> => e.kind === "dropShadow") ?? [];
  const shadow = firstShadow(n);
  const blur = firstBlur(n);
  const inners = n.effects?.filter((e): e is Extract<EffectLite, { kind: "innerShadow" }> => e.kind === "innerShadow") ?? [];
  if (!shadow && !blur && inners.length === 0) return null;
  const id = `f${defs.length}`;
  const named = inners.length > 0 ? "base" : null; // the stage the inner shadows go on top of
  const pad =
    shadows.reduce((m, sh) => Math.max(m, Math.max(Math.abs(sh.offsetX), Math.abs(sh.offsetY)) + sh.blur * 1.5), 0) +
    (blur ? blur.radius * 3 : 0) + inners.reduce((m, sh) => Math.max(m, Math.max(Math.abs(sh.offsetX), Math.abs(sh.offsetY)) + sh.blur * 1.5), 0) + 1;
  const rgb = (c: { r: number; g: number; b: number }) => `rgb(${channel(c.r)},${channel(c.g)},${channel(c.b)})`;
  // Several shadows: each one is a blurred, offset, flooded copy of the alpha, all
  // merged UNDER the source (the last one lowest).
  const stacked = shadows.length > 1
    ? [...shadows].reverse().map((sh, k) =>
        `<feGaussianBlur${attrs([attr("in", "SourceAlpha"), attr("stdDeviation", sh.blur / 2), attr("result", `b${k}`)])}/>` +
        `<feOffset${attrs([attr("in", `b${k}`), attr("dx", sh.offsetX), attr("dy", sh.offsetY), attr("result", `o${k}`)])}/>` +
        `<feFlood${attrs([attr("flood-color", rgb(sh.color)), attr("flood-opacity", sh.color.a), attr("result", `c${k}`)])}/>` +
        `<feComposite${attrs([attr("in", `c${k}`), attr("in2", `o${k}`), attr("operator", "in"), attr("result", `s${k}`)])}/>`,
      ).join("") +
      `<feMerge${named ? ` result="${named}"` : ""}>${shadows.map((_, k) => `<feMergeNode in="s${k}"/>`).join("")}<feMergeNode in="SourceGraphic"/></feMerge>`
    : "";
  const prims =
    (stacked !== "" ? stacked : shadow
      ? `<feDropShadow${attrs([
          attr("dx", shadow.offsetX), attr("dy", shadow.offsetY), attr("stdDeviation", shadow.blur / 2),
          attr("flood-color", `rgb(${channel(shadow.color.r)},${channel(shadow.color.g)},${channel(shadow.color.b)})`),
          shadow.color.a === 1 ? null : attr("flood-opacity", shadow.color.a),
          named ? attr("result", named) : null,
        ])}/>`
      : "") +
    // Inner shadows: the alpha inverted, blurred, offset and flooded, kept only where the shape
    // is, merged ABOVE the shape (and its drop shadows). Inner shadows and the layer blur
    // come after, in the order the canvas applies them.
    (inners.length > 0
      ? inners.map((sh, k) =>
          `<feComponentTransfer${attrs([attr("in", "SourceAlpha"), attr("result", `iv${k}`)])}><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>` +
          `<feGaussianBlur${attrs([attr("in", `iv${k}`), attr("stdDeviation", sh.blur / 2), attr("result", `ib${k}`)])}/>` +
          `<feOffset${attrs([attr("in", `ib${k}`), attr("dx", sh.offsetX), attr("dy", sh.offsetY), attr("result", `io${k}`)])}/>` +
          `<feFlood${attrs([attr("flood-color", rgb(sh.color)), attr("flood-opacity", sh.color.a), attr("result", `ic${k}`)])}/>` +
          `<feComposite${attrs([attr("in", `ic${k}`), attr("in2", `io${k}`), attr("operator", "in"), attr("result", `is${k}`)])}/>` +
          `<feComposite${attrs([attr("in", `is${k}`), attr("in2", "SourceAlpha"), attr("operator", "in"), attr("result", `ii${k}`)])}/>`,
        ).join("") +
        `<feMerge><feMergeNode in="${shadow || stacked !== "" ? "base" : "SourceGraphic"}"/>${inners.map((_, k) => `<feMergeNode in="ii${k}"/>`).join("")}</feMerge>`
      : "") +
    (blur ? `<feGaussianBlur${attrs([attr("stdDeviation", blur.radius)])}/>` : "");
  defs.push(
    `<filter${attrs([
      attr("id", id), attr("x", n.x - pad), attr("y", n.y - pad),
      attr("width", n.width + 2 * pad), attr("height", n.height + 2 * pad),
    ])} filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${prims}</filter>`,
  );
  return `url(#${id})`;
}

// An image paint becomes a <pattern> over the node's box holding the image: `slice` (cover) for FILL,
// `meet` (contain) for FIT. TILE needs the image's natural size, which a pure generator does not
// have, so it is drawn as FILL. With no resolvable file the paint is the flat base color, like
// the canvas before the image arrives.
let svgHref: ResolveImageHref = () => null;

function imagePatternRef(n: NodeLite, f: FillLite, defs: string[]): string | null {
  const uri = svgHref(f.image!.assetHash);
  if (uri === null) return null;
  const id = `p${defs.length}`;
  defs.push(
    `<pattern${attrs([attr("id", id), attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height)])} patternUnits="userSpaceOnUse">` +
    `<image${attrs([
      attr("href", uri), attr("x", 0), attr("y", 0), attr("width", n.width), attr("height", n.height),
      { name: "preserveAspectRatio", value: f.image!.mode === "fit" ? "xMidYMid meet" : "xMidYMid slice" },
    ])}/></pattern>`,
  );
  return `url(#${id})`;
}

// A MESH paint becomes a <pattern> holding its bitmap as an embedded PNG (the grid blended, renderer/
// mesh.ts), stretched over the node's box by the viewer's own smoothing. 32 pixels a side is plenty
// for a smooth blend and keeps the file small; a one-pixel border repeats the edge.
const MESH_SVG_SIZE = 32;

function meshPatternRef(n: NodeLite, f: FillLite, defs: string[]): string | null {
  if (!(n.width > 0) || !(n.height > 0)) return null;
  const total = MESH_SVG_SIZE + 2;
  const uri = pngDataUri(encodePng(total, total, meshBitmap(f.mesh!, MESH_SVG_SIZE, 1)));
  const id = `p${defs.length}`;
  const sx = n.width / MESH_SVG_SIZE, sy = n.height / MESH_SVG_SIZE;
  defs.push(
    `<pattern${attrs([attr("id", id), attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height)])} patternUnits="userSpaceOnUse">` +
    `<image${attrs([
      attr("href", uri), attr("x", -sx), attr("y", -sy), attr("width", n.width + 2 * sx), attr("height", n.height + 2 * sy),
      { name: "preserveAspectRatio", value: "none" },
    ])}/></pattern>`,
  );
  return `url(#${id})`;
}

// A gradient becomes a <linearGradient>/<radialGradient> in <defs>, with the
// same WORLD coordinates that the canvas computes in renderer/canvasRenderer.ts::
// paintStyle (userSpaceOnUse): no bbox, hence no deformation. It returns
// the `url(#id)` reference to put in `fill`, or null for flat tints
// and for degenerate gradients (same cases as the canvas).
function gradientRef(n: NodeLite, f: FillLite, defs: string[]): string | null {
  if (f.mesh) return meshPatternRef(n, f, defs);
  if (f.image) return imagePatternRef(n, f, defs);
  const g = f.gradient;
  if (!g || g.stops.length < 2) return null;
  const x1 = n.x + g.x1 * n.width, y1 = n.y + g.y1 * n.height;
  const x2 = n.x + g.x2 * n.width, y2 = n.y + g.y2 * n.height;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0)) return null;
  const id = `g${defs.length}`;
  const stops = g.stops
    .map((st) => `<stop${attrs([
      attr("offset", Math.min(1, Math.max(0, st.position))),
      attr("stop-color", `rgb(${channel(st.color.r)},${channel(st.color.g)},${channel(st.color.b)})`),
      st.color.a === 1 ? null : attr("stop-opacity", st.color.a),
    ])}/>`)
    .join("");
  const geom = g.kind === "linear"
    ? attrs([attr("x1", x1), attr("y1", y1), attr("x2", x2), attr("y2", y2)])
    : attrs([attr("cx", x1), attr("cy", y1), attr("r", len)]);
  const tag = g.kind === "linear" ? "linearGradient" : "radialGradient";
  defs.push(`<${tag}${attrs([attr("id", id)])}${geom} gradientUnits="userSpaceOnUse">${stops}</${tag}>`);
  return `url(#${id})`;
}

// A node's STROKE: the first with positive weight (as the canvas draws
// one per strokes[i], but SVG has only one per element). Only centered
// alignment: it is the only one SVG can express without clips.
function strokeAttrs(n: NodeLite, defs: string[]): (Attr | null)[] {
  const s = n.strokes.find((st) => st.weight > 0);
  if (!s) return [];
  const ref = gradientRef(n, s.color, defs);
  const vs = n.kind === "vector" || n.meta ? vectorStyleOf(n) : null;
  return [
    attr("stroke", ref ?? `rgb(${channel(s.color.r)},${channel(s.color.g)},${channel(s.color.b)})`),
    s.color.a === 1 || ref !== null ? null : attr("stroke-opacity", s.color.a),
    attr("stroke-width", s.weight),
    vs && vs.cap !== "butt" ? attr("stroke-linecap", vs.cap) : null,
    vs && vs.join !== "miter" ? attr("stroke-linejoin", vs.join) : null,
    vs && hasRealStroke(n) && vs.miter !== 4 ? attr("stroke-miterlimit", vs.miter) : null,
    vs && vs.dash.length > 0 ? attr("stroke-dasharray", vs.dash.map(fmt).join(" ")) : null,
    vs && vs.dash.length > 0 && vs.dashOffset !== 0 ? attr("stroke-dashoffset", vs.dashOffset) : null,
  ];
}

// A vector as <path>. The canvas fills ONLY closed outlines, while
// SVG also fills open ones (closing them): to stay identical open
// outlines go in a separate <path>, without a fill.
function vectorElement(n: NodeLite, defs: string[]): string {
  const subs = n.vector?.subpaths ?? [];
  const vs = vectorStyleOf(n);
  const closed = subs.filter((sp) => sp.closed && sp.anchors.length >= 2);
  const open = subs.filter((sp) => !(sp.closed && sp.anchors.length >= 2) && sp.anchors.length >= 1);
  const stroke = strokeAttrs(n, defs);
  const out: string[] = [];
  const rule = attr("fill-rule", vs.fillRule ?? "evenodd");
  if (closed.length > 0) {
    out.push(`<path${attrs([attr("d", subPathsToD(closed, n.x, n.y, DECIMALS)), ...paintAttrs(n, defs), rule, ...stroke])}/>`);
  }
  if (open.length > 0 && stroke.length > 0) {
    out.push(`<path${attrs([
      attr("d", subPathsToD(open, n.x, n.y, DECIMALS)), attr("fill", "none"),
      n.opacity === 1 ? null : attr("opacity", n.opacity), ...stroke,
    ])}/>`);
  }
  return out.join("");
}

function rectElement(n: NodeLite, defs: string[]): string {
  // The radius is clamped to half the shorter side, as CanvasRenderingContext2D
  // .roundRect does: without it, the same shape would be drawn differently by the
  // canvas and by the SVG viewer. (The SVG spec also clamps rx, but
  // writing it explicitly makes the file independent of that detail.)
  const r = Math.min(n.cornerRadius, n.width / 2, n.height / 2);
  return `<rect${attrs([
    attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height),
    r > 0 ? attr("rx", r) : null,
    ...paintAttrs(n, defs),
    ...strokeAttrs(n, defs),
  ])}/>`;
}

function ellipseElement(n: NodeLite, defs: string[]): string {
  return `<ellipse${attrs([
    attr("cx", n.x + n.width / 2), attr("cy", n.y + n.height / 2),
    attr("rx", n.width / 2), attr("ry", n.height / 2),
    ...paintAttrs(n, defs),
    ...strokeAttrs(n, defs),
  ])}/>`;
}

// Text: a <text> with a <tspan> per line, each with ITS OWN absolute x and y.
//
// The lines (content, wrapping, alignment, baseline) are computed by
// placeTextLines, that is the same function the canvas uses: the exported
// text sits where the drawn one sits, by construction.
//
// Returns "" for an empty text -- the canvas in that case draws nothing
// (drawText exits immediately), and an empty <text> in the file would be one more
// element that represents nothing.
function textElement(n: NodeLite, measure: MeasureText, defs: string[]): string {
  const style = n.text?.style;
  if (!style) return "";
  const lines = placeTextLines((s) => measure(s, style), n);
  if (lines.length === 0) return "";
  const spans = lines
    .map((l) => `<tspan${attrs([attr("x", l.x), attr("y", l.y)])}>${esc(l.text)}</tspan>`)
    .join("");
  // xml:space="preserve" serves a line's LEADING spaces, which the canvas
  // draws and which SVG would otherwise collapse. The price is that every whitespace
  // INSIDE <text> becomes drawn: that is why the tspans are attached
  // to one another, with no newlines or indentation.
  return `<text${attrs([
    attr("font-family", fontFamilyOf(style)),
    attr("font-size", fontSizeOf(style)),
    attr("font-weight", fontWeightOf(style)),
    ...(style.italic ? [attr("font-style", "italic")] : []),
    ...paintAttrs(n, defs),
  ])} xml:space="preserve">${spans}</text>`;
}

/**
 * From an asset hash to the URI to write in the href, or null when the bytes
 * are not reachable.
 *
 * In production it is a `data:` (see export/exportScene.ts): an SVG that
 * referenced `/assets-api/...` would be broken as soon as the file leaves this
 * machine, that is always, since exporting means precisely sending it
 * elsewhere.
 */
export type ResolveImageHref = (assetHash: string) => string | null;

// The placeholder's colors. They are on purpose the same values as the canvas's
// placeholder (renderer/canvasRenderer.ts): a missing image must look
// the same on screen and in the file.
const PLACEHOLDER_FILL = "rgb(0,0,0)";
const PLACEHOLDER_FILL_OPACITY = 0.06;
const PLACEHOLDER_LINE = "rgb(0,0,0)";
const PLACEHOLDER_LINE_OPACITY = 0.35;

// An image that is there: <image> on the node's box.
//
// `preserveAspectRatio="none"` is not a detail: the canvas draws with
// `drawImage` with four coordinates, that is it STRETCHES the image onto the node's box,
// while the SVG default ("xMidYMid meet") would fit it inside leaving
// margins. Without this attribute the same document would have two different looks
// depending on where it is viewed.
function imageElement(n: NodeLite, href: string, defs: string[]): string {
  const fx = effectsRef(n, defs);
  return `<image${attrs([
    fx === null ? null : attr("filter", fx),
    attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height),
    attr("href", href),
    { name: "preserveAspectRatio", value: "none" },
    n.opacity === 1 ? null : attr("opacity", n.opacity),
    n.blendMode ? attr("style", `mix-blend-mode:${n.blendMode}`) : null,
  ])}/>`;
}

// An image that is NOT there: the same placeholder as the canvas -- faint rectangle,
// border, cross -- instead of the gray <rect> it used to fall into.
//
// A solid rectangle would be the wrong shape twice: it does not say that an image
// was there, and it is confused with a REAL rectangle the user drew.
// The stroke thickness is in document units (an SVG has no zoom from which to infer a
// pixel) and stays thin on any figure.
function imagePlaceholderElement(n: NodeLite): string {
  const w = n.width;
  const h = n.height;
  const cross = `M${fmt(n.x)} ${fmt(n.y)}L${fmt(n.x + w)} ${fmt(n.y + h)}` +
    `M${fmt(n.x + w)} ${fmt(n.y)}L${fmt(n.x)} ${fmt(n.y + h)}`;
  const body =
    `<rect${attrs([
      attr("x", n.x), attr("y", n.y), attr("width", w), attr("height", h),
      attr("fill", PLACEHOLDER_FILL), attr("fill-opacity", PLACEHOLDER_FILL_OPACITY),
      attr("stroke", PLACEHOLDER_LINE), attr("stroke-opacity", PLACEHOLDER_LINE_OPACITY),
    ])}/>` +
    `<path${attrs([
      attr("d", cross), { name: "fill", value: "none" },
      attr("stroke", PLACEHOLDER_LINE), attr("stroke-opacity", PLACEHOLDER_LINE_OPACITY),
    ])}/>`;
  return `<g${attrs([n.opacity === 1 ? null : attr("opacity", n.opacity)])}>${body}</g>`;
}

function element(n: NodeLite, measure: MeasureText, href: ResolveImageHref, defs: string[]): string {
  if (n.kind === "text") return textElement(n, measure, defs);
  if (n.kind === "ellipse") return ellipseElement(n, defs);
  if (n.kind === "vector") return vectorElement(n, defs);
  if (n.kind === "image") {
    const uri = href(n.image?.assetHash ?? "");
    return uri === null ? imagePlaceholderElement(n) : imageElement(n, uri, defs);
  }
  return rectElement(n, defs);
}

// The shape of a mask, geometry only (it goes inside a <clipPath>); null for a node that cannot mask.
function maskGeometry(n: NodeLite): string | null {
  if (n.kind === "ellipse") {
    return `<ellipse${attrs([attr("cx", n.x + n.width / 2), attr("cy", n.y + n.height / 2), attr("rx", n.width / 2), attr("ry", n.height / 2)])}/>`;
  }
  if (n.kind === "rect" || n.kind === "frame") {
    const r = n.kind === "rect" ? Math.min(n.cornerRadius, n.width / 2, n.height / 2) : 0;
    return `<rect${attrs([attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height), r > 0 ? attr("rx", r) : null])}/>`;
  }
  if (n.kind === "vector") {
    const closed = (n.vector?.subpaths ?? []).filter((sp) => sp.closed && sp.anchors.length >= 2);
    if (closed.length === 0) return null;
    return `<path${attrs([attr("d", subPathsToD(closed, n.x, n.y, DECIMALS)), attr("clip-rule", vectorStyleOf(n).fillRule ?? "evenodd")])}/>`;
  }
  return null;
}

/**
 * The SVG markup of `nodes` inside the region `bounds`.
 *
 * `nodes` arrives already filtered and ORDERED (from bottom to top) by
 * export/region.ts: the order of elements in an SVG is the stacking
 * order, so it is the same as the canvas's.
 *
 * `bounds` ends up in the viewBox and NOT in the coordinates: nodes stay written
 * with the model's coordinates, and moving the origin is the viewBox's job. It is
 * the reason an export carries no trace of where the camera was
 * -- and why the file stays readable next to the document.
 */
export function nodesToSvg(
  nodes: readonly NodeLite[],
  bounds: Bounds,
  measure: MeasureText,
  // The default is "no resolvable asset", that is the placeholder: a caller
  // who forgets to pass the resolver gets an HONEST file instead of
  // one that references local URLs destined to break elsewhere.
  href: ResolveImageHref = () => null,
): string {
  svgHref = href;
  const defs: string[] = [];
  // MASKS: a mask node is not drawn; its outline becomes a <clipPath> and the nodes
  // above it under the same parent are wrapped in a <g clip-path>.
  const clipOf = new Map<string, string>();
  const body = nodes
    .map((n) => {
      if (n.isMask) {
        const geometry = maskGeometry(n);
        if (geometry !== null) {
          const id = `m${defs.length}`;
          defs.push(`<clipPath${attrs([attr("id", id)])}>${geometry}</clipPath>`);
          clipOf.set(n.parentId, id);
          return "";
        }
      }
      const out = element(n, measure, href, defs);
      const clip = clipOf.get(n.parentId);
      return out !== "" && clip ? `<g clip-path="url(#${clip})">${out}</g>` : out;
    })
    .filter((s) => s !== "")
    .map((s) => `  ${s}`)
    .join("\n");
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    attrs([attr("width", bounds.width), attr("height", bounds.height)]) +
    ` viewBox="${fmt(bounds.x)} ${fmt(bounds.y)} ${fmt(bounds.width)} ${fmt(bounds.height)}">`;
  const defsBlock = defs.length === 0 ? "" : `\n  <defs>${defs.join("")}</defs>`;
  return `${head}${defsBlock}\n${body}${body === "" ? "" : "\n"}</svg>\n`;
}
