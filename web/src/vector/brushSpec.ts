import type { BrushLite, BrushTipLite, StrokeLite } from "../store/types";

// The DATA half of brushes (docs/vector.md): the built-in presets and how far a brush reaches. Free of
// geometry, so canvas/geometry.ts can import it without a cycle. The sampling and drawing live in
// vector/brush.ts.

/** The presets of the Brush panel; the same names and numbers as internal/mcp/brush.go. */
export const BRUSH_PRESETS: Readonly<Record<string, BrushLite>> = {
  chalk: { kind: "scatter", tip: "dot", spacing: 0.15, scatter: 0.6, sizeJitter: 0.5, angleJitter: 0, seed: 1 },
  marker: { kind: "stretch", tip: "dash", spacing: 0.6, scatter: 0, sizeJitter: 0.2, angleJitter: 0, seed: 2 },
  dots: { kind: "scatter", tip: "dot", spacing: 2, scatter: 0, sizeJitter: 0, angleJitter: 0, seed: 3 },
  leaves: { kind: "scatter", tip: "leaf", spacing: 1.5, scatter: 0.8, sizeJitter: 0.4, angleJitter: 60, seed: 4 },
};

export const BRUSH_TIPS: readonly BrushTipLite[] = ["dot", "dash", "square", "diamond", "leaf"];

/** The name of the preset a brush equals, "custom" for any other, "none" for no brush. */
export function brushPresetName(b: BrushLite | undefined): string {
  if (!b) return "none";
  for (const [name, p] of Object.entries(BRUSH_PRESETS)) {
    if (p.kind === b.kind && p.tip === b.tip && p.spacing === b.spacing && p.scatter === b.scatter && p.sizeJitter === b.sizeJitter
      && p.angleJitter === b.angleJitter && p.seed === b.seed) return name;
  }
  return "custom";
}

/** True if the stroke is drawn as a brush (a brush only has an effect with a positive weight). */
export function hasBrush(s: Pick<StrokeLite, "weight" | "brush">): boolean {
  return s.weight > 0 && !!s.brush;
}

/** True if any stroke of a vector is brushed. */
export function hasBrushedStroke(n: { kind: string; strokes: readonly Pick<StrokeLite, "weight" | "brush">[] }): boolean {
  return n.kind === "vector" && n.strokes.some(hasBrush);
}

/**
 * How far a brushed stroke reaches from the path: the farthest a stamp can stray across it plus the
 * farthest a (rotated, enlarged) tip reaches from its own centre. Generous on purpose: it is the bounds
 * overhang, and a mark cut off by the bounds is worse than a box a little too large.
 */
export function brushReach(b: BrushLite, weight: number): number {
  const grow = 1 + b.sizeJitter / 2;
  // A stretch tile is `spacing` long and one wide; a scatter tip is one square. Half the diagonal bounds both
  // whatever its turn.
  const length = b.kind === "stretch" ? b.spacing : 1;
  const half = Math.hypot(length, 1) / 2 * grow;
  return weight * (b.scatter / 2 + half);
}
