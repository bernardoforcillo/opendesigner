import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { toPbNode, toPbFlow, toPbClip, toClipLite, toPbTransition, toPbTextStyle, toPbSubPaths, toPbInstanceOverride, type SceneState } from "./types";
import { isValidClip } from "../animation/validate";
import { childrenOf, isAncestorOf, parentExists, subtreeOf } from "./tree";

// Undo primitives: given the state BEFORE an op, the op that undoes it.
//
// Undo in opendesigner is not a rewind of the op-log: it is more forward work
// (the inverse is submitted like any other op). So the inverse is a real
// Op, with:
//  - a NEW opId (the server deduplicates by opId: reusing that of the
//    direct op would make it be discarded as a replay);
//  - the docId of the direct op, not that of the "current" document -- the op
//    I am inverting may have arrived from the wire.
function newOpId(): string {
  // Same generator as tools/ops.ts::uuid, but called directly: history
  // sits under store/ and store.ts will import invertOp (Task 12), while ops.ts
  // imports store.ts. Going through ops.ts would close a module cycle.
  return crypto.randomUUID();
}

function createNodeOp(docId: string, node: PbNode): Op {
  return create(OpSchema, { opId: newOpId(), docId, kind: { case: "createNode", value: { node } } });
}

// invertOp must be called BEFORE op is applied: the inverse is made of the
// values the op is about to overwrite (or of the node about to disappear), and
// after the apply that state no longer exists.
// Returns null when an inverse does not exist: ops that applyOp -- and before it
// core.Apply (Go), which is the authority -- would discard anyway (nonexistent id,
// createNode without a node or on an id already taken, unknown kind). In those cases
// the direct op does not change the scene, so "no inverse" is correct, not a
// loss.
//
// Returns a LIST to apply IN ORDER, never empty (it is null in that case).
// Almost always it has one element, but it cannot be by construction: a `deleteNode`
// deletes the whole subtree (core.applyDelete) and the inverse op of a
// creation is ONE createNode per node -- the proto has no op that creates
// many, and must not have one: they are independent ops, each with its own
// invariants. The order is the one that RE-SATISFIES the parent invariant
// (parent before children): the other way round, every child would be rejected with
// ErrParentNotFound.
export function invertOp(scene: SceneState, op: Op): Op[] | null {
  switch (op.kind.case) {
    case "createNode": {
      const node = op.kind.value.node;
      if (!node || node.id === "") return null;
      // Nonexistent parent: core.applyCreate replies ErrParentNotFound and
      // applyOp mirrors it. The direct op changes nothing, so there is
      // nothing to undo -- and a deleteNode invented here would go over the
      // wire to delete a node the server never created.
      if (!parentExists(scene, node.parentId)) return null;
      // Id already present: core.applyCreate (Go) replies ErrNodeExists and applyOp
      // does the same: the direct op is REJECTED, the scene does not change, so
      // there is nothing to undo. Inventing an inverse here (a delete, or the
      // re-creation of the previous node) would send the server the undo of an op
      // the server never accepted -- that is, a real divergence.
      if (scene.nodes.at(node.id)) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "deleteNode", value: { id: node.id } },
      })];
    }
    // The inverse of a delete is the re-creation of the WHOLE subtree that the
    // delete takes away (core.applyDelete cascade): the node and every descendant,
    // one createNode each.
    //
    // The ORDER is the part that matters: subtreeOf visits in pre-order, so
    // every node arrives AFTER its own parent and every createNode finds its
    // container already re-created. In the opposite order the first re-creation of a
    // child would be rejected with ErrParentNotFound, and the undo would leave the
    // scene half done -- worse than an undo that cannot be done.
    case "deleteNode": {
      const sub = subtreeOf(scene, op.kind.value.id);
      if (sub.length === 0) return null;
      return [
        ...sub.map((n) => createNodeOp(op.docId, toPbNode(n))),
        ...restoreFlowsOps(scene, op.docId, new Set(sub.map((n) => n.id))),
        ...restoreClipsOps(scene, op.docId, new Set(sub.map((n) => n.id))),
      ];
    }
    // Symmetric to itself: puts the node back where it was, with the order key it
    // had among its old peers. Null when the direct op would be rejected --
    // nonexistent node or parent, cycle -- because in that case the scene does not
    // change and there is nothing to undo (see applyOp: reparentNode).
    case "reparentNode": {
      const { id, newParentId } = op.kind.value;
      const prev = scene.nodes.at(id);
      if (!prev) return null;
      if (!parentExists(scene, newParentId)) return null;
      if (newParentId === id || isAncestorOf(scene, id, newParentId)) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "reparentNode", value: { id, newParentId: prev.parentId, orderKey: prev.orderKey } },
      })];
    }
    case "setProps": {
      // The direct op's patch is not needed: the inverse is made of the
      // PREVIOUS values. And note, an op WITHOUT a patch is not a no-op — Go
      // reads it with nil-safe getters and zeroes the fields in the mask (applyOp does
      // the same, see NIL_PATCH), so it has an inverse like all the
      // others: putting those fields back.
      const { id, mask } = op.kind.value;
      const prev = scene.nodes.at(id);
      if (!prev) return null;
      // Patch = the node as it was, mask = the SAME as the direct op. The mask is the
      // contract -- TS and Go read only the listed paths and ignore the rest
      // of the patch -- so copying the path table here again would duplicate (and
      // sooner or later make diverge) applyOp. Bonus: if the mask contains an
      // unsupported path, the direct op is rejected as a whole and the inverse
      // too, so the round-trip remains the identity in that case as well.
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: {
          case: "setProps",
          value: { id, patch: toPbNode(prev), mask: { paths: [...(mask?.paths ?? [])] } },
        },
      })];
    }
    case "setText": {
      // Same shape as the inverse of setProps: the PREVIOUS values, not the
      // payload of the direct op. Null when the direct op would be rejected --
      // nonexistent id or non-text node (ErrNotTextNode in Go): the scene would not
      // change, so there is nothing to undo.
      const { id } = op.kind.value;
      const prev = scene.nodes.at(id);
      if (!prev || prev.kind !== "text" || !prev.text) return null;
      // stylePresent ALWAYS true, even when the direct op did not touch the
      // style: putting back the previous style is a no-op in that case, while
      // omitting it would leave the NEW style standing after the undo of an op that
      // had changed it. A single branch, always exact.
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: {
          case: "setText",
          value: {
            id,
            content: prev.text.content,
            style: toPbTextStyle(prev.text.style),
            stylePresent: true,
          },
        },
      })];
    }
    // --- pages --------------------------------------------------------------
    // Pages are the ROOT containers (a parentId can be the id of a node
    // or that of a Page). Their inverse mirrors that of nodes: a
    // createPage is undone with a deletePage, a renamePage by putting back the
    // previous name, a deletePage -- which like deleteNode takes away a whole subtree
    // in a CASCADE (see applyOp) -- by re-creating first the page and then
    // every node that hung under it, parent before children.
    //
    // The null rule remains that of nodes: null is returned EXACTLY
    // when the direct op would be rejected (parity with applyOp and core), because
    // in that case the scene does not change and there is nothing to undo -- and an
    // invented inverse would send the server the undo of an op never accepted.
    case "createPage": {
      const page = op.kind.value.page;
      // Page absent or without id (ErrNilPage), or id ALREADY TAKEN -- by another
      // page or by a NODE: parentExists answers "yes" for both, and the
      // collision with a node counts as much as that with a page (ErrPageExists).
      if (!page || page.id === "" || parentExists(scene, page.id)) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "deletePage", value: { id: page.id } },
      })];
    }
    case "deletePage": {
      const { id } = op.kind.value;
      const page = scene.pages.find((p) => p.id === id);
      // Nonexistent page (ErrPageNotFound) or LAST page (ErrLastPage): in
      // both cases applyOp leaves the scene unchanged.
      if (!page || scene.pages.length === 1) return null;
      // First the page, then every node the cascade is about to take away. I use
      // the PRE-apply `scene` that invertOp receives to enumerate those nodes with the
      // SAME visit as applyDeletePage (childrenOf for the page roots,
      // subtreeOf in pre-order for each): every createNode thus finds its
      // own container -- the just re-created page or a previously re-created node
      // -- already existing. In the opposite order the first re-creation of a root
      // would be rejected with ErrParentNotFound and the undo would leave the scene
      // half done, worse than an undo that cannot be done.
      const ops: Op[] = [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "createPage", value: { page: { id: page.id, name: page.name } } },
      })];
      const gone = new Set<string>();
      for (const root of childrenOf(scene, id)) {
        for (const n of subtreeOf(scene, root.id)) { ops.push(createNodeOp(op.docId, toPbNode(n))); gone.add(n.id); }
      }
      ops.push(...restoreFlowsOps(scene, op.docId, gone));
      ops.push(...restoreClipsOps(scene, op.docId, gone));
      return ops;
    }
    case "renamePage": {
      const { id } = op.kind.value;
      const page = scene.pages.find((p) => p.id === id);
      // Nonexistent page: ErrPageNotFound, applyOp no-op.
      if (!page) return null;
      // The PREVIOUS name (read from the pre-apply scene), not that of the direct
      // op: symmetric to itself. ALWAYS written, even empty, like
      // applyOp -- the fallback for an empty name belongs to the UI, not the model.
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "renamePage", value: { id, name: page.name } },
      })];
    }
    case "setVectorPath": {
      // Same shape as the inverse of setText: the PREVIOUS subpaths in full,
      // not the payload of the direct op. It is all that is needed precisely because
      // SetVectorPath replaces wholesale -- if the op were incremental
      // ("move the i-th anchor") the inverse would have to reconstruct which
      // piece was touched, and every extra case would be one more case to
      // keep identical between Go and TS.
      //
      // Without this branch editing a path would produce NO undo entry
      // (invertOp null => the gesture does not enter the stack), which for a
      // track whose point is editable geometry would be the worst possible
      // defect.
      const { id } = op.kind.value;
      const prev = scene.nodes.at(id);
      // Null when the direct op would be rejected -- nonexistent id or non-
      // vector node (ErrNotVectorNode in Go): the scene would not change, so
      // there is nothing to undo.
      if (!prev || prev.kind !== "vector" || !prev.vector) return null;
      // An empty list is a legitimate inverse like any other: undoing the
      // fill of a previously empty path puts it back empty. A list of ONE
      // element and not a bare Op: invertOp returns Op[] since the inverse of
      // a delete is a cascade (T1) -- flattening here to a bare Op would break
      // the type and whoever consumes it (invertChain).
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "setVectorPath", value: { id, subpaths: toPbSubPaths(prev.vector.subpaths) } },
      })];
    }
    // --- components / instances (M4) ----------------------------------------
    case "createComponent":
      // NOT undoable in M4 (minimum): the proto has no DeleteComponent op,
      // so there is no inverse to return. Returns null -- like an op
      // that does not change the scene -- until a future track adds
      // the deletion of a component. (Registering a component does not touch
      // `nodes`: the master was already there, so the undo of its create remains
      // that of the node, not of the component.)
      return null;
    case "setInstanceOverride": {
      const { instanceId, override } = op.kind.value;
      const prev = scene.nodes.at(instanceId);
      // Null when the direct op would be rejected (parity with applyOp/core):
      // nonexistent node, non-instance, or empty master_node_id -- the scene does not
      // change, so there is nothing to undo.
      if (!prev || prev.kind !== "instance" || !prev.instance) return null;
      if (!override || override.masterNodeId === "") return null;
      // The inverse RE-SETS the PREVIOUS override for that master_node_id, read
      // from the pre-apply scene: if there was one, the undo puts it back (the
      // *_present flags are derived from the presence of the Lite fields, see
      // toPbInstanceOverride, and it is LOSSLESS); if there was none, the inverse is a
      // REMOVAL -- a SetInstanceOverride with no *_present, which removes
      // exactly what the direct op had added. In both cases the
      // master_node_id stays that of the direct op (already verified non-empty),
      // so the inverse is not itself rejected.
      const existing = prev.instance.overrides.find((o) => o.masterNodeId === override.masterNodeId);
      const invOverride = existing
        ? toPbInstanceOverride(existing)
        : { masterNodeId: override.masterNodeId };
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "setInstanceOverride", value: { instanceId, override: invOverride } },
      })];
    }
    // --- flows --------------------------------------------------------------
    // Absolute upserts: the inverse is the PREVIOUS state (a setFlow/setTransition
    // with the old value if it existed, a delete if the direct op created).
    // Null when the direct op would be rejected (parity with applyOp/core).
    case "setFlow": {
      const f = op.kind.value.flow;
      if (!f || f.id === "") return null;
      if (f.startId !== "" && !scene.nodes.has(f.startId)) return null;
      const prev = scene.flows[f.id];
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: prev
          ? { case: "setFlow", value: { flow: toPbFlow(prev) } }
          : { case: "deleteFlow", value: { id: f.id } },
      })];
    }
    case "deleteFlow": {
      const { id } = op.kind.value;
      const prev = scene.flows[id];
      if (!prev) return null;
      // First the flow, then its transitions (they require the flow to exist).
      return [
        create(OpSchema, { opId: newOpId(), docId: op.docId, kind: { case: "setFlow", value: { flow: toPbFlow(prev) } } }),
        ...Object.values(scene.transitions).filter((t) => t.flowId === id).sort(byId).map((t) =>
          create(OpSchema, { opId: newOpId(), docId: op.docId, kind: { case: "setTransition", value: { transition: toPbTransition(t) } } })),
      ];
    }
    case "setTransition": {
      const t = op.kind.value.transition;
      if (!t || t.id === "") return null;
      if (!scene.flows[t.flowId]) return null;
      if (!scene.nodes.has(t.fromId) || !scene.nodes.has(t.toId)) return null;
      if (t.elementId !== "" && !scene.nodes.has(t.elementId)) return null;
      const prev = scene.transitions[t.id];
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: prev
          ? { case: "setTransition", value: { transition: toPbTransition(prev) } }
          : { case: "deleteTransition", value: { id: t.id } },
      })];
    }
    case "deleteTransition": {
      const prev = scene.transitions[op.kind.value.id];
      if (!prev) return null;
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: { case: "setTransition", value: { transition: toPbTransition(prev) } },
      })];
    }
    // --- animation ----------------------------------------------------------
    // Absolute upserts, like flows: the inverse is the PREVIOUS clip (or a
    // delete if the op created it). Null when the direct op would be rejected.
    case "setClip": {
      const c = op.kind.value.clip;
      if (!c || c.id === "") return null;
      if (!isValidClip(scene, toClipLite(c))) return null;
      const prev = scene.clips[c.id];
      return [create(OpSchema, {
        opId: newOpId(), docId: op.docId,
        kind: prev
          ? { case: "setClip", value: { clip: toPbClip(prev) } }
          : { case: "deleteClip", value: { id: c.id } },
      })];
    }
    case "deleteClip": {
      const prev = scene.clips[op.kind.value.id];
      if (!prev) return null;
      return [create(OpSchema, { opId: newOpId(), docId: op.docId, kind: { case: "setClip", value: { clip: toPbClip(prev) } } })];
    }
    default:
      return null;
  }
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// After RE-CREATING the deleted nodes, puts back what the cascade had taken from
// the flows: the `startId` of the flows that started from them and the transitions that
// crossed them (or that used them as hotspot). They go AFTER the createNodes: the
// references must exist (parity with core.applySetFlow/applySetTransition).
function restoreFlowsOps(scene: SceneState, docId: string, gone: ReadonlySet<string>): Op[] {
  const ops: Op[] = [];
  for (const f of Object.values(scene.flows).sort(byId)) {
    if (f.startId !== "" && gone.has(f.startId)) {
      ops.push(create(OpSchema, { opId: newOpId(), docId, kind: { case: "setFlow", value: { flow: toPbFlow(f) } } }));
    }
  }
  for (const t of Object.values(scene.transitions).sort(byId)) {
    if (gone.has(t.fromId) || gone.has(t.toId) || (t.elementId !== "" && gone.has(t.elementId))) {
      ops.push(create(OpSchema, { opId: newOpId(), docId, kind: { case: "setTransition", value: { transition: toPbTransition(t) } } }));
    }
  }
  return ops;
}

// After RE-CREATING the deleted nodes, puts back the clips the cascade had
// touched (core.cascadeClips): those whose target vanished (deleted) and those
// that had tracks on the vanished nodes (the tracks had been removed). The
// WHOLE clip is restored as it was in the pre-apply scene -- an absolute setClip --
// and it goes AFTER the createNodes: targets and track nodes must exist.
function restoreClipsOps(scene: SceneState, docId: string, gone: ReadonlySet<string>): Op[] {
  const ops: Op[] = [];
  for (const c of Object.values(scene.clips).sort(byId)) {
    if (gone.has(c.targetId) || c.tracks.some((t) => gone.has(t.nodeId))) {
      ops.push(create(OpSchema, { opId: newOpId(), docId, kind: { case: "setClip", value: { clip: toPbClip(c) } } }));
    }
  }
  return ops;
}
