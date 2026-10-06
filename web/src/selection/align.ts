import { type Bounds, unionBounds, worldAabbOfNode } from "../canvas/geometry";
import { useScene } from "../store/store";
import { makeSetPropsOp } from "../tools/ops";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// ALIGNMENT AND DISTRIBUTION.
//
// Six alignments (the three horizontal edges, the three vertical ones) and two
// distributions. They all just move nodes: the mask is always ["x", "y"], never
// width/height/rotation -- aligning neither resizes nor rotates.
//
// ROTATED NODES: their AXIS-ALIGNED RECTANGLE (worldAabbOfNode) is aligned,
// the same choice as snap (see selection/snap.ts) and for the same reason:
// it is the rectangle the selection box draws and the one the eye
// reads as "the place it occupies". The delta computed on the AABB is however written
// directly into the MODEL's x/y, and it is exact: a translation commutes with
// rotation around the center, so moving the AABB by (dx, dy) is moving the
// node by (dx, dy).
//
// THE STROKE does not count, again as for snap: the geometry is aligned, not
// the protrusion of the edge.

export type AlignKind = "left" | "hcenter" | "right" | "top" | "middle" | "bottom";
export type DistributeKind = "distribute-h" | "distribute-v";
export type AlignCommand = AlignKind | DistributeKind;

// The commands as DATA, with the label the panel shows: adding one
// is adding a row here, and the panel has no parallel list
// to keep aligned. The order is the one in which the buttons appear.
export const ALIGN_COMMANDS: readonly { id: AlignCommand; label: string }[] = [
  { id: "left", label: "Align left" },
  { id: "hcenter", label: "Center horizontally" },
  { id: "right", label: "Align right" },
  { id: "distribute-h", label: "Distribute horizontally" },
  { id: "top", label: "Align top" },
  { id: "middle", label: "Center vertically" },
  { id: "bottom", label: "Align bottom" },
  { id: "distribute-v", label: "Distribute vertically" },
];

export interface Delta { dx: number; dy: number }

const ZERO: Delta = { dx: 0, dy: 0 };

// The displacement that brings `b` to the requested alignment relative to `target`.
// ONE axis per command, always: "align left" must never move anything
// vertically.
export function alignDelta(b: Bounds, target: Bounds, kind: AlignKind): Delta {
  switch (kind) {
    case "left":
      return { dx: target.x - b.x, dy: 0 };
    case "hcenter":
      return { dx: target.x + target.width / 2 - (b.x + b.width / 2), dy: 0 };
    case "right":
      return { dx: target.x + target.width - (b.x + b.width), dy: 0 };
    case "top":
      return { dx: 0, dy: target.y - b.y };
    case "middle":
      return { dx: 0, dy: target.y + target.height / 2 - (b.y + b.height / 2) };
    case "bottom":
      return { dx: 0, dy: target.y + target.height - (b.y + b.height) };
  }
}

// DISTRIBUTION: the SPACES BETWEEN the boxes are equalized, not their centers.
//
// The difference shows as soon as the boxes have different sizes: equidistant
// centers leave visibly unequal gaps between a wide box and a narrow one,
// while equal spaces is what the eye reads as "distributed". It is
// also the choice of design editors (Figma calls it "distribute
// spacing").
//
// The two EXTREMES do not move: they define the space to be shared out.
// Fewer than three boxes have nothing to distribute (the two extremes are already
// everything), and the function returns the identity instead of inventing a
// movement.
//
// The free space may turn out NEGATIVE if the boxes overlap: the formula
// holds anyway and produces equal overlaps, which is the right answer
// to the question "make them equidistant".
export function distributeDeltas(boxes: readonly Bounds[], axis: "x" | "y"): Delta[] {
  const out: Delta[] = boxes.map(() => ZERO);
  const n = boxes.length;
  if (n < 3) return out;
  const horiz = axis === "x";
  const min = (b: Bounds) => (horiz ? b.x : b.y);
  const size = (b: Bounds) => (horiz ? b.width : b.height);
  // Sorted by position, with the INDEX as tie-break: two boxes that start
  // exactly at the same point must get a stable order, otherwise
  // the same command given twice would give different results.
  const order = boxes.map((_, i) => i).sort((a, b) => min(boxes[a]) - min(boxes[b]) || a - b);
  const first = boxes[order[0]];
  const last = boxes[order[n - 1]];
  const start = min(first);
  const end = min(last) + size(last);
  let total = 0;
  for (const b of boxes) total += size(b);
  const gap = (end - start - total) / (n - 1);
  let cursor = start;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    // The TWO EXTREMES do not move: it is the DEFINITION of distribution (they
    // delimit the space to be shared out), not the result of a computation --
    // and therefore their zero must be IMPOSED, not hoped for.
    //
    // Hoping does not work: `cursor` accumulates (size + gap) in floating point and
    // on arbitrary coordinates reaches the last box at min(last) minus a hair
    // (with boxes at 969.9 / 309.3 / 456.6 the delta is -1.1e-13). A delta of 1e-13
    // is not zero, so alignOps -- which compares with EXACT zero, and must:
    // an epsilon there would be an arbitrary threshold on a quantity nobody
    // perceives -- sends it an op. An invisible displacement travels on the wire, an
    // entry that undoes nothing ends up in the undo stack, and the case
    // does not converge: redistributing again produces the SAME delta, forever.
    //
    // The first extreme would come out zero on its own (cursor starts exactly there);
    // it is excluded here because the reason is the same and applies to both.
    if (k > 0 && k < n - 1) {
      const d = cursor - min(boxes[i]);
      out[i] = horiz ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    }
    cursor += size(boxes[i]) + gap;
  }
  return out;
}

