import { useContext } from "react";
import { ColorField as AriaColorField, ColorFieldStateContext, Input, Label } from "react-aria-components";
import type { Color } from "react-aria-components";
import type { FillLite } from "../../store/types";

// CAMPO COLORE (Task 10). Il modello tiene le tinte in RGBA FLOAT 0..1 -- è la
// forma che il .proto trasporta (opendesigner.v1.Color) e quella che il renderer
// disegna -- mentre l'utente le legge e le scrive in ESADECIMALE. La
// conversione fra le due forme vive QUI dentro e in nessun altro posto: è il
// "bordo UI" del brief. Nessun altro modulo (né lo store, né tools/ops.ts, né
// il renderer) deve mai vedere una stringa "#RRGGBB".
//
// Come NumberField, non conosce gesti, op o mask: emette UN valore confermato e
// chi lo usa (PropertiesPanel) decide cosa farne.

/**
 * Le sole componenti CROMATICHE di una tinta. L'alfa non passa dal campo: un
 * esadecimale a 6 cifre non la porta, e appiccicarcela renderebbe il campo
 * l'unico posto da cui si può cambiare due cose insieme senza dirlo. Chi
 * costruisce l'op ricompone l'alfa dalla tinta del nodo (vedi
 * ui/PropertiesPanel.tsx::fillOps), così una selezione multipla con alfa
 * diverse non se le vede uniformare da un cambio di colore.
 */
export type RgbLite = Pick<FillLite, "r" | "g" | "b">;

const MAX_CHANNEL = 255;

// 0..1 float -> 0..255 intero. Il clamp non è difensivismo: un fill che arriva
// dal filo è un float qualunque, e Number.toString(16) di un valore fuori scala
// produrrebbe una stringa che parseColor rifiuterebbe (throw a ogni render).
function toByte(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * MAX_CHANNEL);
}

/** RGB del modello (float 0..1) -> "#RRGGBB". */
export function rgbToHex(c: RgbLite): string {
  return `#${[c.r, c.g, c.b].map((v) => toByte(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * Inverso di rgbToHex, a partire dal Color di react-aria-components.
 *
 * `toFormat("rgb")` e non una lettura diretta dei canali: il campo senza `channel`
 * lavora in esadecimale, quindi il Color è già RGB, ma la conversione esplicita
 * lo rende vero anche se un domani il campo venisse configurato in un altro
 * spazio colore -- e costa nulla quando è già nel formato giusto.
 */
export function colorToRgb(color: Color): RgbLite {
  const rgb = color.toFormat("rgb");
  return {
    r: rgb.getChannelValue("red") / MAX_CHANNEL,
    g: rgb.getChannelValue("green") / MAX_CHANNEL,
    b: rgb.getChannelValue("blue") / MAX_CHANNEL,
  };
}

export interface ColorFieldProps {
  /** Etichetta VISIBILE e nome accessibile del campo (es. "Riempimento"). */
  label: string;
  /**
   * Colore corrente, o null per "nessun valore singolo da mostrare" (selezione
   * mista, nodo senza tinte). null e NON undefined, per la stessa ragione per
   * cui NumberField usa NaN invece di undefined: null resta un VALORE, quindi
   * react-stately non fa scivolare il campo da controllato a non controllato
   * quando il colore torna a essere definito.
   */
  value: RgbLite | null;
  /**
   * Colore confermato (Invio o blur, gestiti da react-aria-components stesso).
   * Un campo svuotato o non parsabile NON invoca questo callback, e nemmeno la
   * riconferma dello STESSO colore: react-stately confronta i due valori prima
   * di propagare (useColorFieldState::safelySetColorValue), quindi qui non
   * arriva mai un cambio che non è un cambio -- e chi ascolta non manda un op
   * inutile.
   */
  onCommit: (rgb: RgbLite) => void;
  /** Classi CSS della larghezza dell'etichetta (vedi NumberField::labelWidth). */
  labelWidth?: string;
  isDisabled?: boolean;
  /**
   * Testo temporaneo mostrato quando il campo è VUOTO (`value` null). Stessa
   * ragione del gemello in NumberField -- vedi NumberFieldProps::placeholder.
   */
  placeholder?: string;
}

// L'<Input> del campo, separato SOLO per poter leggere ColorFieldStateContext:
// il contesto è pubblicato da AriaColorField, quindi va consumato da un suo
// discendente.
//
// Esiste perché react-aria-components conferma il colore unicamente sul BLUR
// (useColorField: `onBlur: commit`, e nessun gestore di Invio da nessuna
// parte -- a differenza di NumberField, che l'Invio lo gestisce da sé). In un
// pannello di proprietà quello è il comportamento sbagliato: si digita un
// colore, si preme Invio e ci si aspetta di vederlo applicato, non di dover
// uscire dal campo. Senza questa riga il colore digitato resterebbe nel campo
// e non diventerebbe mai un op.
function HexInput({ placeholder }: { placeholder?: string }) {
  const state = useContext(ColorFieldStateContext);
  return (
    <Input
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        // Il campo può stare dentro un <form> (oggi non ci sta, ma è la
        // ragione per cui questo default esiste): Invio non deve inviarlo.
        e.preventDefault();
        state?.commit();
      }}
      className="w-full min-w-0 rounded border border-neutral-200 bg-white px-1 py-0.5 text-sm uppercase outline-none focus:border-sky-500 disabled:opacity-40"
    />
  );
}

export function ColorField({ label, value, onCommit, labelWidth = "w-20", isDisabled, placeholder }: ColorFieldProps) {
  const hex = value ? rgbToHex(value) : null;
  return (
    <AriaColorField
      // Stringa esadecimale e non un Color già costruito: react-aria-components
      // la normalizza da sé (useColorFieldState::useColor) e una stringa nuova
      // ma UGUALE non conta come un valore nuovo, mentre un parseColor() a ogni
      // render restituirebbe un oggetto diverso ogni volta.
      value={hex}
      isDisabled={isDisabled}
      onChange={(color) => {
        // Campo svuotato: react-stately propaga null. È l'analogo del NaN di
        // NumberField -- "nessun colore" non è un colore da scrivere nel
        // documento, quindi non diventa un op.
        if (!color) return;
        onCommit(colorToRgb(color));
      }}
      className="flex items-center gap-1.5"
    >
      <Label className={`${labelWidth} shrink-0 select-none text-neutral-400`}>{label}</Label>
      {/* Pastiglia di anteprima. aria-hidden e non un ColorSwatch: il valore lo
          dice già il campo di testo accanto (stesso nome accessibile), e
          annunciarlo due volte sarebbe rumore per chi usa uno screen reader.
          Un vero selettore visuale (ruota/area) è lavoro successivo: qui serve
          il canale ESATTO -- l'esadecimale -- che è anche il modo in cui i
          colori si copiano fra strumenti di design. */}
      <span
        aria-hidden="true"
        className="size-4 shrink-0 rounded border border-neutral-300"
        style={{ backgroundColor: hex ?? "transparent" }}
      />
      <HexInput placeholder={placeholder} />
    </AriaColorField>
  );
}
