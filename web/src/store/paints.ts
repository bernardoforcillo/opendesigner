import { ImageScaleMode } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Paint, Stroke } from "../gen/opendesigner/v1/opendesigner_pb";

// Parity with core.validateNodePaints: a mesh paint has a grid of the right size with one color per point; an image paint needs a 64-hex asset hash and a known
// scale mode. (The file itself may arrive later; a missing one draws as a placeholder.)
// The size of a mesh grid: core.MinMeshSide / MaxMeshSide.
export const MIN_MESH_SIDE = 2;
export const MAX_MESH_SIDE = 8;
const HASH = /^[0-9a-f]{64}$/;

export function arePaintsValid(fills: readonly Paint[], strokes: readonly Stroke[]): boolean {
  const ok = (p: Paint | undefined): boolean => {
    if (p?.kind.case === "mesh") {
      const { rows, cols, colors } = p.kind.value;
      return rows >= MIN_MESH_SIDE && cols >= MIN_MESH_SIDE && rows <= MAX_MESH_SIDE && cols <= MAX_MESH_SIDE && colors.length === rows * cols;
    }
    if (p?.kind.case !== "image") return true;
    const { assetHash, mode } = p.kind.value;
    return HASH.test(assetHash) && mode >= ImageScaleMode.UNSPECIFIED && mode <= ImageScaleMode.TILE;
  };
  return fills.every(ok) && strokes.every((s) => ok(s.paint));
}
