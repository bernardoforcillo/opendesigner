// EFFECT TRACKS: an effect parameter is animated like any property, as a track whose `prop`
// is `fx.<effectId>.<paramId>` (e.g. `fx.ec.blur.gaussian.blurriness`). A node has an effect
// as soon as one of its tracks names it; the parameters without a track keep their default.
// The shape is checked identically in Go (core.ValidFxProp) and here.

const FX_RE = /^fx\.(ec\.[a-z0-9]+\.[a-z0-9]+)\.([A-Za-z0-9]+)$/;

export const fxProp = (effect: string, param: string): string => `fx.${effect}.${param}`;

export function parseFxProp(prop: string): { effect: string; param: string } | null {
  const m = FX_RE.exec(prop);
  return m ? { effect: m[1], param: m[2] } : null;
}

export const isFxProp = (prop: string): boolean => FX_RE.test(prop) || FX_LAYER_RE.test(prop);

// LAYER REFERENCES. An effect that uses a second layer (Set Matte, Blend, Difference Matte...) names it in a track of its own:
// `fx.<effectId>.layer.<nodeId>` (`layer2` for a second one), with a single constant keyframe (value 1, it is never read). The reference is in the prop
// because an effect parameter is only a number and the document has no other place for it without a model change. A reference
// to a node that no longer exists simply makes the effect see an empty layer. Checked identically in Go.
const FX_LAYER_RE = /^fx\.(ec\.[a-z0-9]+\.[a-z0-9]+)\.layer([2-9]?)\.([A-Za-z0-9_-]+)$/;

/** `slot` 1 is the effect's first layer (`layer`), 2 its second (`layer2`, Inner/Outer Key). */
export const fxLayerProp = (effect: string, layerId: string, slot = 1): string => `fx.${effect}.layer${slot > 1 ? slot : ""}.${layerId}`;

/** The key an effect's layer of `slot` has in a node's animFxRefs: the effect id, then `<effect>#2`... */
export const fxRefKey = (effect: string, slot: number): string => (slot > 1 ? `${effect}#${slot}` : effect);

export function parseFxLayerProp(prop: string): { effect: string; layerId: string; slot: number } | null {
  const m = FX_LAYER_RE.exec(prop);
  return m ? { effect: m[1], layerId: m[3], slot: m[2] === "" ? 1 : Number(m[2]) } : null;
}

/** Sampled effect values of one node: effectId -> paramId -> value. */
export type NodeFx = Record<string, Record<string, number>>;
/** Sampled layer references of one node: effectId -> referenced node id. */
export type NodeFxRefs = Record<string, string>;
