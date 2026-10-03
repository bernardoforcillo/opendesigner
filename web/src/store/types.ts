import { NodeMap } from "./nodeMap";
import { create } from "@bufbuild/protobuf";
import { ClipSchema, FlowSchema, TransitionSchema, LayoutAlign, LayoutDirection, NodeSchema, StrokeAlign, TextAlign } from "../gen/opendesigner/v1/opendesigner_pb";
import type {
  Document, Clip as PbClip, Flow as PbFlow, Transition as PbTransition, Node as PbNode, Paint as PbPaint, Stroke as PbStroke, Effect as PbEffect, AutoLayout as PbAutoLayout,
  TextNode as PbTextNode, TextStyle as PbTextStyle,
  SubPath as PbSubPath, VectorNode as PbVectorNode,
  InstanceNode as PbInstanceNode, InstanceOverride as PbInstanceOverride,
} from "../gen/opendesigner/v1/opendesigner_pb";

export interface PageLite { id: string; name: string; }
export interface GradientStopLite { color: { r: number; g: number; b: number; a: number }; position: number; }
// Un gradiente in coordinate NORMALIZZATE del box (vedi GradientPaint nel proto).
// Lineare: asse (x1,y1)->(x2,y2). Radiale: centro (x1,y1), raggio = |p2-p1| in
// coordinate mondo.
export interface GradientLite {
  kind: "linear" | "radial";
  stops: GradientStopLite[];
  x1: number; y1: number; x2: number; y2: number;
}
// r,g,b,a restano il colore "di ripiego": per un riempimento solido SONO il
// colore, per un gradiente sono il primo stop. Tutto il codice che conosce solo
// tinte piatte (testo, tratti, pannelli) continua a funzionare senza sapere dei
// gradienti; chi li sa disegnare guarda `gradient`.
export interface FillLite { r: number; g: number; b: number; a: number; gradient?: GradientLite; }

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

// Auto layout di un frame (vedi AutoLayout nel proto e store/layout.ts). Come
// per StrokeAlignLite, gli enum sono stringhe: UNSPECIFIED collassa su
// "horizontal" / "start", che è ciò che il calcolo farebbe comunque.
export type LayoutDirectionLite = "horizontal" | "vertical";
export type LayoutAlignLite = "start" | "center" | "end" | "space-between";
export interface AutoLayoutLite {
  direction: LayoutDirectionLite;
  spacing: number;
  paddingLeft: number; paddingTop: number; paddingRight: number; paddingBottom: number;
  mainAlign: LayoutAlignLite;
  crossAlign: LayoutAlignLite;
  hugWidth: boolean; hugHeight: boolean;
}

// Un effetto del nodo. Ombra e sfocatura sono in coordinate MONDO, come il peso
// di un tratto: si ingrandiscono con lo zoom. Il renderer disegna la PRIMA
// ombra e la PRIMA sfocatura di un nodo (il canvas 2D ha un solo stato di ombra);
// il modello e il filo tengono comunque l'intera lista.
export type EffectLite =
  | { kind: "dropShadow"; color: { r: number; g: number; b: number; a: number }; offsetX: number; offsetY: number; blur: number }
  | { kind: "layerBlur"; radius: number };

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
// (esadecimale minuscolo) dei byte, che stanno in <doc>.opendesigner/assets/ e si
// caricano dall'URL che costruisce rpc/assets.ts::assetUrl.
//
// Il modello non contiene pixel, e questa è la proprietà da non perdere: un
// NodeLite finisce dentro gli op, dentro lo snapshot e dentro il payload della
// clipboard, e nessuno di quei tre posti deve mai trasportare un'immagine.
export interface ImageLite { assetHash: string; }

// La geometria vettoriale. Specchia opendesigner.v1.Anchor/SubPath/VectorNode uno a
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

// M4 — un override per-istanza su UN nodo del master, APPIATTITO come le altre
// Lite. La PRESENZA è l'optional, non due flag booleani: `fills` è definito se e
// solo se il proto ha fills_present, `text` se e solo se text_present. Così
// l'ASSENZA del campo nel modello È il "non sovrascritto" del proto, e distingue
// "non sovrascrivo il fill" da "sovrascrivo il fill a lista vuota" (o il testo a
// stringa vuota) senza portarsi dietro un fill che l'utente non ha toccato --
// come style_present per SetText. Un override senza né fills né text non esiste
// nel modello: nel proto è la RIMOZIONE (torna a ereditare dal master), e
// applyOp/core lo tolgono invece di conservarlo.
export interface InstanceOverrideLite {
  masterNodeId: string;
  fills?: FillLite[];
  text?: string;
}

