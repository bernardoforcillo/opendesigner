import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node, Op, RenderDiagramResponse } from "../gen/opendesigner/v1/opendesigner_pb";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { docClient } from "../rpc/client";

// DIAGRAMMI NELL'EDITOR.
//
// Il disegno vero (parser Mermaid, layout, UML) vive sul server, in
// internal/diagram: è la stessa funzione che usano i tool MCP, quindi un
// diagramma creato dall'editor e uno creato da un agente sono identici. Qui c'è
// solo ciò che tocca lo store: chiedere il disegno, inserirlo come UN gesto
// (un solo undo) e riconoscere un diagramma già presente per ridisegnarlo.

/** Chiavi di `meta` sulla radice di un diagramma (vedi internal/diagram). */
export const META_SOURCE = "diagram.source";
export const META_KIND = "diagram.kind";

/** Un testo che il server non sa leggere: il messaggio è da mostrare così com'è. */
export class DiagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramError";
  }
}

export interface RenderClient {
  renderDiagram(req: { source: string }): Promise<RenderDiagramResponse>;
}

/** Chiede il disegno di `source`. Lancia DiagramError per un testo illeggibile. */
export async function renderDiagram(source: string, client: RenderClient = docClient): Promise<RenderDiagramResponse> {
  try {
    return await client.renderDiagram({ source });
  } catch (err) {
    const ce = ConnectError.from(err);
    if (ce.code === Code.InvalidArgument) throw new DiagramError(ce.rawMessage);
    throw new DiagramError("il server non risponde: riprova");
  }
}

/** Il diagramma selezionato (la sua radice), se la selezione è proprio uno. */
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
 * Inserisce i nodi di un diagramma disegnato. `at` è il CENTRO (coordinate
 * mondo). Con `replaceId` il diagramma indicato si ridisegna al suo posto (stesso
 * parent, stessa posizione, stesso nome) nello stesso gesto. Ritorna l'id della
 * radice, o null se non si può (nessun documento, gesto in corso).
 */
export function insertDiagram(res: RenderDiagramResponse, at: { x: number; y: number }, replaceId?: string): string | null {
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
