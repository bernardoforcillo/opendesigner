import { ImageScaleMode } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Paint, Stroke } from "../gen/opendesigner/v1/opendesigner_pb";

// Parity with core.validateNodePaints: an image paint needs a 64-hex asset hash and a known
// scale mode. (The file itself may arrive later; a missing one draws as a placeholder.)
const HASH = /^[0-9a-f]{64}$/;

export function arePaintsValid(fills: readonly Paint[], strokes: readonly Stroke[]): boolean {
  const ok = (p: Paint | undefined): boolean => {
    if (p?.kind.case !== "image") return true;
    const { assetHash, mode } = p.kind.value;
    return HASH.test(assetHash) && mode >= ImageScaleMode.UNSPECIFIED && mode <= ImageScaleMode.TILE;
  };
  return fills.every(ok) && strokes.every((s) => ok(s.paint));
}
