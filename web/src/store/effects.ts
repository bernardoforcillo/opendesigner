import type { Effect as PbEffect } from "@/gen/opendesigner/v1/opendesigner_pb";

// EFFECT VALUES -- the TypeScript twin of internal/core/effects.go. Go is the authority;
// each rule repeats one there (see the list at the top of that file).

const MAX_RADIUS = 10000;
const unit = (v: number) => v >= 0 && v <= 1; // false for NaN
const radiusOk = (v: number) => v >= 0 && v <= MAX_RADIUS;
const finiteNonNeg = (v: number) => Number.isFinite(v) && v >= 0;

/** Parity with core.validateEffects: false when any progressive blur, noise, texture or glass is out of range. */
export function areValidEffects(effects: readonly PbEffect[]): boolean {
  for (const e of effects) {
    const k = e.kind;
    switch (k.case) {
      case "progressiveBlur": {
        const p = k.value;
        if (!radiusOk(p.startRadius) || !radiusOk(p.endRadius)) return false;
        if (![p.x1, p.y1, p.x2, p.y2].every(Number.isFinite)) return false;
        break;
      }
      case "noise": {
        const n = k.value;
        if (!(n.mode >= 0 && n.mode <= 3) || !finiteNonNeg(n.size) || !unit(n.density) || !unit(n.opacity)) return false;
        break;
      }
      case "texture":
        if (!finiteNonNeg(k.value.scale) || !unit(k.value.intensity)) return false;
        break;
      case "glass": {
        const g = k.value;
        if (!radiusOk(g.frost) || !unit(g.light) || !unit(g.noise) || !Number.isFinite(g.lightAngle)) return false;
        break;
      }
    }
  }
  return true;
}
