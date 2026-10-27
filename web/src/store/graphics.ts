import { BlendMode, VariableType } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Layer as PbLayer, ObjectStyleDef as PbObjectStyleDef, Variable as PbVariable } from "@/gen/opendesigner/v1/opendesigner_pb";
import { cmykToRgb, rgbToCmyk, type Cmyk, type Rgb } from "@/color/cmyk";
import { arePaintsValid } from "@/store/paints";
import { recordDelta } from "@/store/sceneDelta";
import { OBJECT_STYLE_PROPS, type FillLite, type NodeLite, type ObjectStyleLite, type SceneState, type VariableLite } from "@/store/types";

// GRAPHICS AND COLOUR -- object styles, layers and swatches. The TypeScript twin of internal/core/graphics.go
// (Go is the authority; every rule here repeats one there). See docs/graphics-colour.md.
//
//   Object styles: a shared look for shapes. A node with `objectStyleId` is drawn with the properties its style
//   (and the styles it is based on, the nearest winning) sets; its own values stay as the fallback.
//   Layers: shared by all pages. A hidden layer hides what is on it, a locked one keeps it from being picked.
//   Swatches: color variables with a print definition (CMYK, spot, tint) -- see tools/swatches.ts.

const MAX_LAYERS = 200;
const MAX_STYLE_CHAIN = 16;
const plain = (s: string, max: number) => s.length <= max && !/[\u0000-\u001f\u007f]/.test(s); // eslint-disable-line no-control-regex

/** Parity with core.validateObjectStyleDef. */
export function isValidObjectStyle(state: SceneState, d: PbObjectStyleDef | undefined): d is PbObjectStyleDef {
  if (!d || d.id === "" || !plain(d.name, 80)) return false;
  const seen = new Set<string>();
  for (const p of d.sets) {
    if (!(OBJECT_STYLE_PROPS as readonly string[]).includes(p) || seen.has(p)) return false;
    seen.add(p);
  }
  if (!arePaintsValid(d.fills, d.strokes)) return false;
  if (Number.isNaN(d.opacity) || d.opacity < 0 || d.opacity > 1) return false;
  if (Number.isNaN(d.cornerRadius) || !Number.isFinite(d.cornerRadius) || d.cornerRadius < 0) return false;
  if (d.blendMode < BlendMode.UNSPECIFIED || d.blendMode > 15) return false;
  for (let cur = d.basedOn, hops = 0; cur !== ""; hops++) {
    const b = state.objectStyles[cur];
    if (cur === d.id || !b || hops > MAX_STYLE_CHAIN) return false;
    cur = b.basedOn ?? "";
  }
  return true;
}

/** Parity with core.validateObjectStyleID: not a group or an instance; the style exists (or the id is empty). */
export function isValidObjectStyleId(state: SceneState, n: NodeLite, id: string): boolean {
  if (n.kind === "group" || n.kind === "instance") return false;
  return id === "" || !!state.objectStyles[id];
}

/** Parity with core.validateLayer. */
export function isValidLayer(state: SceneState, l: PbLayer | undefined): l is PbLayer {
  if (!l || l.id === "" || !plain(l.name, 80)) return false;
  return state.layers.some((x) => x.id === l.id) || state.layers.length < MAX_LAYERS;
}

export const isValidLayerId = (state: SceneState, id: string) => id === "" || state.layers.some((l) => l.id === id);

const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

/** Parity with core.validateSwatch: the swatch fields of a variable message. */
export function isValidSwatch(state: SceneState, v: PbVariable): boolean {
  if (!v.swatch && !v.cmyk && v.spotName === "" && v.tintOf === "" && v.tint === 0) return true;
  if (v.type !== VariableType.COLOR) return false;
  if (v.cmyk && ![v.cmyk.c, v.cmyk.m, v.cmyk.y, v.cmyk.k].every(unit)) return false;
  if (!plain(v.spotName, 64)) return false;
  if ((v.tintOf === "") !== (v.tint === 0)) return false;
  if (v.tintOf !== "") {
    const base = state.variables[v.tintOf];
    if (!base || v.tintOf === v.id || !base.swatch || base.type !== "color" || !(v.tint >= 1 && v.tint <= 100)) return false;
  }
  return true;
}

// --- deleting -----------------------------------------------------------------------------------

/** `nodes` with `field` cleared on the nodes that name `id` there (object style or layer deleted). */
export function detachNodes(state: SceneState, field: "objectStyleId" | "layerId", id: string): SceneState["nodes"] {
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  for (const n of state.nodes.values()) {
    if (n[field] !== id) continue;
    const next: NodeLite = { ...n };
    delete next[field];
    (edit ??= state.nodes.edit()).set(n.id, next);
  }
  return edit ? edit.done() : state.nodes;
}

// --- object styles resolve ---------------------------------------------------------------------

/** The style and the ones it is based on, base first. */
export function objectStyleChain(state: Pick<SceneState, "objectStyles">, id: string): ObjectStyleLite[] {
  const chain: ObjectStyleLite[] = [];
  const seen = new Set<string>();
  for (let cur = id; cur && !seen.has(cur) && chain.length <= MAX_STYLE_CHAIN; ) {
    const d = state.objectStyles[cur];
    if (!d) break;
    seen.add(cur);
    chain.unshift(d);
    cur = d.basedOn ?? "";
  }
  return chain;
}

