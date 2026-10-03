import { useState, type ReactNode } from "react";
import { Button as RacButton, Tooltip, TooltipTrigger, type ButtonProps } from "react-aria-components";
import { Icon, type IconName } from "./Icon";

export { Icon, type IconName } from "./Icon";

// PRIMITIVE DEL SISTEMA DI DESIGN.
//
// Poche, piccole e componibili. Le classi stanno in `cls` perché i pannelli
// hanno già i loro componenti react-aria (campi, select nativi, righe): chi li
// riveste riusa le STESSE classi invece di ridefinire un grigio. Se un valore
// qui sotto cambia, cambia ovunque.

const FOCUS = "outline-none focus-visible:shadow-[var(--ring)]";

export const cls = {
  // Campo di testo / numerico: incassato, altezza 28, bordo che si accende al focus.
  input:
    "h-7 w-full min-w-0 rounded-md border border-transparent bg-surface-2 px-2 text-[13px] text-fg " +
    "placeholder:text-fg-subtle hover:border-line-strong focus:border-accent focus:bg-surface " +
    "focus:outline-none disabled:opacity-50 tabular-nums",
  // <select> nativo ma vestito (appearance-none + freccia dal chevron di sfondo).
  select:
    "h-7 w-full min-w-0 appearance-none rounded-md border border-transparent bg-surface-2 pl-2 pr-6 text-[13px] text-fg " +
    "hover:border-line-strong focus:border-accent focus:outline-none " +
    "bg-[length:12px] bg-[right_6px_center] bg-no-repeat " +
    "bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%237b8291' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><path d='M4.2 6.2L8 10l3.8-3.8'/></svg>\")]",
  label: "text-[11px] font-medium text-fg-subtle",
  // Intestazione di sezione (maiuscoletto discreto), la stessa in ogni pannello.
  sectionTitle: "text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle",
  row: "flex items-center gap-2 px-3",
  panel: "bg-surface text-fg",
  divider: "border-line",
};

type Variant = "primary" | "secondary" | "ghost" | "danger" | "flow";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  flow: "bg-flow text-white hover:brightness-110",
  secondary: "bg-surface-2 text-fg border border-line hover:bg-surface-3",
  ghost: "text-fg-muted hover:bg-surface-3 hover:text-fg",
  danger: "text-danger hover:bg-danger-soft",
};

export function Button({
  variant = "secondary", icon, children, className = "", ...props
}: ButtonProps & { variant?: Variant; icon?: IconName; className?: string; children?: ReactNode }) {
  return (
    <RacButton
      {...props}
      className={`inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium ` +
        `transition-colors disabled:opacity-40 ${FOCUS} ${VARIANT[variant]} ${className}`}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </RacButton>
  );
}

