import { usePosedScene } from "../animation/posedScene";
import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  Label, Slider, SliderOutput, SliderStateContext, SliderThumb, SliderTrack,
} from "react-aria-components";
import { useScene } from "../store/store";
import { ALIGN_COMMANDS, alignSelection, minSelection } from "../selection/align";
import type { AlignCommand } from "../selection/align";
import { selectionSummary, MIXED } from "../store/selectors";
import type { Mixed, OrMixed } from "../store/selectors";
import { frameOriginOf } from "../store/groups";
import { instanceOverrideMap } from "../store/instances";
import { subtreeOf } from "../store/tree";
import { makeSetInstanceOverrideOp, makeSetPropsOp, makeSetTextOp } from "../tools/ops";
import { layerDisplayName } from "./LayersPanel";
import { cls, EmptyState, Icon, IconButton, Section } from "./ds";
import type { IconName } from "./ds";
import { SegRadio, type SegOption } from "./ds/props-controls";
import { NumberField } from "./fields/NumberField";
import { ColorField } from "./fields/ColorField";
import { GradientControls } from "./GradientControls";
import { EffectsControls } from "./EffectsControls";
import { AutoLayoutControls, WrapInAutoLayoutButton } from "./AutoLayoutControls";
import type { RgbLite } from "./fields/ColorField";
import { toPbFills, toPbStrokes } from "../store/types";
import type {
  FillLite, InstanceOverrideLite, NodeLite, SceneState,
  StrokeAlignLite, StrokeLite, TextAlignLite, TextStyleLite,
} from "../store/types";
import type { MaskPath } from "../store/maskPaths";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// PANNELLO PROPRIETÀ — geometria (Task 9) + aspetto e stile del testo (Task 10).
//
// Come il pannello livelli (ui/LayersPanel.tsx), obbedisce alla regola dei
// gesti: un op, un gesto -- anche il singolo campo digitato passa da
// beginGesture/endGesture, così resta annullabile con Ctrl+Z e viaggia sul
// filo come qualunque altra modifica. Un TRASCINAMENTO (etichetta di un campo
// numerico, cursore dell'opacità) è UN gesto solo, non uno per pixel: le
// posizioni intermedie sono anteprima locale (applyLocal) e solo il rilascio
// manda l'op finale.

// La chiave che legge NodeLite/SelectionSummary E il path di FieldMask che la
// indirizza sul filo, insieme: aggiungere un campo numerico è aggiungere UNA
// voce qui, non toccare la logica sotto. `minValue` è opzionale e vive qui e
// non nel campo stesso: è una proprietà del CAMPO (larghezza/altezza non hanno
// senso negative), non del widget generico.
interface NumericField {
  key: "x" | "y" | "width" | "height" | "rotation" | "cornerRadius";
  label: string;
  mask: MaskPath;
  minValue?: number;
  // Il simbolo mostrato al posto dell'etichetta, che resta il nome accessibile:
  // vedi NumberField::glyph.
  glyph?: string;
}

// POSIZIONE e DIMENSIONE separate perché un GRUPPO ha la prima e non la
// seconda: un gruppo non ha un box proprio (store/groups.ts) -- la sua cornice
// è l'unione dei figli, e width/height sul nodo restano gli zeri con cui è
// nato. Mostrare W/H su un gruppo non è solo un numero sbagliato: digitarci
// dentro manda un op che ENTRAMBE le implementazioni di apply accettano, che
// non cambia un pixel su canvas, e che costa lo stesso un invio in rete e una
// voce di undo. La rotazione vive in SIZE_FIELDS ("Rot" e non "R", già preso
// dal raggio del rettangolo): la maniglia dà il gesto, il campo dà il numero.
const POSITION_FIELDS: readonly NumericField[] = [
  { key: "x", label: "X", mask: "x" },
  { key: "y", label: "Y", mask: "y" },
];

const SIZE_FIELDS: readonly NumericField[] = [
  { key: "width", label: "W", mask: "width", minValue: 0 },
  { key: "height", label: "H", mask: "height", minValue: 0 },
  { key: "rotation", label: "Rot", mask: "rotation", glyph: "°" },
];

const GEOMETRY_FIELDS: readonly NumericField[] = [...POSITION_FIELDS, ...SIZE_FIELDS];

// "R" come raggio: stessa convenzione a UNA LETTERA di X/Y/W/H, che negli
// editor di design è la norma e tiene la griglia stretta. L'etichetta è anche
// il nome accessibile (vedi NumberField), quindi non c'è un aria-label diverso
// da quello che si legge -- sarebbe una violazione di "label in name".
const CORNER_RADIUS_FIELD: NumericField = {
  key: "cornerRadius", label: "R", mask: "corner_radius", minValue: 0,
};

// Il patch da un valore letterale: uno switch e non un oggetto calcolato con
// una chiave dinamica (`{ [field.key]: value }`) perché il tipo di
// makeSetPropsOp è il MessageInitShape generato da NodeSchema -- una chiave
// dinamica su un'unione lo renderebbe non verificabile a compile-time, ed è
// proprio il controllo che MaskPath (store/maskPaths.ts) esiste per dare.
function patchFor(key: NumericField["key"], value: number) {
  switch (key) {
    case "x":
      return { x: value };
    case "y":
      return { y: value };
    case "width":
      return { width: value };
    case "height":
      return { height: value };
    case "rotation":
      return { rotation: value };
    case "cornerRadius":
      // ANNIDATO dentro il oneof `shape`: "corner_radius" è l'unico path della
      // mask che non indirizza un campo di primo livello del Node (vedi
      // store/maskPaths.ts e core.applySetProps). Il patch deve quindi portare
      // una FORMA, non un campo -- ed è la stessa forma che il nodo ha già,
      // altrimenti Go risponderebbe ErrNotRectNode.
      return { shape: { case: "rect" as const, value: { cornerRadius: value } } };
  }
}