/** `n` drawn with its object style: the properties the style sets replace the node's own (which stay in the document). */
export function resolveObjectStyleNode(state: SceneState, n: NodeLite): NodeLite {
  if (!n.objectStyleId) return n;
  const chain = objectStyleChain(state, n.objectStyleId);
  if (chain.length === 0) return n;
  const out: NodeLite = { ...n };
  for (const d of chain) {
    for (const p of d.sets) {
      switch (p) {
        case "fills": out.fills = (d.fills ?? []).map((f) => ({ ...f })); break;
        case "strokes": out.strokes = (d.strokes ?? []).map((s) => ({ ...s })); break;
        case "effects": if (d.effects && d.effects.length > 0) out.effects = d.effects.map((e) => ({ ...e })); else delete out.effects; break;
        case "opacity": out.opacity = d.opacity ?? 0; break;
        case "blend_mode": if (d.blendMode) out.blendMode = d.blendMode; else delete out.blendMode; break;
        case "corner_radius": if (n.kind === "rect") out.cornerRadius = d.cornerRadius ?? 0; break;
      }
    }
  }
  return out;
}

/** The object style that makes a node look like `n` -- the values of the properties asked for. */
export function styleFromNode(n: NodeLite, props: readonly (typeof OBJECT_STYLE_PROPS)[number][] = OBJECT_STYLE_PROPS): Omit<ObjectStyleLite, "id" | "name"> {
  return {
    sets: [...props],
    ...(props.includes("fills") ? { fills: n.fills.map((f) => ({ ...f })) } : {}),
    ...(props.includes("strokes") ? { strokes: n.strokes.map((s) => ({ ...s })) } : {}),
    ...(props.includes("effects") && n.effects?.length ? { effects: n.effects.map((e) => ({ ...e })) } : {}),
    ...(props.includes("opacity") && n.opacity ? { opacity: n.opacity } : {}),
    ...(props.includes("corner_radius") && n.cornerRadius ? { cornerRadius: n.cornerRadius } : {}),
    ...(props.includes("blend_mode") && n.blendMode ? { blendMode: n.blendMode } : {}),
  };
}

// --- layers derive ------------------------------------------------------------------------------

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with the nodes of hidden layers hidden and those of locked layers marked `locked`; `scene` itself when no layer does either. */
export function deriveLayers(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  const hidden = new Set(scene.layers.filter((l) => l.hidden).map((l) => l.id));
  const locked = new Set(scene.layers.filter((l) => l.locked).map((l) => l.id));
  if (hidden.size === 0 && locked.size === 0) { derived.set(scene, scene); return scene; }
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const n of scene.nodes.values()) {
    if (!n.layerId) continue;
    const hide = hidden.has(n.layerId) && n.visible, lock = locked.has(n.layerId);
    if (!hide && !lock) continue;
    (edit ??= scene.nodes.edit()).set(n.id, { ...n, ...(hide ? { visible: false } : {}), ...(lock ? { locked: true } : {}) });
    changed.push(n.id);
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

// --- colour -------------------------------------------------------------------------------------
// The conversions are those of color/cmyk.ts (percent 0..100, the plain device conversion -- no profile). A swatch
// stores its CMYK as 0..1 channels (proto Cmyk); `swatchCmyk` / `cmykField` go between the two.

export type { Cmyk, Rgb } from "@/color/cmyk";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A percentage (1..100) of a color's ink: the color mixed with white. */
export function tintRgb(c: Rgb, percent: number): Rgb {
  const t = clamp01(percent / 100);
  return { r: 1 - t * (1 - c.r), g: 1 - t * (1 - c.g), b: 1 - t * (1 - c.b) };
}
export function tintCmyk(c: Cmyk, percent: number): Cmyk {
  const t = clamp01(percent / 100);
  return { c: c.c * t, m: c.m * t, y: c.y * t, k: c.k * t };
}

/** What a color becomes when printed in CMYK and shown again: the round trip through the device conversion. */
export function printedRgb(c: Rgb): Rgb {
  return cmykToRgb(rgbToCmyk(c));
}

/** The CMYK of a swatch variable in percent (0..100), or null when it is not defined in CMYK. */
export function swatchCmyk(v: Pick<VariableLite, "cmyk">): Cmyk | null {
  return v.cmyk ? { c: v.cmyk.c * 100, m: v.cmyk.m * 100, y: v.cmyk.y * 100, k: v.cmyk.k * 100 } : null;
}
/** Percent CMYK as the 0..1 channels a swatch stores. */
export const cmykField = (c: Cmyk) => ({ c: c.c / 100, m: c.m / 100, y: c.y / 100, k: c.k / 100 });

export const swatchesOf = (state: Pick<SceneState, "variables">) =>
  Object.values(state.variables).filter((v) => v.swatch === true && v.type === "color").sort((a, b) => a.name.localeCompare(b.name));

/** The color a swatch shows on screen (its first mode's value). */
export function swatchColor(state: Pick<SceneState, "variables" | "collections">, id: string): FillLite | null {
  const v = state.variables[id];
  if (!v || v.type !== "color") return null;
  const col = state.collections[v.collectionId];
  const value = v.values[col?.modes[0]?.id ?? ""] ?? Object.values(v.values)[0];
  return value && typeof value === "object" ? (value as FillLite) : null;
}