// Pulsante a sola icona. `label` è il nome accessibile E il testo del tooltip;
// `shortcut` (opzionale) compare accanto nel tooltip.
export function IconButton({
  icon, label, shortcut, selected, tone = "default", size = 28, className = "", ...props
}: Omit<ButtonProps, "children" | "aria-label"> & {
  icon: IconName; label: string; shortcut?: string; selected?: boolean; tone?: "default" | "flow"; size?: number; className?: string;
}) {
  const on = tone === "flow" ? "bg-flow text-white" : "bg-accent text-accent-fg";
  return (
    <TooltipTrigger delay={350} closeDelay={0}>
      <RacButton
        {...props}
        aria-label={label}
        aria-pressed={selected === undefined ? undefined : selected}
        style={{ width: size, height: size }}
        className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${FOCUS} ` +
          `${selected ? on : "text-fg-muted hover:bg-surface-3 hover:text-fg"} ${className}`}
      >
        <Icon name={icon} size={16} />
      </RacButton>
      <Tip label={label} shortcut={shortcut} />
    </TooltipTrigger>
  );
}

export function Tip({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <Tooltip
      offset={8}
      className="z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop"
    >
      {label}
      {shortcut && <Kbd inverted>{shortcut}</Kbd>}
    </Tooltip>
  );
}

export function Kbd({ children, inverted }: { children: ReactNode; inverted?: boolean }) {
  return (
    <kbd className={`rounded px-1 font-sans text-[11px] font-medium ${inverted ? "bg-white/15 text-surface" : "bg-surface-3 text-fg-muted"}`}>
      {children}
    </kbd>
  );
}

export function Badge({
  tone = "neutral", children, className = "",
}: { tone?: "neutral" | "accent" | "flow" | "ok" | "warn" | "danger"; children: ReactNode; className?: string }) {
  const t = {
    neutral: "bg-surface-3 text-fg-muted",
    accent: "bg-accent-soft text-accent",
    flow: "bg-flow-soft text-flow",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
  }[tone];
  return <span className={`inline-flex h-[18px] items-center rounded-full px-2 text-[11px] font-medium ${t} ${className}`}>{children}</span>;
}

// Quali sezioni sono chiuse sopravvive al ricarico (per titolo). Senza
// localStorage tutte le sezioni restano aperte.
const SEC_KEY = "od.sections";
function readClosed(): Record<string, true> {
  try { return JSON.parse(localStorage.getItem(SEC_KEY) ?? "{}") as Record<string, true>; } catch { return {}; }
}
function useSectionOpen(title: string): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => !readClosed()[title]);
  return [open, (v) => {
    setOpen(v);
    try {
      const c = readClosed();
      if (v) delete c[title]; else c[title] = true;
      localStorage.setItem(SEC_KEY, JSON.stringify(c));
    } catch { /* niente storage */ }
  }];
}

// Contenitore di sezione di un pannello: titolo a sinistra, azioni a destra,
// separatore sopra. `count` mostra un numerino tenue accanto al titolo. Il
// titolo è un pulsante che RICHIUDE la sezione (chevron, aria-expanded): in un
// pannello stretto lo spazio è la risorsa più scarsa, e chi non usa "Effetti"
// non deve pagarne l'altezza.
export function Section({
  title, count, actions, children, className = "", bare,
}: { title: string; count?: number; actions?: ReactNode; children?: ReactNode; className?: string; bare?: boolean }) {
  const [open, setOpen] = useSectionOpen(title);
  return (
    <section className={`border-t border-line first:border-t-0 ${className}`}>
      <header className="flex h-9 items-center gap-1 pl-1.5 pr-3">
        <RacButton
          aria-expanded={open}
          onPress={() => setOpen(!open)}
          className={`flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 ${FOCUS} hover:bg-surface-3`}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className="text-fg-subtle" />
          <h3 className={cls.sectionTitle}>{title}</h3>
          {count !== undefined && <span className="text-[11px] tabular-nums text-fg-subtle">{count}</span>}
        </RacButton>
        <div className="ml-auto flex items-center gap-0.5">{actions}</div>
      </header>
      {open && !bare && <div className="px-3 pb-3">{children}</div>}
      {open && bare && children}
    </section>
  );
}

// Stato vuoto: un'icona tenue, una riga di spiegazione e (opzionale) un'azione.
export function EmptyState({
  icon, title, hint, action,
}: { icon: IconName; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-3 text-fg-subtle">
        <Icon name={icon} size={18} />
      </span>
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {hint && <p className="max-w-[220px] text-[12px] leading-snug text-fg-subtle">{hint}</p>}
      {action}
    </div>
  );
}

// Avviso in cima all'app (connessione, errore, notizia).
export function Banner({
  tone, children, onClose,
}: { tone: "warn" | "danger" | "info"; children: ReactNode; onClose?: () => void }) {
  const t = {
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
    info: "bg-accent-soft text-accent",
  }[tone];
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium ${t}`}>
      <Icon name={tone === "info" ? "info" : "warning"} size={14} />
      <span className="flex-1">{children}</span>
      {onClose && (
        <RacButton aria-label="Chiudi l'avviso" onPress={onClose} className={`rounded p-1 hover:bg-black/5 ${FOCUS}`}>
          <Icon name="x" size={12} />
        </RacButton>
      )}
    </div>
  );
}
