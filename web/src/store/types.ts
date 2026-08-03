import { create } from "@bufbuild/protobuf";
import { NodeSchema, TextAlign } from "../gen/brawt/v1/brawt_pb";
import type { Document, Node as PbNode, TextNode as PbTextNode, TextStyle as PbTextStyle } from "../gen/brawt/v1/brawt_pb";

export interface PageLite { id: string; name: string; }
export interface FillLite { r: number; g: number; b: number; a: number; }

// L'allineamento come stringa e non come enum numerico, per la stessa ragione
// per cui `kind` è "rect" | "ellipse" | "text" invece del discriminante del
// oneof: il modello in memoria è ciò che leggono renderer e pannelli, e una
// stringa si legge (e si scrive in un test) senza importare il generato.
// TEXT_ALIGN_UNSPECIFIED collassa su "left" -- è il default che il renderer
// dovrebbe comunque applicare, quindi la distinzione non è osservabile.
export type TextAlignLite = "left" | "center" | "right";

// Nessun default viene risolto qui: `lineHeight: 0` resta 0 e non diventa 1.2.
// Il default è del RENDERER (vedi il commento nel proto), e applicarlo nel
// modello farebbe divergere questo lato da core.Apply (Go), che conserva
// lo zero.
export interface TextStyleLite {
  fontFamily: string; fontSize: number; fontWeight: string;
  lineHeight: number; align: TextAlignLite;
}
export interface TextLite { content: string; style: TextStyleLite; }

// Un'immagine è un RIFERIMENTO, mai dei byte: `assetHash` è lo sha256
// (esadecimale minuscolo) dei byte, che stanno in <doc>.brawt/assets/ e si
// caricano dall'URL che costruisce rpc/assets.ts::assetUrl.
//
// Il modello non contiene pixel, e questa è la proprietà da non perdere: un
// NodeLite finisce dentro gli op, dentro lo snapshot e dentro il payload della
// clipboard, e nessuno di quei tre posti deve mai trasportare un'immagine.
export interface ImageLite { assetHash: string; }

export interface NodeLite {
  id: string; parentId: string; orderKey: string; name: string;
  visible: boolean; opacity: number;
  x: number; y: number; width: number; height: number; rotation: number;
  fills: FillLite[]; kind: "rect" | "ellipse" | "text" | "image"; cornerRadius: number;
  // Presente se e solo se kind === "text": il contenuto vive DENTRO il oneof
  // `shape` del proto, quindi è per costruzione esclusivo con rect/ellipse.
  text?: TextLite;
  // Presente se e solo se kind === "image", ed esclusivo con `text` per la
  // stessa ragione (sono due rami dello stesso oneof).
  image?: ImageLite;
}

export interface SceneState {
  id: string; name: string; schemaVersion: number;
  pages: PageLite[]; nodes: Record<string, NodeLite>;
}

export function emptyScene(id: string, name: string): SceneState {
  return { id, name, schemaVersion: 1, pages: [{ id: "page1", name: "Page 1" }], nodes: {} };
}

const ALIGN_TO_LITE: Record<TextAlign, TextAlignLite> = {
  [TextAlign.UNSPECIFIED]: "left",
  [TextAlign.LEFT]: "left",
  [TextAlign.CENTER]: "center",
  [TextAlign.RIGHT]: "right",
};
const ALIGN_TO_PB: Record<TextAlignLite, TextAlign> = {
  left: TextAlign.LEFT,
  center: TextAlign.CENTER,
  right: TextAlign.RIGHT,
};

// Uno stile ASSENTE non è un errore: in Go `t.Text.GetStyle()` è nil-safe e
// ritorna gli zeri di ogni campo (ed è esattamente ciò che resta dopo un
// SetText con style_present=true e nessuno stile). Qui la controparte è uno
// stile tutto a zero, così le due implementazioni restano indistinguibili.
export function toTextStyleLite(s: PbTextStyle | undefined): TextStyleLite {
  return {
    fontFamily: s?.fontFamily ?? "",
    fontSize: s?.fontSize ?? 0,
    fontWeight: s?.fontWeight ?? "",
    lineHeight: s?.lineHeight ?? 0,
    align: ALIGN_TO_LITE[s?.align ?? TextAlign.UNSPECIFIED] ?? "left",
  };
}

