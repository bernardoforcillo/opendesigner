import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Document, Node as PbNode } from "../gen/brawt/v1/brawt_pb";

export interface PageLite { id: string; name: string; }
export interface FillLite { r: number; g: number; b: number; a: number; }
export interface NodeLite {
  id: string; parentId: string; orderKey: string; name: string;
  visible: boolean; opacity: number;
  x: number; y: number; width: number; height: number; rotation: number;
  fills: FillLite[]; kind: "rect" | "ellipse"; cornerRadius: number;
}
export interface SceneState {
  id: string; name: string; schemaVersion: number;
  pages: PageLite[]; nodes: Record<string, NodeLite>;
}

export function emptyScene(id: string, name: string): SceneState {
  return { id, name, schemaVersion: 1, pages: [{ id: "page1", name: "Page 1" }], nodes: {} };
}

export function toNodeLite(n: PbNode): NodeLite {
  const fills: FillLite[] = n.fills.map((f) =>
    f.kind.case === "solid" && f.kind.value.color
      ? { r: f.kind.value.color.r, g: f.kind.value.color.g, b: f.kind.value.color.b, a: f.kind.value.color.a }
      : { r: 0, g: 0, b: 0, a: 1 });
  return {
    id: n.id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
    visible: n.visible, opacity: n.opacity,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation,
    fills, kind: n.shape.case === "ellipse" ? "ellipse" : "rect",
    cornerRadius: n.shape.case === "rect" ? n.shape.value.cornerRadius : 0,
  };
}

// Inverso esatto di toNodeLite: ricostruisce il Node protobuf da un NodeLite.
// Sta qui, accanto a toNodeLite, di proposito: un campo aggiunto a NodeLite
// deve comparire in ENTRAMBE le direzioni, e l'adiacenza è la guardia.
// Serve all'undo (history.invertOp): l'inverso di una delete è la create del
// nodo com'era, e il modello in memoria tiene solo NodeLite.
export function toPbNode(n: NodeLite): PbNode {
  return create(NodeSchema, {
    id: n.id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
    visible: n.visible, opacity: n.opacity,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation,
    // NodeLite conosce solo tinte piatte (toNodeLite appiattisce qualsiasi
    // paint non-solid in un colore): il ritorno è sempre un SolidPaint.
    fills: n.fills.map((f) => ({
      kind: { case: "solid" as const, value: { color: { r: f.r, g: f.g, b: f.b, a: f.a } } },
    })),
    shape: n.kind === "ellipse"
      ? { case: "ellipse" as const, value: {} }
      : { case: "rect" as const, value: { cornerRadius: n.cornerRadius } },
  });
}

export function fromDocument(doc: Document): SceneState {
  const nodes: Record<string, NodeLite> = {};
  for (const [id, n] of Object.entries(doc.nodes)) nodes[id] = toNodeLite(n);
  return { id: doc.id, name: doc.name, schemaVersion: doc.schemaVersion, pages: doc.pages.map((p) => ({ id: p.id, name: p.name })), nodes };
}