// Il valore da SCRIVERE su x/y di un nodo perché la sua CORNICE finisca dove
// il campo dice.
//
// Per tutto ciò che non è un gruppo il campo È la cornice, e il valore va
// scritto tale e quale (`value` e non `n[key] + (value - n[key])`: la seconda
// forma è algebricamente identica ma non in virgola mobile, e la X digitata
// deve arrivare al modello esatta come è stata scritta).
//
// Per un GRUPPO no: x/y sono la traslazione che contribuisce ai figli, mentre
// la cornice sta dove stanno i figli (store/groups.ts::frameOriginOf). Il campo
// mostra la cornice -- come per ogni altra selezione, e come la disegna
// l'overlay -- quindi qui si traduce lo spostamento richiesto in una nuova
// traslazione. Il DELTA si risolve adesso: l'op che parte resta ASSOLUTO come
// ogni altro setProps, quindi un rebase o un redo non lo applicano due volte.
function positionValueFor(scene: SceneState, n: NodeLite, key: "x" | "y", value: number): number {
  if (n.kind !== "group") return value;
  return n[key] + (value - frameOriginOf(scene, n)[key]);
}

// Op di scrittura di UN campo numerico su OGNI nodo selezionato: come il
// toggle di visibilità e la rinomina del pannello livelli, lo stesso valore
// ASSOLUTO va a tutti i nodi selezionati -- non una traslazione relativa.
// L'unica traduzione è quella di positionValueFor, che porta ogni nodo alla
// stessa POSIZIONE anche quando il suo x/y non è il suo bordo.
function numericOps(ids: readonly string[], field: NumericField, value: number): Op[] {
  const scene = useScene.getState().scene;
  return ids.map((id) => {
    const n = scene?.nodes.at(id);
    const v = scene && n && (field.key === "x" || field.key === "y")
      ? positionValueFor(scene, n, field.key, value)
      : value;
    return makeSetPropsOp(id, patchFor(field.key, v), [field.mask]);
  });
}

function opacityOps(ids: readonly string[], value: number): Op[] {
  return ids.map((id) => makeSetPropsOp(id, { opacity: value }, ["opacity"]));
}

// Op di riempimento. Il colore arriva SENZA alfa (vedi ColorField): l'alfa la
// mette qui ogni nodo dalla PROPRIA tinta, così una selezione con opacità di
// riempimento diverse non se le vede uniformare da un cambio di colore.
//
// E si sostituisce solo la PRIMA tinta: un nodo con più riempimenti non deve
// perdere gli altri perché il pannello ne mostra uno solo.
function fillOps(ids: readonly string[], rgb: RgbLite): Op[] {
  const scene = useScene.getState().scene;
  if (!scene) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n) return [];
    const first = { ...rgb, a: n.fills[0]?.a ?? 1 };
    return [makeSetPropsOp(id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"])];
  });
}

// Il tratto che il pannello mostra e scrive quando un nodo non ne ha nessuno.
// Il peso è 1 e non 0 di proposito: scrivere un COLORE su un nodo senza tratti
// deve produrre qualcosa che si VEDE, altrimenti l'utente sceglie un colore e
// non succede niente. Il centro è il default del canvas 2D (l'unico
// allineamento che sa fare da solo, vedi renderer/canvasRenderer.ts) ed è anche
// quello che StrokeAlign_UNSPECIFIED significa nel modello.
const DEFAULT_STROKE: StrokeLite = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" };

// Il patch che i controlli del tratto emettono. Il COLORE ci sta senza alfa --
// RgbLite e non FillLite -- per la stessa ragione per cui ColorField non la
// porta: l'esadecimale a 6 cifre non la contiene, e l'alfa la rimette ogni nodo
// dal PROPRIO tratto (vedi strokeOps). È un tipo e non un `Partial<StrokeLite>`
// proprio per rendere IMPOSSIBILE far arrivare qui un'alfa presa da altrove.
type StrokePatch = Partial<Omit<StrokeLite, "color">> & { color?: RgbLite };

// Op di TRATTO. Stessa forma di fillOps -- e per le stesse ragioni:
//
//  - si tocca solo il PRIMO tratto e gli altri restano dove sono (il pannello
//    ne mostra uno solo; perdere gli altri sarebbe una modifica che l'utente
//    non ha chiesto e non vede);
//  - il patch parte dal tratto DEL NODO, non da quello riassunto per il
//    pannello: in una selezione mista, cambiare lo spessore non deve uniformare
//    anche colore e posizione -- e cambiare il COLORE non deve uniformare
//    l'alfa, che viene rimessa qui dal tratto di ciascun nodo;
//  - un nodo senza tratti parte da DEFAULT_STROKE, cioè scrivere un qualunque
//    campo CREA il tratto.
//
// La mask è `strokes` e sostituisce l'INTERA lista (vedi store/applyOp.ts e
// core.applySetProps): per questo la lista va ricostruita per intero, non
// "modificata".
function strokeOps(ids: readonly string[], patch: StrokePatch): Op[] {
  const scene = useScene.getState().scene;
  if (!scene) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n) return [];
    const base = n.strokes[0] ?? DEFAULT_STROKE;
    // L'alfa del tratto DI QUESTO NODO, risolta nodo per nodo dentro il ciclo:
    // leggerla dal riassunto della selezione la azzererebbe a 1 ogni volta che
    // i nodi differiscono (il riassunto in quel caso è MIXED, cioè nessun
    // valore), cioè proprio quando conta.
    const color: FillLite = patch.color ? { ...patch.color, a: base.color.a } : base.color;
    const first: StrokeLite = { ...base, ...patch, color };
    return [makeSetPropsOp(id, { strokes: toPbStrokes([first, ...n.strokes.slice(1)]) }, ["strokes"])];
  });
}

// Op di STILE del testo. SetText e non un path della mask: il contenuto e lo
// stile vivono DENTRO il oneof `shape` del Node (vedi core.applySetText).
//
// Il contenuto viaggia INVARIATO ma viaggia: applySetText lo scrive sempre, e
// ometterlo cancellerebbe il testo. Lo stile parte da quello del NODO e non da
// quello riassunto per il pannello: in una selezione mista, cambiare la
// dimensione non deve uniformare anche peso e allineamento.
function textStyleOps(ids: readonly string[], patch: Partial<TextStyleLite>): Op[] {
  const scene = useScene.getState().scene;
  if (!scene) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || n.kind !== "text" || !n.text) return [];
    return [makeSetTextOp(id, n.text.content, { ...n.text.style, ...patch })];
  });
}

// Riassunto dello STILE della selezione, per gli stessi motivi (e con la stessa
// semantica MIXED) di selectors.ts::selectionSummary. Sta qui e non lì perché
// riguarda solo i nodi testo: infilarlo in SelectionSummary vorrebbe dire
// calcolarlo per ogni selezione, testo o no.
interface TextStyleSummary {
  fontSize: OrMixed<number>;
  fontWeight: OrMixed<string>;
  align: OrMixed<TextAlignLite>;
}

