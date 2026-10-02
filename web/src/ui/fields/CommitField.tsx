import { useEffect, useRef, useState } from "react";

// Un campo di testo che conferma su Invio o al blur, UNA volta sola. Gemello di
// OverrideTextField (PropertiesPanel) e dei campi di rinomina: la bozza digitata
// è stato locale e riparte da `value` quando cambia dall'esterno (commit andato a
// buon fine, cambio di selezione). Così ogni modifica è UN op e UNA voce di undo,
// non una per tasto battuto.
//
// Nessun tasto esce dal campo: le scorciatoie globali (undo/redo su window,
// Canc/Escape/K del canvas) non devono agire mentre si scrive.
export function CommitField({
  label,
  value,
  onCommit,
  placeholder,
  multiline = false,
  className = "",
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  // L'ultimo testo già confermato (o scartato con Escape): Invio conferma e poi il
  // blur che segue (il campo perde il fuoco) non deve confermare una seconda volta.
  const last = useRef<string | null>(null);
  useEffect(() => {
    setDraft(value);
    last.current = null;
  }, [value]);

  function settle() {
    if (draft === value || draft === last.current) return;
    last.current = draft;
    onCommit(draft);
  }

  const common = {
    "aria-label": label,
    value: draft,
    placeholder,
    spellCheck: false,
    onBlur: settle,
    className:
      "w-full min-w-0 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-sm outline-none focus:border-sky-500 " +
      className,
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter" && !(multiline && e.shiftKey)) {
      e.preventDefault();
      settle();
      (e.target as HTMLElement).blur?.();
    } else if (e.key === "Escape") {
      e.preventDefault();
      last.current = draft;
      setDraft(value);
      (e.target as HTMLElement).blur?.();
    }
  };
  return multiline ? (
    <textarea {...common} rows={2} onChange={(e) => { last.current = null; setDraft(e.target.value); }} onKeyDown={onKeyDown} />
  ) : (
    <input {...common} onChange={(e) => { last.current = null; setDraft(e.target.value); }} onKeyDown={onKeyDown} />
  );
}
