import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node, Op, RenderDiagramResponse } from "../gen/opendesigner/v1/opendesigner_pb";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { docClient } from "../rpc/client";

// DIAGRAMS IN THE EDITOR.
//
// The real drawing (Mermaid parser, layout, UML) lives on the server, in
// internal/diagram: it is the same function the MCP tools use, so a
// diagram created by the editor and one created by an agent are identical. Here there is
// only what touches the store: asking for the drawing, inserting it as ONE gesture
// (a single undo) and recognizing an already-present diagram in order to redraw it.

/** `meta` keys on a diagram's root (see internal/diagram). */
export const META_SOURCE = "diagram.source";
export const META_KIND = "diagram.kind";

/** A text the server cannot read: the message is to be shown as is. */
export class DiagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramError";
  }
}

export interface RenderClient {
  renderDiagram(req: { source: string }): Promise<RenderDiagramResponse>;
}

/** Asks for the drawing of `source`. Throws DiagramError for an unreadable text. */
export async function renderDiagram(source: string, client: RenderClient = docClient): Promise<RenderDiagramResponse> {
  try {
    return await client.renderDiagram({ source });
  } catch (err) {
    const ce = ConnectError.from(err);
    if (ce.code === Code.InvalidArgument) throw new DiagramError(ce.rawMessage);
    throw new DiagramError("the server is not responding: try again");
  }
}

/** The selected diagram (its root), if the selection is exactly one. */
export function selectedDiagram(): { id: string; source: string; kind: string } | null {
  const { scene, selection } = useScene.getState();
  if (!scene || selection.length !== 1) return null;
  const n = scene.nodes.get(selection[0]);
  const source = n?.meta?.[META_SOURCE];
  return n && source ? { id: n.id, source, kind: n.meta?.[META_KIND] ?? "" } : null;
}

const createOp = (docId: string, node: Node): Op =>
  create(OpSchema, { opId: crypto.randomUUID(), docId, kind: { case: "createNode", value: { node } } });

/**
 * Inserts the nodes of a drawn diagram. `at` is the CENTER (world
 * coordinates). With `replaceId` the indicated diagram is redrawn in its place (same
 * parent, same position, same name) in the same gesture. Returns the root's id,
 * or null if it cannot be done (no document, gesture in progress).
 */
export function insertDiagram(res: Pick<RenderDiagramResponse, "nodes" | "width" | "height">, at: { x: number; y: number }, replaceId?: string): string | null {
  const st = useScene.getState();
  const scene = st.scene;
  if (!scene || st.gesture || res.nodes.length === 0) return null;

  const rootSrc = res.nodes[0];
  const root = create(NodeSchema, rootSrc);
  const old = replaceId ? scene.nodes.get(replaceId) : undefined;
  if (old) {
    root.parentId = old.parentId;
    root.x = old.x;
    root.y = old.y;
    root.name = old.name;
  } else {
    root.parentId = st.currentPageId ?? scene.pages[0]?.id ?? "";
    root.x = Math.round((at.x - res.width / 2) * 100) / 100;
    root.y = Math.round((at.y - res.height / 2) * 100) / 100;
  }
  root.orderKey = nextOrderKey(scene);

  const ops: Op[] = [];
  if (old) ops.push(create(OpSchema, { opId: crypto.randomUUID(), docId: scene.id, kind: { case: "deleteNode", value: { id: old.id } } }));
  ops.push(createOp(scene.id, root));
  for (const n of res.nodes.slice(1)) ops.push(createOp(scene.id, create(NodeSchema, n)));

  st.beginGesture();
  useScene.getState().setSelection([root.id]);
  useScene.getState().endGesture(ops);
  return root.id;
}
