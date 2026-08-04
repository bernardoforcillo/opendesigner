import { create } from "@bufbuild/protobuf";
import { NodeSchema, StrokeAlign, TextAlign } from "../gen/brawt/v1/brawt_pb";
import type {
  Document, Node as PbNode, Paint as PbPaint, Stroke as PbStroke,
  TextNode as PbTextNode, TextStyle as PbTextStyle,
  SubPath as PbSubPath, VectorNode as PbVectorNode,
} from "../gen/brawt/v1/brawt_pb";

export interface PageLite { id: string; name: string; }
export interface FillLite { r: number; g: number; b: number; a: number; }

// L'allineamento del tratto come stringa, per la stessa ragione di
// TextAlignLite: il modello in memoria è ciò che leggono renderer e pannelli, e
// una stringa si legge (e si scrive in un test) senza importare il generato.
// STROKE_ALIGN_UNSPECIFIED collassa su "center" -- è il default del canvas 2D,
// quindi la distinzione non è osservabile.
export type StrokeAlignLite = "center" | "inside" | "outside";

// Un tratto APPIATTITO, come FillLite lo è per un Paint: il colore risolto e
// basta. Il peso è in coordinate MONDO (come fontSize), quindi un tratto da 4
// resta spesso 4 unità a ogni zoom -- si ingrandisce col nodo, non con lo
// schermo. Il default 0 è "nessun tratto da disegnare", non "sottilissimo":
// un peso non positivo non produce né pixel né sporgenza dei bounds (vedi
// canvas/geometry.ts::strokeOutsetOf).
export interface StrokeLite { color: FillLite; weight: number; align: StrokeAlignLite; }

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

// La geometria vettoriale. Specchia brawt.v1.Anchor/SubPath/VectorNode uno a
// uno: nessun default risolto qui e nessuna forma "comoda" (niente segmenti
// precalcolati, niente maniglie relative), per la stessa ragione per cui
// TextStyleLite non risolve lineHeight -- questo modello deve restare
// indistinguibile da quello che core.Apply (Go) tiene in memoria, e ogni
// derivazione fatta qui sarebbe una regola in più da tenere identica di là.
//
// I DUE SPAZI (regola completa e motivata nel proto, su `Anchor`; l'unica
// implementazione è ./vectorGeometry.ts, e nient'altro deve rifarla a mano):
//   - x/y sono LOCALI al nodo: il punto mondo è (node.x + a.x, node.y + a.y).
//     Così la geometria si sposta col nodo, e un drag resta il setProps{x,y}
//     che selectTool manda già oggi.
//   - inX/inY e outX/outY sono OFFSET RELATIVI all'ancoraggio: il controllo
//     entrante è (x + inX, y + inY). (0,0) significa maniglia coincidente con
//     l'ancoraggio, cioè NESSUNA maniglia -- il segmento è una retta. È anche
//     il default di proto3, quindi un ancoraggio d'angolo si scrive omettendo
//     i campi invece di riempirli.
export interface AnchorLite {
  x: number; y: number;
  inX: number; inY: number;
  outX: number; outY: number;
}
export interface SubPathLite { anchors: AnchorLite[]; closed: boolean; }
export interface VectorLite { subpaths: SubPathLite[]; }

