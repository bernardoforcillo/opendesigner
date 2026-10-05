import { useEffect, useRef, useState } from "react";
import { cls } from "../ds";

// A text field that commits on Enter or on blur, exactly ONCE. Twin of
// OverrideTextField (PropertiesPanel) and of the rename fields: the typed draft
// is local state and restarts from `value` when it changes from outside (commit
// succeeded, selection change). This way every edit is ONE op and ONE undo entry,
// not one per keystroke.
//
// No key leaves the field: global shortcuts (undo/redo on window,
// Delete/Escape/K of the canvas) must not act while typing.
export function CommitField({
  label,
  value,
  onCommit,
  placeholder,
  multiline = false,
  className = "",
  title,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState(value);
  // The last text already committed (or discarded with Escape): Enter commits and then the
  // blur that follows (the field loses focus) must not commit a second time.
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
    title,
    value: draft,
    placeholder,
    spellCheck: false,
    onBlur: settle,
    // The same inset field as every other input in the system (cls.input);
    // multiline text loses the fixed height and gets some room.
    className: `${cls.input} ${multiline ? "h-auto resize-none py-1 leading-snug" : ""} ${className}`,
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
