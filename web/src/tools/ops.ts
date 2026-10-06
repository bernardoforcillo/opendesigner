import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { toPbClip, toPbCollection, toPbVariable, toPbFlow, toPbInstanceOverride, toPbSubPaths, toPbTextStyle, toPbTransition } from "../store/types";
import type { ClipLite, CollectionLite, VariableLite, FlowLite, InstanceOverrideLite, SubPathLite, TextStyleLite, TransitionLite } from "../store/types";
import type { MaskPath } from "../store/maskPaths";

// Centralized construction of Ops: every tool goes through here, so opId and docId
// are stamped in a single place (in M0 the logic was duplicated inside
// rectTool). docId comes from the document open in the store.

export function uuid(): string {
  return crypto.randomUUID();
}

function docId(): string {
  return useScene.getState().scene?.id ?? "";
}

export function makeCreateNodeOp(node: Node): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "createNode", value: { node } } });
}

// patch contains ONLY the fields listed in paths: the mask is what the reducer
// (TS and Go) uses to decide what to apply, the rest of the patch is ignored.
//
// paths is typed MaskPath[] (not string[]) on purpose: a path that Go does not
// support (store/maskPaths.ts is the single source of truth, it mirrors the
// switch of core.applySetProps) thus becomes a compile error HERE,
// at the construction point, instead of a rejection discovered only by really
// submitting the op -- or worse, a runtime throw during serialization if
// the path is written in the wrong camelCase convention (FieldMask on the JSON
// wire rewrites the path and is not forgiving about casing, see maskPaths.ts).
export function makeSetPropsOp(
  id: string,
  patch: MessageInitShape<typeof NodeSchema>,
  paths: MaskPath[],
): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "setProps", value: { id, patch: create(NodeSchema, patch), mask: { paths } } },
  });
}

// SetText is a DEDICATED op and not a mask path: the content lives INSIDE
// the `shape` oneof of the Node, while the mask addresses top-level fields
// (see store/applyOp.ts and core.applySetText).
//
// The style and its flag travel TOGETHER, and this is the only reason the
// function takes an optional style instead of letting callers compose the value:
// in proto3 an absent style and an all-zero one are
// indistinguishable after the protojson round-trip, so it is `style_present` that
// says "touch the style too". Passing it without a style would zero the font;
// passing a style without the flag would make both
// implementations ignore it. Here the two cases are not even expressible.
export function makeSetTextOp(id: string, content: string, style?: TextStyleLite): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: {
      case: "setText",
      value: style
        ? { id, content, style: toPbTextStyle(style), stylePresent: true }
        : { id, content },
    },
  });
}

// SetVectorPath is a DEDICATED op for the same reason as SetText: the geometry
// lives INSIDE the `shape` oneof of the Node, while the SetProperties mask
// addresses top-level fields (see store/applyOp.ts and
// core.applySetVectorPath).
//
// It replaces the subpaths AS A WHOLE, so it does not need the `present` flag of
// setText: the op IS the subpaths, and an empty list is the emptied path -- a
// legitimate state, not an "unspecified".
export function makeSetVectorPathOp(id: string, subpaths: readonly SubPathLite[]): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "setVectorPath", value: { id, subpaths: toPbSubPaths(subpaths) } },
  });
}

// Moves a node under another container (or directly under a Page) and
// rewrites its order among the new peers. A DEDICATED op and not a mask path,
// because reparenting has a validation that no field has -- the new
// parent must exist and cannot be the node itself nor one of its descendants
// (see core.applyReparent and store/applyOp.ts).
//
// `orderKey` travels TOGETHER and is not optional: changing parent without
// reordering would leave the node with the key computed among the OLD peers,
// i.e. in an arbitrary position among the new ones.
export function makeReparentOp(id: string, newParentId: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

export function makeDeleteOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteNode", value: { id } } });
}

// --- pages -----------------------------------------------------------------
// Pages are the ROOT containers. These ops change WHERE nodes can
// live (not a node), and their semantics -- cascade, rejection of the last
// page, rejection of already-taken ids -- already lives in core + store/applyOp.ts. Here
// only the Op is built, as for nodes: opId and docId in one place.
// The page selector (ui/PageBar.tsx) sends them through the same gesture path
// as the tools (beginGesture/endGesture), so ONE op = one send over the network.