export function toTextLite(t: PbTextNode): TextLite {
  return { content: t.content, style: toTextStyleLite(t.style) };
}

// Inverso di toTextStyleLite. Ritorna la forma di init (non un messaggio
// creato): i chiamanti la annidano dentro `create(...)` di un Node o di un Op.
export function toPbTextStyle(s: TextStyleLite) {
  return {
    fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
    lineHeight: s.lineHeight, align: ALIGN_TO_PB[s.align] ?? TextAlign.LEFT,
  };
}

// Le tinte del modello nella forma di init di brawt.v1.Node.fills.
//
// NodeLite conosce solo tinte PIATTE (toNodeLite appiattisce qualsiasi paint
// non-solid in un colore), quindi il ritorno è sempre una lista di SolidPaint.
// Estratta da toPbNode perché il pannello proprietà (ui/PropertiesPanel.tsx)
// costruisce lo STESSO patch per il suo op di riempimento: due mappature
// indipendenti dello stesso campo divergerebbero al primo paint non-solid.
export function toPbFills(fills: readonly FillLite[]) {
  return fills.map((f) => ({
    kind: { case: "solid" as const, value: { color: { r: f.r, g: f.g, b: f.b, a: f.a } } },
  }));
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
    fills,
    // "rect" resta il fallback per una forma assente o sconosciuta: un nodo
    // senza shape è comunque un rettangolo disegnabile, mentre un "text" senza
    // contenuto non lo sarebbe.
    kind:
      n.shape.case === "ellipse" ? "ellipse"
      : n.shape.case === "text" ? "text"
      : n.shape.case === "image" ? "image"
      : "rect",
    cornerRadius: n.shape.case === "rect" ? n.shape.value.cornerRadius : 0,
    ...(n.shape.case === "text" ? { text: toTextLite(n.shape.value) } : {}),
    ...(n.shape.case === "image" ? { image: { assetHash: n.shape.value.assetHash } } : {}),
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
    fills: toPbFills(n.fills),
    shape: n.kind === "ellipse"
      ? { case: "ellipse" as const, value: {} }
      : n.kind === "image"
        // L'hash e basta: è tutto ciò che un ImageNode contiene, e ricostruirlo
        // qui è ciò che fa sopravvivere un'immagine all'undo di una delete e a
        // un incolla (entrambi passano da toPbNode). `image` mancante ricade su
        // un hash vuoto -- cioè su un'immagine il cui asset non si trova, che il
        // renderer disegna come segnaposto -- e mai su un rettangolo: un cambio
        // di forma silenzioso dentro un undo sarebbe molto peggio.
        ? { case: "image" as const, value: { assetHash: n.image?.assetHash ?? "" } }
        : n.kind === "text"
        // `text` mancante su un nodo di testo è uno stato che toNodeLite non
        // produce mai (i due si muovono insieme). Il fallback a testo vuoto
        // evita comunque di ricostruire un RETTANGOLO da un nodo di testo --
        // sarebbe un cambio di forma silenzioso in un undo.
        ? { case: "text" as const, value: {
            content: n.text?.content ?? "",
            style: toPbTextStyle(n.text?.style ?? toTextStyleLite(undefined)),
          } }
        : { case: "rect" as const, value: { cornerRadius: n.cornerRadius } },
  });
}

export function fromDocument(doc: Document): SceneState {
  const nodes: Record<string, NodeLite> = {};
  for (const [id, n] of Object.entries(doc.nodes)) nodes[id] = toNodeLite(n);
  return { id: doc.id, name: doc.name, schemaVersion: doc.schemaVersion, pages: doc.pages.map((p) => ({ id: p.id, name: p.name })), nodes };
}