// M4 — un'istanza di un componente: il componentId che rende, più gli override
// per nodo del master. I figli NON stanno qui (né in `nodes`): sono derivati dal
// master a ogni lettura (renderer, hit-test, bounds).
export interface InstanceLite {
  componentId: string;
  overrides: InstanceOverrideLite[];
}

// M4 — un componente indicizzato in SceneState.components (componentId ->
// master): la radice del master, che è un nodo VIVO in `nodes`, più un nome. Non
// copia il sottoalbero -- lo referenzia, quindi la propagazione master->istanze
// è gratis.
export interface ComponentLite {
  rootNodeId: string;
  name: string;
}

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
  // Assente quando il nodo non ha effetti (non `[]`): così un nodo senza
  // effetti è identico, campo per campo, a com'era prima che esistessero.
  effects?: EffectLite[];
  // "instance" è un'ISTANZA di un componente (proto: InstanceNode = 37): sta nel
  // oneof `shape` come le forme, ma il suo sottoalbero è VIRTUALE -- derivato dal
  // master a ogni lettura, mai in `nodes`. Il payload è in `instance`.
  kind: "rect" | "ellipse" | "text" | "image" | "vector" | "unknown" | "group" | "frame" | "instance"; cornerRadius: number;
  // Significativo se e solo se kind === "frame" (per tutti gli altri è false,
  // come il default proto3): il ritaglio vale per il disegno, per l'hit-test e
  // per la banda elastica insieme -- ciò che non si vede non si clicca.
  clipsContent: boolean;
  // Presente se e solo se kind === "frame" E il frame dispone i figli. Assente
  // (non un valore "spento") quando non c'è auto layout.
  autoLayout?: AutoLayoutLite;
  // Presente se e solo se kind === "text": il contenuto vive DENTRO il oneof
  // `shape` del proto, quindi è per costruzione esclusivo con rect/ellipse.
  text?: TextLite;
  // Presente se e solo se kind === "image", ed esclusivo con `text` per la
  // stessa ragione (sono due rami dello stesso oneof).
  image?: ImageLite;
  // Presente se e solo se kind === "vector", per la stessa ragione: la
  // geometria è un ramo del oneof `shape`, quindi esclusiva con le altre forme.
  vector?: VectorLite;
  // Presente se e solo se kind === "instance", ed esclusivo con le altre forme
  // per la stessa ragione (è un ramo del oneof `shape`). Porta il componentId
  // reso e gli override per nodo del master.
  instance?: InstanceLite;
  // Presente se e solo se kind === "unknown": il ramo del oneof così com'è
  // arrivato, OPACO. Non lo si legge mai -- serve solo a toPbNode per rimetterlo
  // dov'era. Senza, l'inverso di una delete (history.invertOp ricostruisce il
  // Node da NodeLite) riporterebbe in vita un GroupNode trasformato in
  // rettangolo: un cambio di forma silenzioso dentro un Ctrl+Z.
  unknownShape?: PbNode["shape"];
  // Metadati liberi (vedi Node.meta nel proto). Assente quando vuoto.
  meta?: Record<string, string>;
}

// FLUSSI: i percorsi dell'utente fra le schermate (nodi del documento,
// referenziati per id). Vedi proto Flow/Transition e internal/core/flows.go.
export interface FlowLite { id: string; name: string; description: string; startId: string }
export interface TransitionLite {
  id: string; flowId: string; fromId: string; toId: string;
  label: string; trigger: string; elementId: string; guard: string; effect: string;
}

// ANIMAZIONE: le clip del documento (proprietà animate di nodi referenziati per
// id). Vedi proto Clip/Track/Keyframe e internal/core/animation.go.
export interface KeyframeLite { time: number; value: number; easing: string }
export interface TrackLite { nodeId: string; prop: string; keyframes: KeyframeLite[] }
export interface ClipLite {
  id: string; name: string; duration: number; trigger: string; delay: number;
  repeat: number; yoyo: boolean; tracks: TrackLite[]; targetId: string;
}

export interface SceneState {
  id: string; name: string; schemaVersion: number;
  pages: PageLite[]; nodes: NodeMap;
  flows: Record<string, FlowLite>;
  transitions: Record<string, TransitionLite>;
  clips: Record<string, ClipLite>;
  // M4 — componenti indicizzati per id (componentId -> master). Fa parte del
  // documento quanto `nodes` e `pages`: un CreateComponent lo popola, e
  // fromDocument lo ricostruisce dallo snapshot.
  components: Record<string, ComponentLite>;
}

