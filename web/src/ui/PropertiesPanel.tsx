import { Label, Radio, RadioGroup, Slider, SliderOutput, SliderThumb, SliderTrack } from "react-aria-components";
import { useScene } from "../store/store";
import { selectionSummary, MIXED } from "../store/selectors";
import type { Mixed, OrMixed } from "../store/selectors";
import { makeSetPropsOp, makeSetTextOp } from "../tools/ops";
import { NumberField } from "./fields/NumberField";
import { ColorField } from "./fields/ColorField";
import type { RgbLite } from "./fields/ColorField";
import { toPbFills } from "../store/types";
import type { NodeLite, TextAlignLite, TextStyleLite } from "../store/types";
import type { MaskPath } from "../store/maskPaths";
import type { Op } from "../gen/brawt/v1/brawt_pb";

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
  key: "x" | "y" | "width" | "height" | "cornerRadius";
  label: string;
  mask: MaskPath;
  minValue?: number;
}

const GEOMETRY_FIELDS: readonly NumericField[] = [
  { key: "x", label: "X", mask: "x" },
  { key: "y", label: "Y", mask: "y" },
  { key: "width", label: "W", mask: "width", minValue: 0 },
  { key: "height", label: "H", mask: "height", minValue: 0 },
];

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
    case "cornerRadius":
      // ANNIDATO dentro il oneof `shape`: "corner_radius" è l'unico path della
      // mask che non indirizza un campo di primo livello del Node (vedi
      // store/maskPaths.ts e core.applySetProps). Il patch deve quindi portare
      // una FORMA, non un campo -- ed è la stessa forma che il nodo ha già,
      // altrimenti Go risponderebbe ErrNotRectNode.
      return { shape: { case: "rect" as const, value: { cornerRadius: value } } };
  }
}