// The page id is SUPPLIED by the caller (uuid()) and not generated here, so it is
// known BEFORE the submit -- the selector switches to it right after creating
// it (setCurrentPage), without waiting for the echo.
export function makeCreatePageOp(id: string, name: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "createPage", value: { page: { id, name } } } });
}

export function makeDeletePageOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deletePage", value: { id } } });
}

export function makeRenamePageOp(id: string, name: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "renamePage", value: { id, name } } });
}

// --- flows -----------------------------------------------------------------
// Absolute upserts: the id is SUPPLIED by the caller (uuid()), known before the submit.
export function makeSetFlowOp(flow: FlowLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setFlow", value: { flow: toPbFlow(flow) } } });
}
export function makeDeleteFlowOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteFlow", value: { id } } });
}
export function makeSetTransitionOp(t: TransitionLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setTransition", value: { transition: toPbTransition(t) } } });
}
export function makeDeleteTransitionOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteTransition", value: { id } } });
}

// --- components / instances (M4) -------------------------------------------
// Components are MASTER subtrees already live in `nodes`; instances
// reference them. These ops already exist in proto + core + store/applyOp.ts: here
// only the Op is built, as for everything else (opId and docId in one
// place). The core rejects an already-taken componentId, a missing root, an
// override on a non-node/non-instance: the caller does not send an op that is known
// to be invalid (fresh id, existing node), the rest is up to the server.

// Registers the subtree rooted at `rootNodeId` as the master of component
// `componentId`. It copies nothing -- the master stays where it is, and instances
// read it live (propagation for free). componentId is SUPPLIED by the caller
// (uuid()) so it is known before the submit, like a page id.
export function makeCreateComponentOp(componentId: string, rootNodeId: string, name: string): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "createComponent", value: { componentId, rootNodeId, name } },
  });
}

// Sets (or CLEARS) an instance's override on a master node. The override
// arrives as Lite and its field PRESENCE becomes fills_present/text_present
// via toPbInstanceOverride: an override with neither fills nor text is the REMOVAL --
// the master node goes back to inheriting (see store/applyOp.ts::
// setInstanceOverride and core.applySetInstanceOverride). The upsert by
// masterNodeId belongs to the reducer, not here.
export function makeSetInstanceOverrideOp(instanceId: string, override: InstanceOverrideLite): Op {
  return create(OpSchema, {
    opId: uuid(),
    docId: docId(),
    kind: { case: "setInstanceOverride", value: { instanceId, override: toPbInstanceOverride(override) } },
  });
}

export interface InstanceNodeParams {
  id: string;
  parentId: string;
  orderKey: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  componentId: string;
}

// Builds the Node of an INSTANCE (kind "instance") ready for makeCreateNodeOp:
// the `instance` shape with the componentId filled in and NO overrides. x/y are where the
// master's ORIGIN lands when the instance draws it (store/instances.ts::
// instanceDescentLocal); width/height are metadata shown by the panel -- the real
// bounds are derived from the master on every read. visible/opacity at the
// defaults of a newly created shape, as shapeTool makes them.
export function makeInstanceNode(p: InstanceNodeParams): Node {
  return create(NodeSchema, {
    id: p.id,
    parentId: p.parentId,
    orderKey: p.orderKey,
    name: p.name,
    visible: true,
    opacity: 1,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    shape: { case: "instance", value: { componentId: p.componentId, overrides: [] } },
  });
}

// --- variables ---------------------------------------------------------------
// Absolute upserts of a collection / variable (id supplied by the caller) and deletions.
export function makeSetCollectionOp(c: CollectionLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setCollection", value: { collection: toPbCollection(c) } } });
}
export function makeDeleteCollectionOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteCollection", value: { id } } });
}
export function makeSetVariableOp(v: VariableLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setVariable", value: { variable: toPbVariable(v) } } });
}
export function makeDeleteVariableOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteVariable", value: { id } } });
}

// --- animation -------------------------------------------------------------
// Absolute upsert of the whole clip (id supplied by the caller) and deletion.
export function makeSetClipOp(clip: ClipLite): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "setClip", value: { clip: toPbClip(clip) } } });
}
export function makeDeleteClipOp(id: string): Op {
  return create(OpSchema, { opId: uuid(), docId: docId(), kind: { case: "deleteClip", value: { id } } });
}