export function emptyScene(id: string, name: string): SceneState {
  return { id, name, schemaVersion: 1, pages: [{ id: "page1", name: "Page 1" }], nodes: NodeMap.empty, flows: {}, transitions: {}, clips: {}, components: {} };
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

// M4 — un override del filo APPIATTITO. La PRESENZA segue i flag *_present del
// proto, non i valori: `fills` compare solo se fills_present, `text` solo se
// text_present. Così l'assenza del campo nel modello È il "non sovrascritto" del
// proto (vedi InstanceOverrideLite), e un override di solo testo non si porta
// dietro un fill vuoto (né viceversa). Inverso esatto di toPbInstanceOverride.
export function toInstanceOverrideLite(o: PbInstanceOverride): InstanceOverrideLite {
  return {
    masterNodeId: o.masterNodeId,
    ...(o.fillsPresent ? { fills: o.fills.map(toFillLite) } : {}),
    ...(o.textPresent ? { text: o.text } : {}),
  };
}

export function toInstanceLite(n: PbInstanceNode): InstanceLite {
  return { componentId: n.componentId, overrides: n.overrides.map(toInstanceOverrideLite) };
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

// Le tinte del modello nella forma di init di opendesigner.v1.Node.fills.
//
// NodeLite conosce solo tinte PIATTE (toNodeLite appiattisce qualsiasi paint
// non-solid in un colore), quindi il ritorno è sempre una lista di SolidPaint.
// Estratta da toPbNode perché il pannello proprietà (ui/PropertiesPanel.tsx)
// costruisce lo STESSO patch per il suo op di riempimento: due mappature
// indipendenti dello stesso campo divergerebbero al primo paint non-solid.
export function toPbFills(fills: readonly FillLite[]) {
  return fills.map(toPbPaint);
}

// I TRATTI del modello nella forma di init di opendesigner.v1.Node.strokes. Gemella di
// toPbFills, ed esportata per la stessa ragione: il pannello proprietà
// (ui/PropertiesPanel.tsx) costruisce lo STESSO patch per il suo op di tratto.
export function toPbStrokes(strokes: readonly StrokeLite[]) {
  return strokes.map((s) => ({
    paint: toPbPaint(s.color),
    weight: s.weight,
    align: STROKE_ALIGN_TO_PB[s.align] ?? StrokeAlign.CENTER,
  }));
}

// Gli EFFETTI del modello nella forma di init di opendesigner.v1.Node.effects.
// Gemella di toPbFills/toPbStrokes: il pannello costruisce lo STESSO patch.
export function toPbEffects(effects: readonly EffectLite[]) {
  return effects.map((e) =>
    e.kind === "dropShadow"
      ? { kind: { case: "dropShadow" as const, value: { color: { ...e.color }, offsetX: e.offsetX, offsetY: e.offsetY, blur: e.blur } } }
      : { kind: { case: "layerBlur" as const, value: { radius: e.radius } } },
  );
}

const LAYOUT_ALIGN_TO_LITE: Partial<Record<LayoutAlign, LayoutAlignLite>> = {
  [LayoutAlign.START]: "start", [LayoutAlign.CENTER]: "center", [LayoutAlign.END]: "end",
  [LayoutAlign.SPACE_BETWEEN]: "space-between",
};
const LAYOUT_ALIGN_TO_PB: Record<LayoutAlignLite, LayoutAlign> = {
  start: LayoutAlign.START, center: LayoutAlign.CENTER, end: LayoutAlign.END,
  "space-between": LayoutAlign.SPACE_BETWEEN,
};

export function toAutoLayoutLite(a: PbAutoLayout): AutoLayoutLite {
  return {
    direction: a.direction === LayoutDirection.VERTICAL ? "vertical" : "horizontal",
    spacing: a.spacing,
    paddingLeft: a.paddingLeft, paddingTop: a.paddingTop, paddingRight: a.paddingRight, paddingBottom: a.paddingBottom,
    mainAlign: LAYOUT_ALIGN_TO_LITE[a.mainAlign] ?? "start",
    crossAlign: LAYOUT_ALIGN_TO_LITE[a.crossAlign] ?? "start",
    hugWidth: a.hugWidth, hugHeight: a.hugHeight,
  };
}

export function toPbAutoLayout(a: AutoLayoutLite) {
  return {
    direction: a.direction === "vertical" ? LayoutDirection.VERTICAL : LayoutDirection.HORIZONTAL,
    spacing: a.spacing,
    paddingLeft: a.paddingLeft, paddingTop: a.paddingTop, paddingRight: a.paddingRight, paddingBottom: a.paddingBottom,
    mainAlign: LAYOUT_ALIGN_TO_PB[a.mainAlign], crossAlign: LAYOUT_ALIGN_TO_PB[a.crossAlign],
    hugWidth: a.hugWidth, hugHeight: a.hugHeight,
  };
}

export function toEffectLite(e: PbEffect): EffectLite {
  const k = e.kind;
  if (k.case === "dropShadow") {
    const c = k.value.color;
    return {
      kind: "dropShadow",
      color: { r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 1 },
      offsetX: k.value.offsetX, offsetY: k.value.offsetY, blur: k.value.blur,
    };
  }
  // Un effetto senza `kind` (filo da una versione futura) si legge come una
  // sfocatura nulla: innocua da disegnare e conserva la posizione nella lista.
  return { kind: "layerBlur", radius: k.case === "layerBlur" ? k.value.radius : 0 };
}

function toPbPaint(c: FillLite) {
  const g = c.gradient;
  if (g) {
    const value = {
      stops: g.stops.map((st) => ({ color: { ...st.color }, position: st.position })),
      x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
    };
    return g.kind === "linear"
      ? { kind: { case: "linear" as const, value } }
      : { kind: { case: "radial" as const, value } };
  }
  return { kind: { case: "solid" as const, value: { color: { r: c.r, g: c.g, b: c.b, a: c.a } } } };
}

// Inverso di toInstanceOverrideLite. Ritorna la forma di INIT (non un messaggio
// creato): i chiamanti la annidano dentro `create(...)` di un Node (toPbNode) o
// di un Op (history.invertOp e applyOp non ne hanno bisogno, ma il pen dei
// componenti sì). I flag *_present si ricavano dalla PRESENZA del campo Lite --
// `fills` definito => fills_present, `text` definito => text_present -- così il
// round-trip con toInstanceOverrideLite è LOSSLESS: un override di solo fill
// non guadagna un testo vuoto passando di qui, né perde la distinzione fra
// "fill assente" e "fill svuotato".
export function toPbInstanceOverride(o: InstanceOverrideLite) {
  return {
    masterNodeId: o.masterNodeId,
    fills: o.fills ? toPbFills(o.fills) : [],
    fillsPresent: o.fills !== undefined,
    text: o.text ?? "",
    textPresent: o.text !== undefined,
  };
}

// Un Paint del filo APPIATTITO nel colore che il renderer disegna. Una funzione
// sola per riempimenti e tratti: sono lo stesso messaggio nel proto, e due
// appiattimenti indipendenti divergerebbero al primo paint non-solid (oggi
// l'unico caso è un paint ASSENTE, ma il oneof `kind` esiste per crescere).
function toFillLite(p: PbPaint | undefined): FillLite {
  const k = p?.kind;
  if (k?.case === "linear" || k?.case === "radial") {
    const g = k.value;
    const stops = g.stops.map((st) => ({
      color: { r: st.color?.r ?? 0, g: st.color?.g ?? 0, b: st.color?.b ?? 0, a: st.color?.a ?? 1 },
      position: st.position,
    }));
    const first = stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 };
    return {
      ...first,
      gradient: { kind: k.case, stops, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 },
    };
  }
  const c = k?.case === "solid" ? k.value.color : undefined;
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
// `*opendesignerv1.Node_Rect`), quindi trattarlo diversamente qui sarebbe la
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
    case "instance": return "instance";
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
    ...(n.effects.length > 0 ? { effects: n.effects.map(toEffectLite) } : {}),
    kind,
    cornerRadius: n.shape.case === "rect" ? n.shape.value.cornerRadius : 0,
    clipsContent: n.shape.case === "frame" ? n.shape.value.clipsContent : false,
    ...(n.shape.case === "frame" && n.shape.value.autoLayout ? { autoLayout: toAutoLayoutLite(n.shape.value.autoLayout) } : {}),
    ...(n.shape.case === "text" ? { text: toTextLite(n.shape.value) } : {}),
    ...(n.shape.case === "image" ? { image: { assetHash: n.shape.value.assetHash } } : {}),
    ...(n.shape.case === "vector" ? { vector: toVectorLite(n.shape.value) } : {}),
    ...(n.shape.case === "instance" ? { instance: toInstanceLite(n.shape.value) } : {}),
    // Il ramo sconosciuto viaggia intero e intatto: vedi NodeLite.unknownShape.
    ...(kind === "unknown" ? { unknownShape: n.shape } : {}),
    ...(Object.keys(n.meta).length > 0 ? { meta: { ...n.meta } } : {}),
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
    effects: toPbEffects(n.effects ?? []),
    meta: n.meta ? { ...n.meta } : {},
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
      : n.kind === "instance"
        // Un'istanza: il componentId reso più gli override per nodo del master,
        // ricostruiti con i flag *_present dalla presenza del campo Lite (vedi
        // toPbInstanceOverride). Come per gli altri rami, un `instance` mancante
        // ricade su componentId vuoto e nessun override -- MAI su un rettangolo:
        // un cambio di forma silenzioso dentro un undo di una delete sarebbe
        // molto peggio di un'istanza che punta al vuoto.
        ? { case: "instance" as const, value: {
            componentId: n.instance?.componentId ?? "",
            overrides: (n.instance?.overrides ?? []).map(toPbInstanceOverride),
          } }
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
      ? { case: "frame" as const, value: { clipsContent: n.clipsContent, ...(n.autoLayout ? { autoLayout: toPbAutoLayout(n.autoLayout) } : {}) } }
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

export function toFlowLite(f: PbFlow): FlowLite {
  return { id: f.id, name: f.name, description: f.description, startId: f.startId };
}
export function toTransitionLite(t: PbTransition): TransitionLite {
  return {
    id: t.id, flowId: t.flowId, fromId: t.fromId, toId: t.toId, label: t.label,
    trigger: t.trigger, elementId: t.elementId, guard: t.guard, effect: t.effect,
  };
}
export function toPbFlow(f: FlowLite): PbFlow {
  return create(FlowSchema, { id: f.id, name: f.name, description: f.description, startId: f.startId });
}
export function toPbTransition(t: TransitionLite): PbTransition {
  return create(TransitionSchema, {
    id: t.id, flowId: t.flowId, fromId: t.fromId, toId: t.toId, label: t.label,
    trigger: t.trigger, elementId: t.elementId, guard: t.guard, effect: t.effect,
  });
}

export function toClipLite(c: PbClip): ClipLite {
  return {
    id: c.id, name: c.name, duration: c.duration, trigger: c.trigger, delay: c.delay, repeat: c.repeat, yoyo: c.yoyo,
    targetId: c.targetId,
    tracks: c.tracks.map((t) => ({
      nodeId: t.nodeId, prop: t.prop,
      keyframes: t.keyframes.map((k) => ({ time: k.time, value: k.value, easing: k.easing })),
    })),
  };
}
export function toPbClip(c: ClipLite): PbClip {
  return create(ClipSchema, {
    id: c.id, name: c.name, duration: c.duration, trigger: c.trigger, delay: c.delay, repeat: c.repeat, yoyo: c.yoyo,
    targetId: c.targetId,
    tracks: c.tracks.map((t) => ({
      nodeId: t.nodeId, prop: t.prop,
      keyframes: t.keyframes.map((k) => ({ time: k.time, value: k.value, easing: k.easing })),
    })),
  });
}

export function fromDocument(doc: Document): SceneState {
  const edit = NodeMap.empty.edit();
  for (const [id, n] of Object.entries(doc.nodes)) edit.set(id, toNodeLite(n));
  const nodes = edit.done();
  // I componenti fanno parte del documento quanto i nodi: un master non copiato
  // ma referenziato per rootNodeId (vedi ComponentLite).
  const components: Record<string, ComponentLite> = {};
  for (const [id, c] of Object.entries(doc.components)) components[id] = { rootNodeId: c.rootNodeId, name: c.name };
  return {
    id: doc.id, name: doc.name, schemaVersion: doc.schemaVersion,
    pages: doc.pages.map((p) => ({ id: p.id, name: p.name })), nodes, components,
    flows: Object.fromEntries(Object.entries(doc.flows).map(([id, f]) => [id, toFlowLite(f)])),
    transitions: Object.fromEntries(Object.entries(doc.transitions).map(([id, t]) => [id, toTransitionLite(t)])),
    clips: Object.fromEntries(Object.entries(doc.clips).map(([id, c]) => [id, toClipLite(c)])),
  };
}
