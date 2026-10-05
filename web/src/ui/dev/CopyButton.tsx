import { useEffect, useRef, useState } from "react";
import { Button as RacButton } from "react-aria-components";
import { Icon } from "../ds";

// Copy to the clipboard with confirmation ("Copied" for a second). `navigator.clipboard`
// is missing outside a secure context and in jsdom: there we fall back to a temporary
// textarea + execCommand, and if even that fails the button stays as it was
// (no lying confirmation).

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  text, label = "Copy", doneLabel = "Copied", className = "", iconOnly,
}: { text: string | (() => string); label?: string; doneLabel?: string; className?: string; iconOnly?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <RacButton
      aria-label={done ? doneLabel : label}
      onPress={async () => {
        const ok = await copyText(typeof text === "function" ? text() : text);
        if (!ok) return;
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium outline-none transition-colors ` +
        `focus-visible:shadow-[var(--ring)] ${done ? "text-ok" : "text-fg-muted hover:bg-surface-3 hover:text-fg"} ${className}`}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
      {!iconOnly && <span>{done ? doneLabel : label}</span>}
    </RacButton>
  );
}
