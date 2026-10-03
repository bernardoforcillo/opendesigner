import type { ReactNode, SVGProps } from "react";
import { Button as RacButton, TooltipTrigger, type ButtonProps } from "react-aria-components";
import { Icon, type IconName } from "./Icon";
import { Tip } from "./index";

// PEZZI CONDIVISI DELL'AREA "FLUSSI, PROTOTIPO E CHROME" (agente C).
//
// Stanno qui, in un file a parte, perché il sistema di design (ds/index.tsx,
// ds/Icon.tsx) è del lead: se uno di questi pezzi serve a più pannelli, il lead lo
// promuove nel posto giusto. Tutto usa i token, niente colori scritti a mano.

// --- ICONE IN PIÙ ------------------------------------------------------------
// Stessa griglia 16x16 e tratto 1.5 di ds/Icon.tsx. Servono ai flussi (frecce,
// ricomincia, ciclo, variabili) e ai tipi di schermata.
const P = {
  arrowRight: "M3 8h10M9 4l4 4-4 4",
  arrowLeft: "M13 8H3M7 4L3 8l4 4",
  restart: "M13 8a5 5 0 11-1.6-3.7M13 2.6v2.6h-2.6",
  loop: "M3.5 7.5v-1a2 2 0 012-2h6.2M9.7 2.6l2 1.9-2 1.9M12.5 8.5v1a2 2 0 01-2 2H4.3M6.3 9.6l-2 1.9 2 1.9",
  braces: "M5.6 2.8c-1.4 0-1.9.8-1.9 1.9v1.2c0 1-.5 2.1-1.7 2.1 1.2 0 1.7 1.1 1.7 2.1v1.2c0 1.1.5 1.9 1.9 1.9M10.4 2.8c1.4 0 1.9.8 1.9 1.9v1.2c0 1 .5 2.1 1.7 2.1-1.2 0-1.7 1.1-1.7 2.1v1.2c0 1.1-.5 1.9-1.9 1.9",
  kScreen: "M5.2 2h5.6a1 1 0 011 1v10a1 1 0 01-1 1H5.2a1 1 0 01-1-1V3a1 1 0 011-1zM7 12h2",
  kDecision: "M8 2.2l5.8 5.8L8 13.8 2.2 8z",
  kAction: "M9.2 2L4.2 9h3.6l-1 5 5-7H8.2z",
  kStart: "M8 13a5 5 0 100-10 5 5 0 000 10z",
  kEnd: "M8 13.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11zM8 10.3a2.3 2.3 0 100-4.6 2.3 2.3 0 000 4.6z",
  kNote: "M4 2h5l3 3v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM9 2v3h3M5.5 8.2h5M5.5 10.6h3",
  device: "M5.2 2h5.6a1 1 0 011 1v10a1 1 0 01-1 1H5.2a1 1 0 01-1-1V3a1 1 0 011-1z",
} as const;

export type FlowIconName = keyof typeof P;

export function FlowIcon({
  name, size = 16, className, ...rest
}: { name: FlowIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" className={className} {...rest}
    >
      <path d={P[name]} />
    </svg>
  );
}

// --- CAMPO ETICHETTATO ---------------------------------------------------------
// Etichetta a sinistra (colonna fissa), controllo a destra. È un <label>: l'etichetta
// visibile CLICCA il controllo, ma il nome accessibile lo fissa il controllo
// stesso (aria-label) -- i test e i lettori di schermo vedono gli stessi nomi di sempre.
export function Field({
  label, icon, children, className = "", wide,
}: { label: string; icon?: IconName; children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <label className={`flex min-h-7 items-center gap-2 ${className}`}>
      <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium text-fg-subtle ${wide ? "w-[88px]" : "w-14"}`}>
        {icon && <Icon name={icon} size={12} />}
        <span className="truncate">{label}</span>
      </span>
      {children}
    </label>
  );
}

// --- INTERRUTTORE ---------------------------------------------------------------
// Una casella VERA (input checkbox: stesso ruolo, stessa tastiera, stesso test)
// vestita da interruttore. La casella è fuori vista ma focusabile; la traccia
// segue lo stato con `peer-checked`.
export function SwitchRow({
  label, checked, onChange, tone = "accent",
}: { label: string; checked: boolean; onChange: (v: boolean) => void; tone?: "accent" | "flow" }) {
  const on = tone === "flow" ? "peer-checked:bg-flow" : "peer-checked:bg-accent";
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-0.5 text-[12px] text-fg-muted">
      <span>{label}</span>
      <span className="relative inline-flex h-4 w-7 shrink-0 items-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0"
        />
        <span className={`pointer-events-none absolute inset-0 rounded-full bg-line-strong transition-colors ${on} peer-focus-visible:shadow-[var(--ring)]`} />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-3" />
      </span>
    </label>
  );
}

// Contenitore di un controllo segmentato (i segmenti sono dei Radio di react-aria
// o dei bottoni: qui c'è solo il guscio incassato).
export const SEGMENTED_TRACK = "inline-flex items-center gap-0.5 rounded-md bg-surface-3 p-0.5";
export const SEGMENT =
  "inline-flex h-6 min-w-8 cursor-pointer select-none items-center justify-center gap-1 rounded px-2 text-[12px] font-medium " +
  "text-fg-muted outline-none transition-colors hover:text-fg " +
  "data-[selected]:bg-raised data-[selected]:text-fg data-[selected]:shadow-sm " +
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[focus-visible]:shadow-[var(--ring)]";

// --- ICONA DI UNO DEI DUE SET + PULSANTE A SOLA ICONA -----------------------------
export function AnyIcon({ name, size = 16 }: { name: IconName | FlowIconName; size?: number }) {
  return name in P ? <FlowIcon name={name as FlowIconName} size={size} /> : <Icon name={name as IconName} size={size} />;
}

// Gemello di IconButton (ds/index.tsx) che accetta anche le icone di questo file.
// Stesso contratto: `label` è nome accessibile E testo del tooltip.
export function FlowIconButton({
  icon, label, shortcut, selected, size = 28, className = "", children, ...props
}: Omit<ButtonProps, "children" | "aria-label"> & {
  icon: IconName | FlowIconName; label: string; shortcut?: string; selected?: boolean; size?: number; className?: string; children?: ReactNode;
}) {
  return (
    <TooltipTrigger delay={350} closeDelay={0}>
      <RacButton
        {...props}
        aria-label={label}
        aria-pressed={selected === undefined ? undefined : selected}
        style={{ width: size, height: size }}
        className={`relative inline-flex shrink-0 items-center justify-center rounded-md outline-none transition-colors ` +
          `disabled:opacity-40 data-[focus-visible]:shadow-[var(--ring)] ` +
          `${selected ? "bg-accent-soft text-accent" : "text-fg-muted hover:bg-surface-3 hover:text-fg"} ${className}`}
      >
        <AnyIcon name={icon} />
        {children}
      </RacButton>
      <Tip label={label} shortcut={shortcut} />
    </TooltipTrigger>
  );
}
