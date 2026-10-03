import type { ReactNode } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";

// PRIMITIVE DELL'ISPETTORE (area "props").
//
// Stanno qui e non in ds/index.tsx perché sono nate per il pannello proprietà:
// se un altro pannello ne avesse bisogno si promuovono. Come il resto del
// sistema di design non scrivono un colore a mano -- solo token.

// --- ICONE DI SEGMENTO ------------------------------------------------------
//
// Piccoli pittogrammi su griglia 16, fatti di rettangoli (come quelli
// dell'allineamento): si colorano con `currentColor`, quindi seguono stato e
// tema del segmento che li contiene. Decorative: il nome lo porta il bottone.
type R = [x: number, y: number, w: number, h: number];

export const SEG_ICONS: Record<string, R[]> = {
  // testo: tre righe allineate a sinistra / centro / destra
  textLeft: [[2, 3, 12, 1.6], [2, 7.2, 8, 1.6], [2, 11.4, 10, 1.6]],
  textCenter: [[2, 3, 12, 1.6], [4, 7.2, 8, 1.6], [3, 11.4, 10, 1.6]],
  textRight: [[2, 3, 12, 1.6], [6, 7.2, 8, 1.6], [4, 11.4, 10, 1.6]],
  // auto layout: due blocchi in fila / in colonna
  dirH: [[2.4, 4, 4.6, 8], [9, 4, 4.6, 8]],
  dirV: [[4, 2.4, 8, 4.6], [4, 9, 8, 4.6]],
  // allineamento sull'asse: inizio / centro / fine / distribuito (tre barre su
  // una riga immaginaria; la riga è il bordo o la mezzeria)
  alignStart: [[2, 2, 1.4, 12], [4.6, 4, 8, 3], [4.6, 9, 5, 3]],
  alignCenter: [[7.3, 2, 1.4, 12], [3, 4, 10, 3], [4.5, 9, 7, 3]],
  alignEnd: [[12.6, 2, 1.4, 12], [3.4, 4, 8, 3], [6.4, 9, 5, 3]],
  alignBetween: [[2, 2, 1.4, 12], [12.6, 2, 1.4, 12], [5.4, 5, 5.2, 6]],
};

export function SegIcon({ name, rotate }: { name: keyof typeof SEG_ICONS; rotate?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${rotate ? "rotate-90" : ""}`} aria-hidden="true" fill="currentColor">
      {SEG_ICONS[name].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={0.7} />
      ))}
    </svg>
  );
}

// --- SEGMENTI ---------------------------------------------------------------
//
// Una pastiglia incassata con il segmento attivo "alzato" -- il linguaggio degli
// editor di design per ogni enum a pochi valori.
const SEG_WRAP = "flex h-7 w-full gap-0.5 rounded-md bg-surface-2 p-0.5";
const SEG_ITEM =
  "flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center rounded px-1.5 text-[12px] font-medium " +
  "text-fg-muted outline-none transition-colors hover:text-fg " +
  "focus-visible:shadow-[var(--ring)]";
const SEG_ON = "bg-raised text-fg shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.08)]";

export interface SegOption<T extends string> {
  value: T;
  /** Nome accessibile (anche tooltip) e, senza icona, testo del segmento. */
  label: string;
  icon?: keyof typeof SEG_ICONS;
  /** Ruota l'icona di 90 gradi: gli allineamenti valgono per l'asse verticale. */
  rotate?: boolean;
}

function SegContent<T extends string>({ o }: { o: SegOption<T> }) {
  // Con l'icona il testo resta nel DOM, solo non si vede: il nome accessibile
  // di prima (es. "Sinistra") non cambia.
  return o.icon ? (
    <>
      <SegIcon name={o.icon} rotate={o.rotate} />
      <span className="sr-only">{o.label}</span>
    </>
  ) : (
    <span className="truncate">{o.label}</span>
  );
}

/**
 * Segmenti ESCLUSIVI come RadioGroup (ruolo `radiogroup`/`radio`). `value` null
 * = nessuna scelta (selezione mista): il gruppo resta controllato e non
 * evidenzia niente. L'etichetta del gruppo è il nome accessibile e, con
 * `showLabel`, anche una riga visibile sopra.
 */
export function SegRadio<T extends string>({
  label, value, options, onChange, showLabel = true,
}: {
  label: string;
  value: T | null;
  options: readonly SegOption<T>[];
  onChange: (v: T) => void;
  showLabel?: boolean;
}) {
  return (
    <RadioGroup
      value={value}
      onChange={(v) => onChange(v as T)}
      orientation="horizontal"
      className="flex flex-col gap-1"
    >
      <Label className={showLabel ? "text-[11px] font-medium text-fg-subtle" : "sr-only"}>{label}</Label>
      <div className={SEG_WRAP}>
        {options.map((o) => (
          <Radio
            key={o.value}
            value={o.value}
            aria-label={o.icon ? o.label : undefined}
            className={({ isSelected }) => `${SEG_ITEM} ${isSelected ? SEG_ON : ""}`}
          >
            <SegContent o={o} />
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

/**
 * Segmenti come PULSANTI a stato (`aria-pressed`): per le scelte che prima erano
 * bottoni e non radio (tipo di riempimento, direzione e allineamenti
 * dell'auto layout). Stesso aspetto di SegRadio.
 */
export function SegButtons<T extends string>({
  label, value, options, onPick, showLabel = false,
}: {
  label: string;
  value: T | undefined;
  options: readonly SegOption<T>[];
  onPick: (v: T) => void;
  showLabel?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {showLabel && <span className="text-[11px] font-medium text-fg-subtle">{label}</span>}
      <div role="group" aria-label={label} className={SEG_WRAP}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            aria-label={o.icon ? o.label : undefined}
            title={o.label}
            onClick={() => onPick(o.value)}
            className={`${SEG_ITEM} ${value === o.value ? SEG_ON : ""}`}
          >
            <SegContent o={o} />
          </button>
        ))}
      </div>
    </div>
  );
}

// --- CASELLA ----------------------------------------------------------------

// La scacchiera che sta SOTTO i colori con alfa, fatta coi token (si adatta al
// tema) e non con due grigi a mano.
export const CHECKER =
  "conic-gradient(var(--line-strong) 25%, var(--surface) 0 50%, var(--line-strong) 0 75%, var(--surface) 0) 0 0 / 8px 8px";

/** Pastiglia di anteprima del colore, con la scacchiera sotto per la trasparenza. */
export function Swatch({ color, size = 16, className = "" }: { color: string | null; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`relative inline-block shrink-0 overflow-hidden rounded-[4px] shadow-[inset_0_0_0_1px_var(--line-strong)] ${className}`}
    >
      <span className="absolute inset-0" style={{ background: CHECKER }} />
      <span className="absolute inset-0" style={{ background: color ?? "transparent" }} />
      <span className="absolute inset-0 rounded-[4px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]" />
    </span>
  );
}

/** Etichetta di riga, per i controlli che non portano un prefisso nel campo. */
export function PropLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-medium text-fg-subtle">{children}</span>;
}
