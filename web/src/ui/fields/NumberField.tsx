import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { NumberField as AriaNumberField, Label, Input } from "react-aria-components";

// CAMPO NUMERICO GENERICO (Task 9): un valore che si conferma digitando (Invio
// o blur, comportamento nativo di react-aria-components) O trascinando la sua
// ETICHETTA -- comportamento atteso in un editor di design (Figma, Sketch...),
// dove l'etichetta di un campo numerico è essa stessa un cursore di scrub.
//
// Non conosce gesti, op o mask: chi lo usa (PropertiesPanel) decide COSA fare
// di ogni conferma. Qui restano solo tre canali generici, tutti già puliti da
// NaN prima di raggiungere il chiamante:
//   - onCommit   digitazione confermata (Invio/blur) -- UN valore finale;
//   - onScrub    anteprima CONTINUA durante il trascinamento dell'etichetta;
//   - onScrubEnd rilascio del trascinamento -- il valore finale dello STESSO
//                gesto che onScrub ha anticipato.

// Sotto questa soglia (px SCHERMO) un pointerdown sull'etichetta resta un
// CLICK e non un trascinamento: stessa idea di MARQUEE_SLOP_PX in
// tools/selectTool.ts, qui applicata allo scrub. Senza soglia, un click che
// trema di un pixel aprirebbe/chiuderebbe un gesto a vuoto.
const SCRUB_SLOP_PX = 2;

function clampMin(value: number, minValue: number | undefined): number {
  return minValue !== undefined && value < minValue ? minValue : value;
}

export interface NumberFieldProps {
  /** Etichetta VISIBILE e nome accessibile del campo (es. "X"). */
  label: string;
  /**
   * Valore corrente. NaN rappresenta "vuoto" (nessun valore singolo da
   * mostrare -- selezione mista, o nessuna selezione) e NON "controllato vs
   * non controllato": passare `undefined` farebbe scivolare
   * react-stately fuori dal controllo ogni volta che il valore torna a
   * essere definito, con l'avviso di sviluppo che ne conseguirebbe (vedi
   * react-stately/useControlledState). NaN resta SEMPRE un valore, quindi il
   * campo resta SEMPRE controllato.
   */
  value: number;
  /**
   * Digitazione confermata (Invio o blur, gestiti da react-aria-components
   * stesso -- non per-tasto): il valore è GIÀ un numero finito. Un input
   * vuoto o non parsabile NON invoca questo callback (vedi il commento
   * sull'onChange qui sotto): nessun NaN può raggiungere il chiamante.
   */
  onCommit: (value: number) => void;
  /** Anteprima continua durante il trascinamento dell'etichetta. */
  onScrub?: (value: number) => void;
  /** Rilascio del trascinamento: il valore FINALE dello stesso gesto che onScrub ha anticipato. */
  onScrubEnd?: (value: number) => void;
  /**
   * Unità di valore per pixel trascinato. DELIBERATAMENTE indipendente dallo
   * `step` di react-aria-components (che arrotonderebbe anche i valori
   * DIGITATI al passo più vicino in fase di commit -- vedi
   * useNumberFieldState::snapValue -- troncando coordinate frazionarie che
   * l'utente non ha mai chiesto di arrotondare): qui serve solo a scalare lo
   * scrub, il campo non riceve mai uno `step` a react-aria-components.
   */
  dragSensitivity?: number;
  minValue?: number;
  /**
   * Classi CSS della LARGHEZZA dell'etichetta. Esiste perché lo stesso campo
   * serve etichette di una lettera (X/Y/W/H/R, la griglia compatta del
   * pannello) ed etichette a parola intera (Dimensione, per lo stile del
   * testo): una larghezza fissa dentro il componente sarebbe sbagliata per
   * metà dei casi d'uso.
   */
  labelWidth?: string;
  isDisabled?: boolean;
}