// The rectangle to align against: ALWAYS the common box of the
// selection (the union of the AABBs), i.e. the same box the overlay
// draws. null only for an empty selection.
//
// A SINGLE NODE does not move, and that is intended: its common box is itself,
// so all six alignments are the identity and alignOps produces
// no op. It is Figma's behavior for a single object on the canvas.
//
// There is NO page to align it against. `opendesigner.v1.Page` today carries only
// `id` and `name`: the model has no page geometry (and it is the job
// of track 1, which owns pages and frames). Inventing one -- a
// 1920x1080 sheet at the origin -- would not be a harmless convention but a
// TELEPORTATION: the canvas is infinite and a document can legitimately
// live at x = 10000, where "align left" on a single rectangle would
// send it to x = 0, off screen, with no sign that it moved
// instead of vanishing (and the camera starts at {0, 0, zoom: 1}, so not even
// "the area framed on opening" would be that sheet). When
// track 1 gives real bounds to pages and frames, the reference of a single node
// will become its CONTAINER -- a READ from the document, not a number
// written here.
export function alignTarget(scene: SceneState, ids: readonly string[]): Bounds | null {
  const boxes = boxesOf(scene, ids);
  if (boxes.length === 0) return null;
  return unionBounds(boxes.map((b) => b.box));
}

// How many nodes the command needs to be able to do something: TWO to align
// (the reference is the common box, and with a single node that box is the
// node itself), THREE to distribute (the two extremes do not move, so below
// three there is nothing in the middle to share out).
//
// The panel disables the buttons with it: a command that will do nothing must
// SAY SO beforehand, because a silent no-op is indistinguishable from a broken command.
export function minSelection(cmd: AlignCommand): number {
  return isDistribute(cmd) ? 3 : 2;
}

function boxesOf(scene: SceneState, ids: readonly string[]): { id: string; box: Bounds }[] {
  const out: { id: string; box: Bounds }[] = [];
  for (const id of ids) {
    const n = scene.nodes.at(id);
    if (n) out.push({ id, box: worldAabbOfNode(n) });
  }
  return out;
}

function isDistribute(cmd: AlignCommand): cmd is DistributeKind {
  return cmd === "distribute-h" || cmd === "distribute-v";
}

// The ops of an align command: one per node that REALLY moves.
//
// Nodes already in place produce no op, and it is not an optimization: a
// setProps rewriting the very same values would travel on the wire, and its
// inverse would end up in the undo entry -- a Ctrl+Z that "undoes" moves
// that never happened. If nobody moves the list is empty and alignSelection does not
// even open the gesture.
export function alignOps(scene: SceneState, ids: readonly string[], cmd: AlignCommand): Op[] {
  const boxes = boxesOf(scene, ids);
  if (boxes.length === 0) return [];
  const deltas = isDistribute(cmd)
    ? distributeDeltas(boxes.map((b) => b.box), cmd === "distribute-h" ? "x" : "y")
    : (() => {
        const target = alignTarget(scene, ids);
        return target ? boxes.map((b) => alignDelta(b.box, target, cmd)) : boxes.map(() => ZERO);
      })();
  const ops: Op[] = [];
  boxes.forEach(({ id }, i) => {
    const { dx, dy } = deltas[i];
    if (dx === 0 && dy === 0) return;
    const n = scene.nodes.at(id);
    // x and y travel ALWAYS together, even when one of the two deltas is zero: the
    // mask is the same for all commands, so the previews of different
    // gestures coalesce on the same key (see store.ts::previewKey)
    // and the final op is comparable with that of a drag.
    ops.push(makeSetPropsOp(id, { x: n.x + dx, y: n.y + dy }, ["x", "y"]));
  });
  return ops;
}

// THE COMMAND: a single gesture, however many nodes are moved -- hence a single
// undo entry and a single reconciliation round, exactly like a
// drag that moves ten nodes.
export function alignSelection(cmd: AlignCommand): void {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene) return;
  const ops = alignOps(scene, store.selection, cmd);
  if (ops.length === 0) return;
  store.beginGesture();
  store.endGesture(ops);
}