export interface NodeLite {
  id: string; parentId: string; orderKey: string; name: string;
  visible: boolean; opacity: number;
  x: number; y: number; width: number; height: number; rotation: number;
  // "unknown" = il oneof `shape` porta una forma PRESENTE che questo modello non
  // conosce. NON è la stessa cosa di una forma ASSENTE, che resta "rect": Go
  // accetta un Node senza shape come rettangolo implicito e va accettato anche
  // qui. Esiste perché il ripiego "tutto il resto è rect" faceva divergere i due
  // lati nel modo che la whitelist di core.applySetProps esiste per impedire: un
  // setProps{corner_radius} su un GroupNode sarebbe stato ACCETTATO qui (kind
  // ricadeva su "rect", cornerRadius scritto) e rifiutato da core.Apply con
  // ErrNotRectNode. Un default che REGALA una forma è lo stesso errore di una
  // blacklist, solo dall'altro lato del filo.
  //
  // "group" è un CONTENITORE, non una forma: non si disegna e non si colpisce,
  // e i suoi bounds sono l'unione dei figli (vedi store/groups.ts). Sta nello
  // stesso campo delle forme perché nel proto è lo stesso oneof `shape`: ciò
  // che un nodo È, non un flag a parte che potrebbe contraddirlo.
  // "frame" è il complemento del gruppo: un contenitore CON geometria propria
  // (il box è suo, non l'unione dei figli), disegnato e colpito come una forma.
  // È l'artboard, e `clipsContent` dice se ritaglia i figli al proprio box.
  fills: FillLite[]; strokes: StrokeLite[];
  kind: "rect" | "ellipse" | "text" | "image" | "vector" | "unknown" | "group" | "frame"; cornerRadius: number;
  // Significativo se e solo se kind === "frame" (per tutti gli altri è false,
  // come il default proto3): il ritaglio vale per il disegno, per l'hit-test e
  // per la banda elastica insieme -- ciò che non si vede non si clicca.
  clipsContent: boolean;
  // Presente se e solo se kind === "text": il contenuto vive DENTRO il oneof
  // `shape` del proto, quindi è per costruzione esclusivo con rect/ellipse.
  text?: TextLite;
  // Presente se e solo se kind === "image", ed esclusivo con `text` per la
  // stessa ragione (sono due rami dello stesso oneof).
  image?: ImageLite;
  // Presente se e solo se kind === "vector", per la stessa ragione: la
  // geometria è un ramo del oneof `shape`, quindi esclusiva con le altre forme.
  vector?: VectorLite;
  // Presente se e solo se kind === "unknown": il ramo del oneof così com'è
  // arrivato, OPACO. Non lo si legge mai -- serve solo a toPbNode per rimetterlo
  // dov'era. Senza, l'inverso di una delete (history.invertOp ricostruisce il
  // Node da NodeLite) riporterebbe in vita un GroupNode trasformato in
  // rettangolo: un cambio di forma silenzioso dentro un Ctrl+Z.
  unknownShape?: PbNode["shape"];
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

const STROKE_ALIGN_TO_LITE: Record<StrokeAlign, StrokeAlignLite> = {
  [StrokeAlign.UNSPECIFIED]: "center",
  [StrokeAlign.CENTER]: "center",
  [StrokeAlign.INSIDE]: "inside",
  [StrokeAlign.OUTSIDE]: "outside",
};
const STROKE_ALIGN_TO_PB: Record<StrokeAlignLite, StrokeAlign> = {
  center: StrokeAlign.CENTER,
  inside: StrokeAlign.INSIDE,
  outside: StrokeAlign.OUTSIDE,
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

// I subpath del filo nella forma del modello. Campo per campo e non uno spread:
// un `{...a}` copierebbe anche `$typeName` (protobuf-es lo mette su ogni
// messaggio) dentro il modello, e da lì nei confronti dei test e nelle scritture
// di ritorno. L'elenco esplicito è anche la guardia: un campo aggiunto ad Anchor
// nel .proto non compare qui da solo, e il round-trip lo scopre.
export function toSubPathsLite(subpaths: readonly PbSubPath[]): SubPathLite[] {
  return subpaths.map((sp) => ({
    anchors: sp.anchors.map((a) => ({
      x: a.x, y: a.y, inX: a.inX, inY: a.inY, outX: a.outX, outY: a.outY,
    })),
    closed: sp.closed,
  }));
}

export function toVectorLite(v: PbVectorNode): VectorLite {
  return { subpaths: toSubPathsLite(v.subpaths) };
}

// Inverso di toSubPathsLite. Come toPbTextStyle ritorna la forma di INIT (non
// messaggi creati): i chiamanti la annidano dentro il `create(...)` di un Node
// (toPbNode) o di un Op (history.invertOp, e il pen tool quando arriverà).
export function toPbSubPaths(subpaths: readonly SubPathLite[]) {
  return subpaths.map((sp) => ({
    anchors: sp.anchors.map((a) => ({
      x: a.x, y: a.y, inX: a.inX, inY: a.inY, outX: a.outX, outY: a.outY,
    })),
    closed: sp.closed,
  }));
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
  return fills.map(toPbPaint);
}

// I TRATTI del modello nella forma di init di brawt.v1.Node.strokes. Gemella di
// toPbFills, ed esportata per la stessa ragione: il pannello proprietà
// (ui/PropertiesPanel.tsx) costruisce lo STESSO patch per il suo op di tratto.
export function toPbStrokes(strokes: readonly StrokeLite[]) {
  return strokes.map((s) => ({
    paint: toPbPaint(s.color),
    weight: s.weight,
    align: STROKE_ALIGN_TO_PB[s.align] ?? StrokeAlign.CENTER,
  }));
}

function toPbPaint(c: FillLite) {
  return { kind: { case: "solid" as const, value: { color: { r: c.r, g: c.g, b: c.b, a: c.a } } } };
}

// Un Paint del filo APPIATTITO nel colore che il renderer disegna. Una funzione
// sola per riempimenti e tratti: sono lo stesso messaggio nel proto, e due
// appiattimenti indipendenti divergerebbero al primo paint non-solid (oggi
// l'unico caso è un paint ASSENTE, ma il oneof `kind` esiste per crescere).
function toFillLite(p: PbPaint | undefined): FillLite {
  const c = p?.kind.case === "solid" ? p.kind.value.color : undefined;
  return c ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: 0, g: 0, b: 0, a: 1 };
}

export function toStrokeLite(s: PbStroke): StrokeLite {
  return {
    color: toFillLite(s.paint),
    weight: s.weight,
    align: STROKE_ALIGN_TO_LITE[s.align] ?? "center",
  };
}

// La forma del nodo nel vocabolario del modello. Il default è RIFIUTARE, non
// ricadere su "rect": vale qui la stessa ragione per cui core.applySetProps (Go)
// elenca le forme che ACCETTA invece di quelle che rifiuta. Le altre tracce
// stanno aggiungendo forme al oneof adesso (33 Group, 34 Frame, 37 Instance), e
// con un ripiego su "rect" ognuna di quelle, appena fusa, farebbe accettare a
// questo lato un setProps{corner_radius} che Go rifiuta -- la divergenza
// client/documento autorevole, semplicemente specchiata.
//
// Forma ASSENTE => "rect", e non è un'eccezione alla regola ma la regola stessa:
// Go tratta un Node senza shape da rettangolo implicito (whitelist `nil` o
// `*brawtv1.Node_Rect`), quindi trattarlo diversamente qui sarebbe la
// divergenza.
function kindOf(shape: PbNode["shape"]): NodeLite["kind"] {
  switch (shape.case) {
    case undefined: return "rect";
    case "rect": return "rect";
    case "ellipse": return "ellipse";
    case "text": return "text";
    case "image": return "image";
    case "vector": return "vector";
    case "group": return "group";
    case "frame": return "frame";
    default: return "unknown";
  }
}

export function toNodeLite(n: PbNode): NodeLite {
  const kind = kindOf(n.shape);
  return {
    id: n.id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
    visible: n.visible, opacity: n.opacity,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation,
    fills: n.fills.map(toFillLite),
    strokes: n.strokes.map(toStrokeLite),
    kind,
    cornerRadius: n.shape.case === "rect" ? n.shape.value.cornerRadius : 0,
    clipsContent: n.shape.case === "frame" ? n.shape.value.clipsContent : false,
    ...(n.shape.case === "text" ? { text: toTextLite(n.shape.value) } : {}),
    ...(n.shape.case === "image" ? { image: { assetHash: n.shape.value.assetHash } } : {}),
    ...(n.shape.case === "vector" ? { vector: toVectorLite(n.shape.value) } : {}),
    // Il ramo sconosciuto viaggia intero e intatto: vedi NodeLite.unknownShape.
    ...(kind === "unknown" ? { unknownShape: n.shape } : {}),
  };
}

// Inverso esatto di toNodeLite: ricostruisce il Node protobuf da un NodeLite.
// Sta qui, accanto a toNodeLite, di proposito: un campo aggiunto a NodeLite
// deve comparire in ENTRAMBE le direzioni, e l'adiacenza è la guardia.
// Serve all'undo (history.invertOp): l'inverso di una delete è la create del
// nodo com'era, e il modello in memoria tiene solo NodeLite.
export function toPbNode(n: NodeLite): PbNode {
  const node = create(NodeSchema, {
    id: n.id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
    visible: n.visible, opacity: n.opacity,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation,
    fills: toPbFills(n.fills),
    strokes: toPbStrokes(n.strokes),
    shape: n.kind === "unknown"
      // La forma sconosciuta non si può COSTRUIRE (non c'è un ramo del oneof da
      // nominare), quindi si rimette dov'era subito dopo la create. Lasciarla
      // qui a `undefined` per un istante è l'unico modo di NON scriverci sopra
      // un rettangolo: era esattamente il baco -- un GroupNode che tornava
      // rettangolo passando da un undo.
      ? undefined
      : n.kind === "ellipse"
      ? { case: "ellipse" as const, value: {} }
      : n.kind === "image"
        // L'hash e basta: è tutto ciò che un ImageNode contiene, e ricostruirlo
        // qui è ciò che fa sopravvivere un'immagine all'undo di una delete e a
        // un incolla (entrambi passano da toPbNode). `image` mancante ricade su
        // un hash vuoto -- cioè su un'immagine il cui asset non si trova, che il
        // renderer disegna come segnaposto -- e mai su un rettangolo: un cambio
        // di forma silenzioso dentro un undo sarebbe molto peggio.
        ? { case: "image" as const, value: { assetHash: n.image?.assetHash ?? "" } }
      : n.kind === "vector"
        // Come per il testo: un `vector` mancante su un nodo vettoriale è uno
        // stato che toNodeLite non produce mai (i due si muovono insieme), e il
        // ripiego alla lista vuota serve solo a non ricostruire un RETTANGOLO
        // da un path -- che dentro un undo sarebbe un cambio di forma
        // silenzioso. Un path svuotato resta un path.
        ? { case: "vector" as const, value: { subpaths: toPbSubPaths(n.vector?.subpaths ?? []) } }
      // Un gruppo non ha campi propri: ciò che lo rende un gruppo è il caso del
      // oneof (più i figli che gli puntano). Il ramo esiste comunque, e non è
      // pedanteria: senza, l'inverso di una delete ricostruirebbe un
      // RETTANGOLO al posto del gruppo -- un cambio di forma silenzioso dentro
      // un undo, per giunta con un box 0x0 che non si vedrebbe mai.
      : n.kind === "group"
      ? { case: "group" as const, value: {} }
      // Stesso motivo del ramo `group`, più un campo: senza, l'inverso di una
      // delete ricostruirebbe un RETTANGOLO al posto del frame, e un frame
      // ricostruito senza `clipsContent` smetterebbe di ritagliare i figli --
      // un undo che cambia ciò che si vede.
      : n.kind === "frame"
      ? { case: "frame" as const, value: { clipsContent: n.clipsContent } }
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
  if (n.kind === "unknown" && n.unknownShape) node.shape = n.unknownShape;
  return node;
}

export function fromDocument(doc: Document): SceneState {
  const nodes: Record<string, NodeLite> = {};
  for (const [id, n] of Object.entries(doc.nodes)) nodes[id] = toNodeLite(n);
  return { id: doc.id, name: doc.name, schemaVersion: doc.schemaVersion, pages: doc.pages.map((p) => ({ id: p.id, name: p.name })), nodes };
}