export function NumberField({
  label,
  value,
  onCommit,
  onScrub,
  onScrubEnd,
  dragSensitivity = 1,
  minValue,
  labelWidth = "w-4",
  isDisabled,
}: NumberFieldProps) {
  // Stato del trascinamento in corso. Un ref e non uno state: ogni pixel di
  // move non deve ri-renderizzare QUESTO componente (lo fa già il chiamante,
  // per la propria via, quando onScrub aggiorna lo store). `started`
  // distingue un semplice click sull'etichetta (mai superata la soglia) da un
  // vero trascinamento -- solo il secondo apre/chiude un gesto lato
  // chiamante: vedi il commento su dragStarted in tools/selectTool.ts, stessa
  // idea qui applicata allo scrub di un'etichetta invece che a un nodo.
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; started: boolean } | null>(null);

  function onLabelPointerDown(e: ReactPointerEvent<HTMLLabelElement>) {
    // Un valore non definito (NaN, selezione mista) non ha un punto di
    // partenza sensato da cui scrubare: meglio nessun trascinamento che uno
    // che parte da 0 senza che l'utente l'abbia chiesto.
    if (isDisabled || e.button !== 0 || !Number.isFinite(value)) return;
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startValue: value, started: false };
    // Cattura BEST-EFFORT: nei browser veri fa continuare a ricevere i move
    // anche quando il puntatore esce dall'etichetta. jsdom (i test) non la
    // implementa per davvero -- da qui il try/catch, stesso schema di
    // tools/toolManager.ts.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* nessun capture reale (jsdom, o già perso) */
    }
  }

  function onLabelPointerMove(e: ReactPointerEvent<HTMLLabelElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.started) {
      if (Math.abs(dx) < SCRUB_SLOP_PX) return; // tremolio: resta un click
      d.started = true;
    }
    onScrub?.(clampMin(d.startValue + dx * dragSensitivity, minValue));
  }

  // pointerup E pointercancel: il browser può annullare il gesto (gesture di
  // sistema, capture perso) tanto quanto rilasciarlo normalmente, e in
  // ENTRAMBI i casi il trascinamento deve chiudersi -- senza, il prossimo
  // pointerdown troverebbe drag.current ancora valorizzato con un pointerId
  // che non arriverà mai più.
  function endDrag(e: ReactPointerEvent<HTMLLabelElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* già rilasciato */
    }
    if (!d.started) return; // click semplice: nessun gesto da chiudere
    const dx = e.clientX - d.startX;
    onScrubEnd?.(clampMin(d.startValue + dx * dragSensitivity, minValue));
  }

  return (
    <AriaNumberField
      value={value}
      minValue={minValue}
      isDisabled={isDisabled}
      // Niente separatori di migliaia in un campo di coordinate: "1,234" per
      // x=1234 è rumore, non leggibilità, in un editor di design.
      formatOptions={{ useGrouping: false, maximumFractionDigits: 2 }}
      onChange={(v) => {
        // Un input svuotato e confermato fa commit-are NaN (react-stately::
        // commit, "Set to empty state if input value is empty"): senza
        // questo controllo un campo svuotato manderebbe al chiamante un
        // valore che, spedito così com'è in un SetProperties, renderebbe il
        // nodo invisibile e irrecuperabile dalla UI (x/y NaN) -- vedi il
        // brief. Un input che non parsa affatto (es. "-" da solo) non arriva
        // nemmeno fin qui: react-stately lo intercetta prima e non chiama
        // onChange.
        if (!Number.isFinite(v)) return;
        onCommit(v);
      }}
      className="flex items-center gap-1"
    >
      <Label
        onPointerDown={onLabelPointerDown}
        onPointerMove={onLabelPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // touch-none: trascinare l'etichetta su schermo tattile non deve
        // scorrere il pannello (stesso motivo della maniglia di riordino in
        // ui/LayersPanel.tsx). select-none: uno scrub non deve selezionare il
        // testo dell'etichetta mentre il puntatore si muove.
        className={`${labelWidth} shrink-0 cursor-ew-resize touch-none select-none text-neutral-400`}
      >
        {label}
      </Label>
      <Input className="w-full min-w-0 rounded border border-neutral-200 bg-white px-1 py-0.5 text-right text-sm outline-none focus:border-sky-500 disabled:opacity-40" />
    </AriaNumberField>
  );
}