function summarizeStyle<T>(styles: readonly TextStyleLite[], get: (s: TextStyleLite) => T): OrMixed<T> {
  const value = get(styles[0]);
  for (let i = 1; i < styles.length; i++) if (!Object.is(get(styles[i]), value)) return MIXED;
  return value;
}

// null se anche un solo nodo selezionato non è un testo: i controlli di stile
// non compaiono affatto in quel caso.
function textStyleSummary(nodes: readonly NodeLite[]): TextStyleSummary | null {
  const styles = nodes.map((n) => n.text?.style).filter((s): s is TextStyleLite => s !== undefined);
  if (styles.length === 0 || styles.length !== nodes.length) return null;
  return {
    fontSize: summarizeStyle(styles, (s) => s.fontSize),
    fontWeight: summarizeStyle(styles, (s) => s.fontWeight),
    align: summarizeStyle(styles, (s) => s.align),
  };
}

// I due soli pesi che il pannello offre in M1b. Il modello ne accetta qualunque
// stringa (TextStyle.font_weight è un string, "400" | "700" | ...): un nodo con
// un peso fuori da questo elenco lascia semplicemente il gruppo senza nessuna
// scelta selezionata, che è più onesto che arrotondarlo al più vicino.
const FONT_WEIGHTS: readonly SegOption<string>[] = [
  { value: "400", label: "Normale" },
  { value: "700", label: "Grassetto" },
];

const ALIGNMENTS: readonly SegOption<TextAlignLite>[] = [
  { value: "left", label: "Sinistra", icon: "textLeft" },
  { value: "center", label: "Centro", icon: "textCenter" },
  { value: "right", label: "Destra", icon: "textRight" },
];

// La POSIZIONE del tratto rispetto al perimetro. Il gruppo si chiama
// "Posizione" e non "Allineamento" apposta: su un nodo TESTO con un tratto i
// due gruppi convivono nel pannello, e l'etichetta è anche il nome accessibile
// -- due gruppi omonimi sarebbero indistinguibili per chi naviga a voce.
const STROKE_ALIGNMENTS: readonly SegOption<StrokeAlignLite>[] = [
  { value: "inside", label: "Interno" },
  { value: "center", label: "Centro" },
  { value: "outside", label: "Esterno" },
];

// L'intestazione dell'ispettore: icona e nome italiano del TIPO di nodo.
const KIND_ICON: Record<NodeLite["kind"], IconName> = {
  rect: "rect", ellipse: "ellipse", text: "text", image: "image", vector: "pen",
  unknown: "rect", group: "layers", frame: "frame", instance: "components",
};
const KIND_LABEL: Record<NodeLite["kind"], string> = {
  rect: "Rettangolo", ellipse: "Ellisse", text: "Testo", image: "Immagine", vector: "Vettore",
  unknown: "Elemento", group: "Gruppo", frame: "Frame", instance: "Istanza",
};

// Un valore riassunto pronto per un RadioGroup CONTROLLATO: null (e non
// undefined) per MIXED, così il gruppo resta controllato e mostra semplicemente
// nessuna scelta -- stessa ragione per cui NumberField usa NaN invece di
// undefined.
function radioValue<T extends string>(v: OrMixed<T>): T | null {
  return v === MIXED ? null : (v as T);
}

// L'opacità è un float 0..1 nel modello e una percentuale per chi la legge: la
// conversione la fa Intl, dentro lo stato del cursore, una volta sola -- e la
// stessa stringa serve poi sia il testo mostrato sia il valore annunciato.
// Costante di modulo e non un letterale inline: `useNumberFormatter` memoizza
// sull'IDENTITÀ dell'oggetto, e un letterale nuovo a ogni render
// ricostruirebbe l'Intl.NumberFormat a ogni frame di trascinamento.
const PERCENT_FORMAT: Intl.NumberFormatOptions = { style: "percent" };

// L'UNICA parola con cui il pannello dice "questa selezione non ha un valore
// solo" su un cursore.
const MIXED_LABEL = "Misto";

// Il valore del cursore: quello che si LEGGE e quello che si SENTE, dalla
// stessa variabile.
//
// I campi di testo e di colore, su MIXED, si mostrano VUOTI: "nessun valore
// singolo" si disegna come niente. Un cursore non può -- una posizione ce l'ha
// per forza, e il suo valore accessibile è un NUMERO: react-aria mette
// `aria-valuetext` sull'`<input type=range>` prendendolo dallo stato, quindi il
// valore di ripiego che serve a dare una posizione (1, cioè "100%") verrebbe
// anche ANNUNCIATO come se fosse quello vero. Uno screen reader leggerebbe
// "100%" su una selezione che un'opacità sola non ce l'ha.
//
// Il rimedio è possedere l'attributo: `inputRef` è la prop pubblica con cui
// RAC dà accesso proprio a quell'input. Si scrive a OGNI render, senza array
// di dipendenze: fuori da MIXED si riscrive quello che RAC aveva già calcolato
// (`getThumbValueLabel`, cioè la stessa percentuale del testo mostrato), così
// non resta mai un "Misto" appeso quando il valore torna a esistere -- React
// non riscriverebbe un attributo il cui valore di partenza non è cambiato.
// useLayoutEffect e non useEffect: l'attributo è a posto prima che il browser
// dipinga, non un frame dopo.
function SliderValueText({
  inputRef, mixed, className,
}: { inputRef: RefObject<HTMLInputElement | null>; mixed: boolean; className: string }) {
  const state = useContext(SliderStateContext);
  const text = mixed ? MIXED_LABEL : (state?.getThumbValueLabel(0) ?? "");
  useLayoutEffect(() => {
    inputRef.current?.setAttribute("aria-valuetext", text);
  });
  return <SliderOutput className={className}>{text}</SliderOutput>;
}

// Il binario e la pastiglia del cursore dell'opacità, con il loro stato VUOTO:
// su `data-mixed` (messo sul track, che è il `group`) perdono riempimento e
// bordo pieno e restano un tratteggio, perché non c'è nessun valore da
// indicare. La pastiglia però resta lì -- focalizzabile, trascinabile e con il
// suo anello di focus.
const SLIDER_RAIL_CLASS =
  "absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-3 " +
  "group-data-[mixed]:border group-data-[mixed]:border-dashed " +
  "group-data-[mixed]:border-line-strong group-data-[mixed]:bg-transparent";