// Op di scrittura di UN campo numerico su OGNI nodo selezionato: come il
// toggle di visibilità e la rinomina del pannello livelli, lo stesso valore
// ASSOLUTO va a tutti i nodi selezionati -- non una traslazione relativa.
function numericOps(ids: readonly string[], field: NumericField, value: number): Op[] {
  return ids.map((id) => makeSetPropsOp(id, patchFor(field.key, value), [field.mask]));
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
    const n = scene.nodes[id];
    if (!n) return [];
    const first = { ...rgb, a: n.fills[0]?.a ?? 1 };
    return [makeSetPropsOp(id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"])];
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
    const n = scene.nodes[id];
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
const FONT_WEIGHTS: readonly { value: string; label: string }[] = [
  { value: "400", label: "Normale" },
  { value: "700", label: "Grassetto" },
];

const ALIGNMENTS: readonly { value: TextAlignLite; label: string }[] = [
  { value: "left", label: "Sinistra" },
  { value: "center", label: "Centro" },
  { value: "right", label: "Destra" },
];

// Un valore riassunto pronto per un RadioGroup CONTROLLATO: null (e non
// undefined) per MIXED, così il gruppo resta controllato e mostra semplicemente
// nessuna scelta -- stessa ragione per cui NumberField usa NaN invece di
// undefined.
function radioValue<T extends string>(v: OrMixed<T>): T | null {
  return v === MIXED ? null : (v as T);
}

const RADIO_CLASS =
  "cursor-pointer rounded px-1.5 py-0.5 text-neutral-600 outline-none " +
  "data-[selected]:bg-sky-100 data-[selected]:text-sky-700 " +
  "data-[focus-visible]:ring-1 data-[focus-visible]:ring-sky-500";

const ROW_LABEL_CLASS = "w-20 shrink-0 select-none text-neutral-400";

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="border-b border-t border-neutral-200 px-2 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
      {children}
    </div>
  );
}

export function PropertiesPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const summary = scene ? selectionSummary(scene, selection) : null;
  const nodes = scene ? selection.map((id) => scene.nodes[id]).filter((n): n is NodeLite => n !== undefined) : [];
  const style = summary?.kind === "text" ? textStyleSummary(nodes) : null;

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
      <div className="flex h-full flex-col text-sm text-neutral-700">
        <div className="border-b border-neutral-200 px-2 py-1.5 font-medium text-neutral-500">Proprietà</div>
        <div className="px-2 py-4 text-neutral-400">Nessuna selezione</div>
      </div>
    );
  }

  const opacity: number | Mixed = summary.opacity;
  const fill = summary.fills === MIXED ? null : (summary.fills[0] ?? null);

  return (
    <div className="flex h-full flex-col overflow-auto text-sm text-neutral-700">
      <div className="border-b border-neutral-200 px-2 py-1.5 font-medium text-neutral-500">Proprietà</div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 p-2">
        {GEOMETRY_FIELDS.map((field) => (
          <NumberField
            key={field.key}
            label={field.label}
            minValue={field.minValue}
            // MIXED (selezione multipla con valori diversi) diventa NaN:
            // NumberField lo mostra vuoto e non ne fa un cambio di
            // controllato/non controllato (vedi il commento sulla sua
            // prop `value`).
            value={summary[field.key] === MIXED ? NaN : (summary[field.key] as number)}
            onCommit={(v) => commit(field, v)}
            onScrub={(v) => scrub(field, v)}
            onScrubEnd={(v) => scrubEnd(field, v)}
          />
        ))}
      </div>

      <SectionTitle>Aspetto</SectionTitle>
      <div className="flex flex-col gap-1.5 p-2">
        <ColorField
          label="Riempimento"
          // MIXED o nodo senza tinte: null, cioè "nessun valore singolo da
          // mostrare". Scrivere un colore da lì resta possibile e lo assegna
          // a tutta la selezione, come per i campi geometrici.
          value={fill}
          onCommit={(rgb) => runGesture((ids) => fillOps(ids, rgb))}
        />

        <Slider
          // MIXED ricade su 1 solo per avere una POSIZIONE da disegnare: il
          // valore vero "non c'è", e infatti l'uscita accanto mostra "—" e non
          // "100%". Il cursore resta però usabile -- trascinarlo assegna la
          // stessa opacità a tutta la selezione, esattamente come un campo
          // geometrico misto accetta un valore digitato.
          value={opacity === MIXED ? 1 : opacity}
          minValue={0}
          maxValue={1}
          // 1% è il passo con cui l'opacità si legge in percentuale intera;
          // niente arrotondamenti invisibili sotto quella soglia.
          step={0.01}
          onChange={scrubOpacity}
          onChangeEnd={scrubOpacityEnd}
          className="flex items-center gap-1.5"
        >
          <Label className={ROW_LABEL_CLASS}>Opacità</Label>
          <SliderTrack className="relative h-4 flex-1 min-w-0">
            {/* Il binario disegnato è un figlio del track e non il track
                stesso: il track deve restare alto abbastanza da essere
                afferrabile col dito, la riga colorata sottile abbastanza da
                leggersi come un cursore. */}
            <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded bg-neutral-200" />
            <SliderThumb className="top-1/2 size-3 rounded-full border border-neutral-400 bg-white shadow-sm outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-sky-500" />
          </SliderTrack>
          <SliderOutput className="w-10 shrink-0 text-right tabular-nums text-neutral-500">
            {({ state }) => (opacity === MIXED ? "—" : `${Math.round(state.getThumbValue(0) * 100)}%`)}
          </SliderOutput>
        </Slider>

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
            onCommit={(v) => commit(CORNER_RADIUS_FIELD, v)}
            onScrub={(v) => scrub(CORNER_RADIUS_FIELD, v)}
            onScrubEnd={(v) => scrubEnd(CORNER_RADIUS_FIELD, v)}
          />
        )}
      </div>

      {/* Per i nodi testo il pannello mostra INVECE i controlli di stile: sono
          l'equivalente del raggio per un rettangolo -- le proprietà che quel
          tipo di nodo ha e gli altri no. Emettono SetText (con style_present),
          non SetProperties: lo stile vive dentro il oneof `shape`. */}
      {style && (
        <>
          <SectionTitle>Testo</SectionTitle>
          <div className="flex flex-col gap-1.5 p-2">
            <NumberField
              label="Dimensione"
              labelWidth="w-20"
              minValue={1}
              value={style.fontSize === MIXED ? NaN : (style.fontSize as number)}
              onCommit={(v) => runGesture((ids) => textStyleOps(ids, { fontSize: v }))}
              onScrub={(v) => scrubTextStyle({ fontSize: v })}
              onScrubEnd={(v) => scrubTextStyleEnd({ fontSize: v })}
            />

            <RadioGroup
              value={radioValue(style.fontWeight)}
              onChange={(v) => runGesture((ids) => textStyleOps(ids, { fontWeight: v }))}
              orientation="horizontal"
              className="flex items-center gap-1.5"
            >
              <Label className={ROW_LABEL_CLASS}>Peso</Label>
              <div className="flex gap-1">
                {FONT_WEIGHTS.map((w) => (
                  <Radio key={w.value} value={w.value} className={RADIO_CLASS}>
                    {w.label}
                  </Radio>
                ))}
              </div>
            </RadioGroup>

            <RadioGroup
              value={radioValue(style.align)}
              // Il cast è sicuro per costruzione: gli unici valori nel gruppo
              // sono quelli di ALIGNMENTS, che è tipizzato TextAlignLite.
              onChange={(v) => runGesture((ids) => textStyleOps(ids, { align: v as TextAlignLite }))}
              orientation="horizontal"
              className="flex items-center gap-1.5"
            >
              <Label className={ROW_LABEL_CLASS}>Allineamento</Label>
              <div className="flex gap-1">
                {ALIGNMENTS.map((a) => (
                  <Radio key={a.value} value={a.value} className={RADIO_CLASS}>
                    {a.label}
                  </Radio>
                ))}
              </div>
            </RadioGroup>
          </div>
        </>
      )}
    </div>
  );
}
