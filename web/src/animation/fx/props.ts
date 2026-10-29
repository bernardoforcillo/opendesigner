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

export const isFxProp = (prop: string): boolean => FX_RE.test(prop);

/** Sampled effect values of one node: effectId -> paramId -> value. */
export type NodeFx = Record<string, Record<string, number>>;