// La parte PIENA del binario, da sinistra fino alla pastiglia.
const SLIDER_FILL_CLASS =
  "absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent group-data-[mixed]:hidden";

const SLIDER_THUMB_CLASS =
  "top-1/2 size-3.5 rounded-full border-2 border-accent bg-surface shadow-sm outline-none " +
  "group-data-[mixed]:border-transparent group-data-[mixed]:bg-transparent group-data-[mixed]:shadow-none " +
  "data-[focus-visible]:shadow-[var(--ring)]";

// --- ALLINEAMENTO -----------------------------------------------------------
//
// I pulsanti sono ICONE, come in ogni editor: otto etichette scritte per esteso
// occuperebbero mezzo pannello e si leggerebbero peggio di un pittogramma. Il
// NOME resta però quello per esteso (`aria-label`, dall'elenco ALIGN_COMMANDS)
// -- è l'unica cosa che uno screen reader legge, ed è anche il testo del
// tooltip: la stessa stringa nei due canali, mai due formulazioni diverse.
//
// Le icone sono disegnate qui e non importate: sono otto rettangoli su una
// griglia di 24, e una dipendenza per questo sarebbe più codice, non meno.
// `RULE`/`BAR` descrivono le due parti di ogni segno -- la riga su cui si
// allinea e i due blocchi che ci si appoggiano.
const RULE = "fill-fg-subtle";
const BAR = "fill-current";

// I rettangoli di ogni icona, in coordinate SVG 0..24. Per gli allineamenti:
// la riga (spessa 1.5) più due blocchi di lunghezza diversa appoggiati a lei --
// due blocchi uguali non mostrerebbero da quale lato si allineano. Per le
// distribuzioni: tre blocchi a distanza uguale, che è ciò che il comando fa.
const ICONS: Record<AlignCommand, { x: number; y: number; w: number; h: number; rule?: boolean }[]> = {
  left: [
    { x: 2, y: 3, w: 1.5, h: 18, rule: true },
    { x: 5, y: 6, w: 14, h: 4 }, { x: 5, y: 14, w: 9, h: 4 },
  ],
  hcenter: [
    { x: 11.25, y: 3, w: 1.5, h: 18, rule: true },
    { x: 5, y: 6, w: 14, h: 4 }, { x: 7.5, y: 14, w: 9, h: 4 },
  ],
  right: [
    { x: 20.5, y: 3, w: 1.5, h: 18, rule: true },
    { x: 5, y: 6, w: 14, h: 4 }, { x: 10, y: 14, w: 9, h: 4 },
  ],
  "distribute-h": [
    { x: 3, y: 4, w: 3, h: 16 }, { x: 10.5, y: 4, w: 3, h: 16 }, { x: 18, y: 4, w: 3, h: 16 },
  ],
  top: [
    { x: 3, y: 2, w: 18, h: 1.5, rule: true },
    { x: 6, y: 5, w: 4, h: 14 }, { x: 14, y: 5, w: 4, h: 9 },
  ],
  middle: [
    { x: 3, y: 11.25, w: 18, h: 1.5, rule: true },
    { x: 6, y: 5, w: 4, h: 14 }, { x: 14, y: 7.5, w: 4, h: 9 },
  ],
  bottom: [
    { x: 3, y: 20.5, w: 18, h: 1.5, rule: true },
    { x: 6, y: 5, w: 4, h: 14 }, { x: 14, y: 10, w: 4, h: 9 },
  ],
  "distribute-v": [
    { x: 4, y: 3, w: 16, h: 3 }, { x: 4, y: 10.5, w: 16, h: 3 }, { x: 4, y: 18, w: 16, h: 3 },
  ],
};

// `aria-hidden`: il pittogramma non aggiunge niente al nome del pulsante, che
// arriva già da aria-label. Senza, uno screen reader annuncerebbe un "image"
// senza nome accanto all'etichetta buona.
function AlignIcon({ id }: { id: AlignCommand }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      {ICONS[id].map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.rule ? 0.75 : 1} className={r.rule ? RULE : BAR} />
      ))}
    </svg>
  );
}

const ALIGN_BUTTON_CLASS =
  "flex h-7 flex-1 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-3 hover:text-fg " +
  "focus-visible:shadow-[var(--ring)] " +
  // Disabilitato: si SPEGNE (niente sfondo all'hover, pittogramma sbiadito),
  // che è il segno che dice "non c'è abbastanza selezione per questo comando".
  "disabled:opacity-40 disabled:hover:bg-transparent";

// --- OVERRIDE DELLE ISTANZE (M4) --------------------------------------------
//
// Quando la selezione è UNA sola istanza, il pannello mostra una sezione
// "Override": una riga per ogni nodo del MASTER che sia un testo o abbia un
// riempimento (sottoalbero da components[componentId].rootNodeId, in
// pre-ordine). Ogni riga mostra il valore EFFETTIVO -- l'override dell'istanza
// per quel nodo del master se c'è, altrimenti il valore proprio del nodo del
// master -- e scriverci emette UN SetInstanceOverride.
//
// Le due metà dell'override (fills e text) sono INDIPENDENTI: modificare una
// conserva l'altra così com'era (vedi InstanceOverrideLite), altrimenti un
// override di solo testo azzererebbe il fill ereditato. Il "Ripristina" emette
// un override VUOTO, che per il reducer è la RIMOZIONE (il nodo torna a
// ereditare dal master).

// Campo di testo per il contenuto di un nodo testo del master. Gemello (più
// semplice) di RenameField/PageRenameField: la sessione ha uno stato suo (il
// testo digitato) che riparte quando il valore cambia dall'esterno -- commit
// andato a buon fine, o cambio di selezione. Conferma su Invio o blur, una
// volta sola.
function OverrideTextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  useEffect(() => {
    setDraft(value);
    done.current = false;
  }, [value]);
  function settle() {
    if (done.current) return;
    done.current = true;
    // Niente op se il testo non è cambiato: un override "che non cambia niente"
    // costerebbe un giro di rete e una voce di undo a vuoto.
    if (draft !== value) onCommit(draft);
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[11px] font-medium text-fg-subtle">{label}</span>
      <input
        aria-label={label}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={settle}
        onKeyDown={(e) => {
          // Nessun tasto esce da qui: le scorciatoie globali (undo/redo su
          // window, Escape/Canc su toolManager) non devono agire mentre si
          // scrive -- stesso stop di LayersPanel/PageBar::RenameField.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            settle();
          }
        }}
        className={cls.input}
      />
    </div>
  );
}

