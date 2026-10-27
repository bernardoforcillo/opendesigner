import { applyTransform, invertTransform, worldTransformOf } from "@/canvas/transform";
import { inlinePositions } from "@/renderer/text";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { makeSetTextOp } from "@/tools/ops";
import { contentWorldBounds } from "@/store/groups";
import { recordDelta } from "@/store/sceneDelta";
import { derivedMeasureFor } from "@/store/threads";
import { anchorTarget, tokensOf } from "@/store/textTokens";
import { reconcileRich } from "@/store/richText";
import type { NodeLite, SceneState } from "@/store/types";

// ANCHORED OBJECTS. A marker `[@a1b2c3d4]` in the content of a text (the start of an object's id) ties that object to the
// place in the text: the text leaves a box in the line, sized like the object and standing on the baseline, and the
// object is drawn there -- it moves with the text, and with the text's edits and reflow. Like threads and wrap the
// position is DERIVED (resolveScene): the object's own x and y are ignored while it is anchored. The object may be
// any shape, picture, group or frame; it is best on the same page as the text. A threaded story anchors it in the
// frame the marker falls in. See docs/graphics-colour.md.

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with the anchored objects placed where their markers fall in the laid-out text; `scene` itself when there are none. */
export function deriveAnchored(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  const measureFor = derivedMeasureFor();
  for (const n of scene.nodes.values()) {
    if (n.kind !== "text" || !n.text?.rich?.inlines?.length) continue;
    const toWorld = worldTransformOf(scene, n.parentId);
    for (const [id, p] of inlinePositions(measureFor, n)) {
      const target = scene.nodes.get(id);
      if (!target) continue;
      const w = applyTransform(toWorld, p.x, p.y);
      const local = applyTransform(invertTransform(worldTransformOf(scene, target.parentId)), w.x, w.y);
      let x = local.x, y = local.y;
      // A group (or instance) has no box of its own: move it by the distance between where its content is and where it should be.
      if (target.kind === "group" || target.kind === "instance") {
        const b = contentWorldBounds(scene, target);
        if (!b) continue;
        x = target.x + (w.x - b.x);
        y = target.y + (w.y - b.y);
      }
      if (Math.abs(x - target.x) < 1e-6 && Math.abs(y - target.y) < 1e-6) continue;
      (edit ??= scene.nodes.edit()).set(id, { ...target, x, y });
      changed.push(id);
    }
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

// --- editing --------------------------------------------------------------------------------------

/** The short reference to a node used in a marker: the shortest prefix of its id (at least 8 characters) no other node shares. */
export function anchorRef(scene: SceneState, id: string): string {
  for (let len = Math.min(8, id.length); len <= id.length; len++) {
    const ref = id.slice(0, len);
    let clash = false;
    for (const n of scene.nodes.values()) if (n.id !== id && n.id.startsWith(ref)) { clash = true; break; }
    if (!clash) return ref;
  }
  return id;
}

/** The objects anchored in a text (by the markers in its content): the marker and the node it names. */
export function anchorsOf(scene: SceneState, text: NodeLite): { token: string; at: number; end: number; node: NodeLite }[] {
  if (text.kind !== "text" || !text.text) return [];
  return tokensOf(text.text.content).flatMap((t) => {
    if (t.kind !== "anchor") return [];
    const node = anchorTarget(scene, t.text, text.id);
    return node ? [{ token: `[@${t.text}]`, at: t.at, end: t.end, node }] : [];
  });
}

/** Ops that anchor `objectId` in `textId`, at character `at` (default: the end of the text). */
export function anchorOps(scene: SceneState, textId: string, objectId: string, at?: number): Op[] {
  const t = scene.nodes.get(textId), o = scene.nodes.get(objectId);
  if (!t || t.kind !== "text" || !t.text || !o || o.id === t.id) return [];
  const pos = Math.min(Math.max(0, at ?? t.text.content.length), t.text.content.length);
  const marker = `[@${anchorRef(scene, objectId)}]`;
  const next = t.text.content.slice(0, pos) + marker + t.text.content.slice(pos);
  return [makeSetTextOp(t.id, next, undefined, { paragraphStyles: t.text.paragraphStyles ?? [], runs: reconcileRich(scene, t.text, next).runs ?? [] })];
}

/** Ops that take the marker `token` (as `anchorsOf` returns it) out of the text, releasing the object where it stands. */
export function releaseAnchorOps(scene: SceneState, textId: string, at: number, end: number): Op[] {
  const t = scene.nodes.get(textId);
  if (!t || t.kind !== "text" || !t.text) return [];
  const next = t.text.content.slice(0, at) + t.text.content.slice(end);
  const rich = reconcileRich(scene, t.text, next);
  return [makeSetTextOp(t.id, next, undefined, { paragraphStyles: rich.paragraphStyles ?? [], runs: rich.runs ?? [] })];
}

