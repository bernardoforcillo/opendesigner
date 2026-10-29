// APPLYING THE EFFECTS OF A POSED NODE: from `node.animFx` (effectId -> paramId -> value,
// written by animation/pose.ts) to what CanvasKit needs. PURE of the renderer: it only builds
// CanvasKit objects, handing each one to `track` so the caller frees them with the frame.

import type { CanvasKit, ImageFilter } from "canvaskit-wasm";
import { fxDef, resolveFx, resolveStrings, type FxKernel, type FxOverlay, type FxTextSpec } from "@/animation/fx/library";

type AnimFx = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** How far beyond the node's box the effects paint (the layer must be at least this large). */
export function fxOutset(animFx: AnimFx | undefined): number {
  if (!animFx) return 0;
  let out = 0;
  for (const [id, given] of Object.entries(animFx)) {
    const def = fxDef(id);
    if (def?.outset) out += def.outset(resolveFx(def, given));
  }
  return out;
}

export interface BuiltFx {
  /** The chain of the effects' image filters, in track order, or null. */
  filter: ImageFilter | null;
  /** The shader effects, in track order, each with its resolved uniforms. */
  overlays: { overlay: FxOverlay; values: Record<string, number>; effect: string }[];
  /** The effects that read the node's pixels, in track order (drawn offscreen first). */
  kernels: FxKernel[];
  /** The effects that draw text over the node, in track order (animation/fx/props.ts has their strings). */
  texts: { spec: FxTextSpec; effect: string }[];
}

export function buildFx(
  CK: CanvasKit, animFx: AnimFx | undefined, track: (o: { delete(): void }) => void,
  animText?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): BuiltFx | null {
  if (!animFx) return null;
  let filter: ImageFilter | null = null;
  const overlays: BuiltFx["overlays"] = [];
  const kernels: FxKernel[] = [];
  const texts: BuiltFx["texts"] = [];
  for (const [id, given] of Object.entries(animFx)) {
    const def = fxDef(id);
    if (!def) continue;
    const values = resolveFx(def, given);
    if (def.filter) filter = def.filter(CK, values, filter, track);
    if (def.overlay) overlays.push({ overlay: def.overlay(values), values, effect: id });
    if (def.kernel) kernels.push({ ...def.kernel(values), effect: id });
    if (def.text) texts.push({ spec: def.text(values, resolveStrings(def, animText?.[id])), effect: id });
  }
  return filter || overlays.length > 0 || kernels.length > 0 || texts.length > 0 ? { filter, overlays, kernels, texts } : null;
}