export function PropertiesPanel() {
  // I valori che il pannello mostra sono quelli che si vedono: con la timeline in
  // posa (si scorre, si registra) sono i valori campionati. A timeline ferma è la
  // scena dello store, la stessa istanza di prima (animation/posedScene.ts).
  const scene = usePosedScene();
  const selection = useScene((s) => s.selection);
  const summary = scene ? selectionSummary(scene, selection) : null;
  const nodes = scene ? selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined) : [];
  const style = summary?.kind === "text" ? textStyleSummary(nodes) : null;
  // L'input nascosto del cursore dell'opacità: SliderValueText gli scrive il
  // valore ANNUNCIATO. Sta qui, prima di ogni ritorno anticipato, perché è un
  // hook.
  const opacityInputRef = useRef<HTMLInputElement>(null);

  // Digitare + confermare (Invio o blur, dentro NumberField): UN gesto i cui
  // op finali assegnano lo stesso valore a ogni nodo selezionato -- una sola
  // voce di undo anche per una selezione multipla.
  function commit(field: NumericField, value: number) {
    const store = useScene.getState();
    const ids = store.selection;
    if (ids.length === 0) return;
    store.beginGesture();
    store.endGesture(numericOps(ids, field, value));
  }

  // Trascinamento dell'etichetta: la PRIMA chiamata apre il gesto (pigro,
  // come dragStarted in tools/selectTool.ts -- un click che NumberField non
  // ha promosso a trascinamento non arriva mai qui), le successive sono solo
  // anteprima locale -- niente sul filo finché il puntatore non si rilascia.
  function scrub(field: NumericField, value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of numericOps(store.selection, field, value)) store.applyLocal(op);
  }

  // Rilascio del trascinamento: chiude lo STESSO gesto aperto da scrub con
  // gli op FINALI -- stessa forma di selectTool.ts::onPointerUp per il drag
  // di spostamento (un solo invio, non uno per pixel di anteprima).
  function scrubEnd(field: NumericField, value: number) {
    const store = useScene.getState();
    if (!store.gesture) return; // scrub non partito (selezione svuotata a metà drag)
    store.endGesture(numericOps(store.selection, field, value));
  }

  // Un gesto intero da una singola conferma (colore, peso, allineamento):
  // stessa forma del toggle di visibilità di ui/LayersPanel.tsx.
  function runGesture(build: (ids: readonly string[]) => Op[]) {
    const store = useScene.getState();
    const ids = store.selection;
    if (ids.length === 0) return;
    const ops = build(ids);
    if (ops.length === 0) return;
    store.beginGesture();
    store.endGesture(ops);
  }

  // --- OVERRIDE (M4) --------------------------------------------------------
  // Gli handler rileggono l'istanza FRESCA dallo store: un op nel frattempo
  // (o un record remoto) può averla cambiata, e la closure di render sarebbe
  // vecchia. null se la selezione non è più esattamente un'istanza.
  function currentInstance(): NodeLite | null {
    const store = useScene.getState();
    const s = store.scene;
    if (!s || store.selection.length !== 1) return null;
    const n = s.nodes.at(store.selection[0]);
    return n && n.kind === "instance" && n.instance ? n : null;
  }

  // Un override = UN gesto, come ogni altra scrittura del pannello.
  function commitOverride(inst: NodeLite, override: InstanceOverrideLite) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetInstanceOverrideOp(inst.id, override)]);
  }

  // Modifica il RIEMPIMENTO effettivo di un nodo del master. Parte dai fills
  // effettivi (override se c'è, altrimenti quelli del master) e ne sostituisce
  // solo il PRIMO, tenendo alfa e resto della lista -- come fillOps per i nodi
  // veri. Conserva il testo dell'override se c'era.
  function editOverrideFill(masterNodeId: string, rgb: RgbLite) {
    const store = useScene.getState();
    const s = store.scene;
    const inst = currentInstance();
    if (!s || !inst) return;
    const master = s.nodes.at(masterNodeId);
    if (!master) return;
    const existing = instanceOverrideMap(inst).get(masterNodeId);
    const effFills = existing?.fills ?? master.fills;
    const first: FillLite = { ...rgb, a: effFills[0]?.a ?? 1 };
    const override: InstanceOverrideLite = { masterNodeId, fills: [first, ...effFills.slice(1)] };
    if (existing?.text !== undefined) override.text = existing.text;
    commitOverride(inst, override);
  }

  // Modifica il CONTENUTO effettivo di un nodo testo del master. Conserva i
  // fills dell'override se c'erano.
  function editOverrideText(masterNodeId: string, text: string) {
    const inst = currentInstance();
    if (!inst) return;
    const existing = instanceOverrideMap(inst).get(masterNodeId);
    const override: InstanceOverrideLite = { masterNodeId, text };
    if (existing?.fills !== undefined) override.fills = existing.fills;
    commitOverride(inst, override);
  }

  // Ripristina un nodo del master: override VUOTO = rimozione (torna a ereditare).
  function resetOverride(masterNodeId: string) {
    const inst = currentInstance();
    if (!inst) return;
    commitOverride(inst, { masterNodeId });
  }

  // OPACITÀ. Il cursore di react-aria-components distingue da sé le due fasi
  // che servono: onChange a ogni passo del trascinamento (anteprima) e
  // onChangeEnd al rilascio (valore finale) -- gli stessi due canali che
  // NumberField chiama onScrub/onScrubEnd. Il gesto si apre PIGRO sul primo
  // onChange, così un click sul cursore che non lo muove non ne apre nessuno.
  function scrubOpacity(value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of opacityOps(store.selection, value)) store.applyLocal(op);
  }

  function scrubOpacityEnd(value: number) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(opacityOps(store.selection, value));
  }

  // Le stesse due fasi per lo SPESSORE del tratto: si trascina come ogni altro
  // campo numerico, ma l'op ricostruisce la lista dei tratti invece di scrivere
  // un campo (vedi strokeOps).
  function scrubStroke(patch: StrokePatch) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of strokeOps(store.selection, patch)) store.applyLocal(op);
  }

  function scrubStrokeEnd(patch: StrokePatch) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(strokeOps(store.selection, patch));
  }

  // Le stesse due fasi per la DIMENSIONE del testo, che si trascina come ogni
  // altro campo numerico ma emette SetText invece di SetProperties.
  function scrubTextStyle(patch: Partial<TextStyleLite>) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of textStyleOps(store.selection, patch)) store.applyLocal(op);
  }

  function scrubTextStyleEnd(patch: Partial<TextStyleLite>) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(textStyleOps(store.selection, patch));
  }

  if (!summary) {
    return (
      <div className="flex h-full flex-col bg-surface text-[13px] text-fg">
        {/* Il titolo resta anche a vuoto: dice DOVE si è, come l'intestazione
            degli altri pannelli, quando non c'è nessun nome da mostrare. */}
        <header className="flex h-12 shrink-0 items-center border-b border-line px-3">
          <h2 className={cls.sectionTitle}>Proprietà</h2>
        </header>
        <EmptyState
          icon="select"
          title="Nessuna selezione"
          hint="Seleziona un elemento sul canvas o nei livelli per leggerne e modificarne le proprietà."
        />
      </div>
    );
  }

  const opacity: number | Mixed = summary.opacity;
  const fill = summary.fills === MIXED ? null : (summary.fills[0] ?? null);
  // Il PRIMO tratto della selezione, o null se non c'è un valore solo da
  // mostrare (selezione mista). Un nodo senza tratti non è "misto": è un tratto
  // che non c'è, e si legge come colore vuoto + spessore 0 + posizione al
  // centro -- lo stato da cui scrivere un campo qualunque ne crea uno.
  const stroke = summary.strokes === MIXED ? null : (summary.strokes[0] ?? null);
  const strokesMixed = summary.strokes === MIXED;

  // W/H spariscono appena UN nodo selezionato è un gruppo, non solo quando lo
  // sono tutti (`summary.kind === "group"`): il campo scrive lo stesso valore
  // su OGNI nodo della selezione, quindi in una selezione mista l'op arriverebbe
  // al gruppo comunque. E il numero mostrato sarebbe già una bugia -- gli zeri
  // del gruppo entrano nel riassunto e lo rendono "Misto" anche quando ogni
  // forma vera ha la stessa larghezza.
  //
  // X/Y invece RESTANO, e per un gruppo significano quello che significano per
  // tutti gli altri: l'angolo alto-sinistra della cornice (vedi
  // selectionSummary e positionValueFor).
  const geometryFields = nodes.some((n) => n.kind === "group") ? POSITION_FIELDS : GEOMETRY_FIELDS;

  // La sezione Override compare solo per UNA sola istanza selezionata. Le sue
  // righe sono i nodi del MASTER (sottoalbero dalla radice del componente, in
  // pre-ordine) che siano un testo o abbiano un riempimento -- gli unici
  // sovrascrivibili in M4. `overrideMap` indicizza gli override correnti
  // dell'istanza per masterNodeId, per leggere il valore effettivo di ogni riga.
  const instanceNode = nodes.length === 1 && nodes[0].kind === "instance" && nodes[0].instance ? nodes[0] : null;
  const overrideMap = instanceNode ? instanceOverrideMap(instanceNode) : new Map<string, InstanceOverrideLite>();
  const master = instanceNode && scene ? scene.components[instanceNode.instance!.componentId] : undefined;
  const overrideRows: NodeLite[] =
    master && scene ? subtreeOf(scene, master.rootNodeId).filter((n) => n.kind === "text" || n.fills.length > 0) : [];

  // L'intestazione: CHI è selezionato. Un nodo solo = il suo nome e il suo tipo;
  // più nodi = il conteggio e il tipo comune (se c'è).
  const headerIcon: IconName = summary.kind === MIXED || nodes.length > 1 ? "layers" : KIND_ICON[summary.kind];
  const headerTitle = nodes.length === 1 ? layerDisplayName(nodes[0]) : `${nodes.length} elementi`;
  const headerHint =
    nodes.length > 1
      ? (summary.kind === MIXED ? "Selezione multipla" : `Selezione multipla · ${KIND_LABEL[summary.kind]}`)
      : (summary.kind === MIXED ? "" : KIND_LABEL[summary.kind]);

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface text-[13px] text-fg">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon name={headerIcon} size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight">{headerTitle}</p>
          {headerHint && <p className="truncate text-[11px] leading-tight text-fg-subtle">{headerHint}</p>}
        </div>
      </header>

      {/* ALLINEAMENTO. Sta con la geometria (è geometria: sposta x/y e
          nient'altro) e prima dell'aspetto. Ogni pulsante è UN gesto, quindi UNA
          voce di undo, anche quando muove dieci nodi -- vedi
          selection/align.ts::alignSelection. Il riferimento è SEMPRE il riquadro
          comune della selezione: non esiste nessuna pagina contro cui allineare
          (vedi il commento su alignTarget). Una barra sola, con un filo fra le
          quattro orizzontali e le quattro verticali. */}
      {/* Con UN solo nodo ogni comando è disabilitato (il riferimento è il
          riquadro comune della selezione): la barra compare da due nodi in su e
          a riposo non ruba 40px all'ispettore. */}
      {selection.length >= 2 && (
      <div role="group" aria-label="Allinea" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        {ALIGN_COMMANDS.map((c, i) => (
          <Fragment key={c.id}>
            {i === 4 && <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-line" />}
            {/* <button> nativo e non il Button di react-aria (che qui non porta
                niente in più e non accetta `title`): per un pittogramma il
                tooltip è l'unico modo che un utente VEDENTE ha di leggere il
                nome del comando, e deve essere lo STESSO testo del nome
                accessibile -- altrimenti sono due interfacce.

                DISABILITATO sotto il minimo di nodi che il comando richiede
                (due per allineare, tre per distribuire): sotto quella soglia il
                riquadro comune coincide con la selezione e non c'è niente da
                fare. Un pulsante vivo che non fa niente non si distingue da uno
                rotto. */}
            <button
              type="button"
              aria-label={c.label}
              title={c.label}
              disabled={selection.length < minSelection(c.id)}
              className={ALIGN_BUTTON_CLASS}
              onClick={() => alignSelection(c.id)}
            >
              <AlignIcon id={c.id} />
            </button>
          </Fragment>
        ))}
      </div>
      )}

      {/* LAYOUT: posizione, dimensione, rotazione e (rettangoli) raggio, in una
          griglia a due colonne di campi con il prefisso DENTRO (X, Y, W, H, °, R). */}
      <Section title="Layout">
        <div className="grid grid-cols-2 gap-1.5">
          {geometryFields.map((field) => (
            <NumberField
              key={field.key}
              label={field.label}
              glyph={field.glyph}
              minValue={field.minValue}
              // MIXED (selezione multipla con valori diversi) diventa NaN:
              // NumberField lo mostra vuoto e non ne fa un cambio di
              // controllato/non controllato (vedi il commento sulla sua
              // prop `value`). Il placeholder "Misto" ci va SOLO in quel caso:
              // un campo vuoto senza altro contesto sembrerebbe svuotato per
              // sbaglio, non "questi nodi differiscono".
              value={summary[field.key] === MIXED ? NaN : (summary[field.key] as number)}
              placeholder={summary[field.key] === MIXED ? MIXED_LABEL : undefined}
              onCommit={(v) => commit(field, v)}
              onScrub={(v) => scrub(field, v)}
              onScrubEnd={(v) => scrubEnd(field, v)}
            />
          ))}
          {/* SOLO per i rettangoli: corner_radius vive dentro RectNode, e su
              un'ellisse o un testo l'op verrebbe rifiutato da entrambe le
              implementazioni di apply (ErrNotRectNode). Una selezione MISTA ha
              kind === MIXED, quindi non mostra il campo -- non c'è un raggio da
              scrivere che valga per tutti. */}
          {summary.kind === "rect" && (
            <NumberField
              label={CORNER_RADIUS_FIELD.label}
              minValue={CORNER_RADIUS_FIELD.minValue}
              value={summary.cornerRadius === MIXED ? NaN : (summary.cornerRadius as number)}
              placeholder={summary.cornerRadius === MIXED ? MIXED_LABEL : undefined}
              onCommit={(v) => commit(CORNER_RADIUS_FIELD, v)}
              onScrub={(v) => scrub(CORNER_RADIUS_FIELD, v)}
              onScrubEnd={(v) => scrubEnd(CORNER_RADIUS_FIELD, v)}
            />
          )}
        </div>
      </Section>

      {/* L'AUTO LAYOUT: per un frame, i suoi controlli; per qualunque altra
          selezione, il "+" che la avvolge in un frame con auto layout. */}
      {summary.kind === "frame" ? <AutoLayoutControls run={runGesture} /> : <WrapInAutoLayoutButton />}

      <Section title="Aspetto">
        <Slider
          // Su MIXED il numero qui sotto è solo il PUNTO DI PARTENZA di
          // tastiera e trascinamento: non viene disegnato (il cursore si mostra
          // vuoto, vedi data-mixed) e non viene annunciato (vedi
          // SliderValueText). Il cursore resta usabile -- muoverlo assegna la
          // stessa opacità a tutta la selezione, esattamente come un campo
          // geometrico misto accetta un valore digitato -- e appena un valore
          // c'è, "misto" sparisce da entrambi i canali.
          value={opacity === MIXED ? 1 : opacity}
          minValue={0}
          maxValue={1}
          // 1% è il passo con cui l'opacità si legge in percentuale intera;
          // niente arrotondamenti invisibili sotto quella soglia.
          step={0.01}
          // La percentuale la formatta lo STATO, non il pannello: è la stessa
          // stringa che finisce nel testo mostrato e in `aria-valuetext`. Con
          // il calcolo a mano di prima si vedeva "40%" e si annunciava "0.4".
          formatOptions={PERCENT_FORMAT}
          onChange={scrubOpacity}
          onChangeEnd={scrubOpacityEnd}
          // Una riga incassata come i campi numerici: etichetta, cursore, valore.
          className="flex h-7 items-center gap-2 rounded-md bg-surface-2 pl-2 pr-1.5"
        >
          <Label className="w-12 shrink-0 select-none text-[11px] font-medium text-fg-subtle">Opacità</Label>
          <SliderTrack
            // "Misto" è uno STATO del controllo, non solo un testo: sta nel DOM
            // sul track (che contiene sia il binario sia la pastiglia) e di lì
            // il CSS li svuota entrambi. Un attributo e non due className
            // calcolate: la stessa forma dei `data-*` che RAC stessa espone
            // (data-selected, data-focus-visible).
            data-mixed={opacity === MIXED || undefined}
            className="group relative h-4 min-w-0 flex-1"
          >
            {({ state }) => (
              <>
                {/* Il binario disegnato è un figlio del track e non il track
                    stesso: il track deve restare alto abbastanza da essere
                    afferrabile col dito, la riga colorata sottile abbastanza da
                    leggersi come un cursore. La parte piena arriva alla
                    pastiglia. */}
                <div className={SLIDER_RAIL_CLASS} />
                <div className={SLIDER_FILL_CLASS} style={{ width: `${state.getThumbPercent(0) * 100}%` }} />
                <SliderThumb inputRef={opacityInputRef} className={SLIDER_THUMB_CLASS} />
              </>
            )}
          </SliderTrack>
          <SliderValueText
            inputRef={opacityInputRef}
            mixed={opacity === MIXED}
            className="w-10 shrink-0 text-right text-[12px] tabular-nums text-fg-muted"
          />
        </Slider>
      </Section>

      {/* Per i nodi testo il pannello mostra i controlli di stile: sono
          l'equivalente del raggio per un rettangolo -- le proprietà che quel
          tipo di nodo ha e gli altri no. Emettono SetText (con style_present),
          non SetProperties: lo stile vive dentro il oneof `shape`. */}
      {style && (
        <Section title="Testo">
          <div className="flex flex-col gap-2">
            <NumberField
              label="Dimensione"
              minValue={1}
              value={style.fontSize === MIXED ? NaN : (style.fontSize as number)}
              placeholder={style.fontSize === MIXED ? MIXED_LABEL : undefined}
              onCommit={(v) => runGesture((ids) => textStyleOps(ids, { fontSize: v }))}
              onScrub={(v) => scrubTextStyle({ fontSize: v })}
              onScrubEnd={(v) => scrubTextStyleEnd({ fontSize: v })}
            />
            <SegRadio
              label="Peso" showLabel={false}
              value={radioValue(style.fontWeight)}
              options={FONT_WEIGHTS}
              onChange={(v) => runGesture((ids) => textStyleOps(ids, { fontWeight: v }))}
            />
            <SegRadio
              label="Allineamento" showLabel={false}
              value={radioValue(style.align)}
              options={ALIGNMENTS}
              // Il cast è sicuro per costruzione: gli unici valori nel gruppo
              // sono quelli di ALIGNMENTS, che è tipizzato TextAlignLite.
              onChange={(v) => runGesture((ids) => textStyleOps(ids, { align: v as TextAlignLite }))}
            />
          </div>
        </Section>
      )}

      {/* IL RIEMPIMENTO: il tipo (solido / lineare / radiale) e sotto il colore,
          o l'anteprima del gradiente con i suoi estremi. */}
      <Section title="Riempimento">
        {summary.fills !== MIXED ? (
          <GradientControls
            fill={fill}
            run={runGesture}
            // Con un gradiente il colore singolo non esiste: lo scrivere
            // appiattirebbe il gradiente senza che l'utente l'abbia chiesto. Gli
            // stop si editano in GradientControls.
            solid={
              <ColorField
                label="Riempimento"
                // Nodo senza tinte: null, cioè "nessun valore singolo da
                // mostrare". Scrivere un colore da lì resta possibile e lo
                // assegna a tutta la selezione, come per i campi geometrici.
                value={fill}
                placeholder="Nessuno"
                onCommit={(rgb) => runGesture((ids) => fillOps(ids, rgb))}
              />
            }
          />
        ) : (
          <ColorField
            label="Riempimento"
            // MIXED: nessun valore singolo da mostrare, ma scrivere un colore
            // resta possibile.
            value={null}
            placeholder={MIXED_LABEL}
            onCommit={(rgb) => runGesture((ids) => fillOps(ids, rgb))}
          />
        )}
      </Section>

      {/* IL TRATTO. Sezione propria e non dentro "Aspetto": sono tre controlli
          che descrivono UNA cosa sola (il tratto del nodo), e mescolarli al
          riempimento renderebbe ambiguo a quale delle due il colore appartiene.
          Vale per OGNI forma -- `strokes` è un campo di primo livello del Node,
          non un campo dentro il oneof `shape` come corner_radius -- quindi la
          sezione c'è sempre, testo compreso. */}
      <Section title="Tratto">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_7.5rem] gap-1.5">
            <ColorField
              label="Tratto"
              // Come il riempimento: null su MIXED o su "nessun tratto". Scrivere
              // un colore resta possibile in entrambi i casi -- ed è il modo in
              // cui un tratto si CREA (vedi DEFAULT_STROKE).
              value={stroke?.color ?? null}
              placeholder={strokesMixed ? MIXED_LABEL : "Nessuno"}
              // Il colore va giù NUDO, senza alfa: la rimette strokeOps
              // prendendola dal tratto di ciascun nodo, esattamente come
              // fillOps. Comporla qui da `stroke` la leggerebbe dal RIASSUNTO
              // della selezione -- che su tratti diversi è null -- e
              // riscriverebbe 1 su tutti.
              onCommit={(rgb) => runGesture((ids) => strokeOps(ids, { color: rgb }))}
            />
            <NumberField
              label="Spessore"
              // Nessun tratto = spessore 0, e 0 resta scrivibile: è il modo di
              // spegnere un tratto senza toglierlo dalla lista (peso non
              // positivo = niente disegnato e nessuna sporgenza nei bounds,
              // vedi canvas/geometry.ts::strokeOutset).
              minValue={0}
              value={strokesMixed ? NaN : (stroke?.weight ?? 0)}
              placeholder={strokesMixed ? MIXED_LABEL : undefined}
              onCommit={(v) => runGesture((ids) => strokeOps(ids, { weight: v }))}
              onScrub={(v) => scrubStroke({ weight: v })}
              onScrubEnd={(v) => scrubStrokeEnd({ weight: v })}
            />
          </div>
          <SegRadio
            label="Posizione" showLabel={false}
            // Su MIXED nessuna scelta selezionata (null, come per i pesi del
            // testo); su un nodo senza tratti si mostra il default, che è anche
            // quello che verrebbe scritto.
            value={strokesMixed ? null : (stroke?.align ?? DEFAULT_STROKE.align)}
            options={STROKE_ALIGNMENTS}
            onChange={(v) => runGesture((ids) => strokeOps(ids, { align: v as StrokeAlignLite }))}
          />
        </div>
      </Section>

      {/* GLI EFFETTI: ombra e sfocatura. Sezione propria come il tratto: sono
          controlli di un'altra natura rispetto all'aspetto di base. */}
      <EffectsControls run={runGesture} />

      {/* OVERRIDE: solo per UNA sola istanza selezionata. Ogni riga è un nodo
          del master (testo o con riempimento) con il suo valore EFFETTIVO e un
          "Ripristina" -- vedi il commento su OverrideTextField. */}
      {instanceNode && (
        <Section title="Override">
          <div className="flex flex-col gap-2">
            {overrideRows.length === 0 ? (
              <p className="text-[12px] text-fg-subtle">Nessun elemento sovrascrivibile</p>
            ) : (
              overrideRows.map((mn) => {
                const name = layerDisplayName(mn);
                const ov = overrideMap.get(mn.id);
                return (
                  <div key={mn.id} className="flex items-end gap-1">
                    <div className="min-w-0 flex-1">
                      {mn.kind === "text" ? (
                        <OverrideTextField
                          label={name}
                          // Valore effettivo: il testo dell'override se c'è,
                          // altrimenti il contenuto del nodo del master.
                          value={ov?.text ?? mn.text?.content ?? ""}
                          onCommit={(v) => editOverrideText(mn.id, v)}
                        />
                      ) : (
                        <ColorField
                          label={name}
                          showLabel
                          // Valore effettivo: il primo fill dell'override se c'è,
                          // altrimenti quello del master.
                          value={(ov?.fills ?? mn.fills)[0] ?? null}
                          onCommit={(rgb) => editOverrideFill(mn.id, rgb)}
                        />
                      )}
                    </div>
                    {/* Ripristina: solo quando c'è davvero un override da
                        togliere. Emettere una rimozione dove non c'è niente
                        costerebbe un op e una voce di undo a vuoto. */}
                    <IconButton
                      icon="rotate"
                      label={`Ripristina ${name}`}
                      isDisabled={ov === undefined}
                      onPress={() => resetOverride(mn.id)}
                    />
                  </div>
                );
              })
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
