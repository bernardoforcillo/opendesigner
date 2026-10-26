import type { NodeLite, StrokeLite } from "@/store/types";

// PER-SIDE STROKE WEIGHTS (docs/shapes.md): a rectangle or frame stroke with its own weight on each side is
// the band between an outer and an inner rectangle (filled even-odd with the stroke's paint). Where the band
// sits depends on the alignment: INSIDE keeps the outer one on the box, OUTSIDE the inner one, CENTER
// straddles the edge. Shared by the 2D canvas, the GPU renderer and the SVG export.

interface Rect { x: number; y: number; width: number; height: number }

export function sideBandRects(n: Pick<NodeLite, "x" | "y" | "width" | "height">, s: Pick<StrokeLite, "align" | "sides">): { outer: Rect; inner: Rect } {
  const { top, right, bottom, left } = s.sides ?? { top: 0, right: 0, bottom: 0, left: 0 };
  // How much of each side's weight lies outside the box edge.
  const out = s.align === "outside" ? 1 : s.align === "center" ? 0.5 : 0;
  const grow = (t: number, r: number, b: number, l: number): Rect => ({
    x: n.x - l, y: n.y - t, width: n.width + l + r, height: n.height + t + b,
  });
  const outer = grow(top * out, right * out, bottom * out, left * out);
  const inner = grow(-top * (1 - out), -right * (1 - out), -bottom * (1 - out), -left * (1 - out));
  // A side wider than the box would invert the inner rectangle: collapse it.
  inner.width = Math.max(0, inner.width);
  inner.height = Math.max(0, inner.height);
  return { outer, inner };
}
