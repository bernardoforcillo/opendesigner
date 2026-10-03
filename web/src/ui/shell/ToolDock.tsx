import { useEffect } from "react";
import { ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import { Icon, Kbd, type IconName } from "../ds";
import type { ToolId } from "../../tools/types";
import { isTextField } from "../../tools/toolManager";

// IL DOCK DEGLI STRUMENTI: una barra flottante in basso al centro della tela,
// come in ogni editor di design -- gli strumenti stanno dove sta la mano, non in
// una barra di menu. Un solo strumento attivo alla volta (radiogroup: la
// semantica giusta, e quella che i test interrogano).
const ICON: Record<string, IconName> = {
  select: "select", connect: "connect", frame: "frame", rect: "rect",
  ellipse: "ellipse", text: "text", pen: "pen", hand: "hand",
};

// Scorciatoie a tasto singolo. F (alterna Design/Flussi) e K (Collega) vivono in
// App; qui ci sono quelle di disegno. Mai dentro un campo di testo né con un
// modificatore premuto.
export const TOOL_KEYS: Partial<Record<ToolId, string>> = {
  select: "V", frame: "A", rect: "R", ellipse: "O", text: "T", pen: "P", hand: "H", connect: "K",
};

export function ToolDock({
  tools, toolId, onChoose,
}: { tools: readonly { id: ToolId; label: string }[]; toolId: ToolId; onChoose: (id: ToolId) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const k = e.key.toUpperCase();
      const hit = tools.find((t) => TOOL_KEYS[t.id] === k && t.id !== "connect");
      if (hit) { e.preventDefault(); onChoose(hit.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tools, onChoose]);

  return (
    <div
      role="toolbar"
      aria-label="Strumenti"
      className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-xl bg-raised p-1 shadow-bar"
    >
      <ToggleButtonGroup
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[toolId]}
        className="flex items-center gap-0.5"
        onSelectionChange={(keys) => onChoose((keys.values().next().value as ToolId | undefined) ?? "select")}
      >
        {tools.map((t, i) => {
          const sep = t.id === "hand" || (t.id === "connect" && i > 0);
          return (
            <span key={t.id} className="flex items-center">
              {sep && i > 0 && <span className="mx-1 h-5 w-px bg-line" />}
              <TooltipTrigger delay={300} closeDelay={0}>
                <ToggleButton
                  id={t.id}
                  aria-label={t.label}
                  className={({ isSelected }) =>
                    `flex h-9 w-9 items-center justify-center rounded-lg outline-none transition-colors ` +
                    `focus-visible:shadow-[var(--ring)] ` +
                    (isSelected
                      ? t.id === "connect" ? "bg-flow text-white" : "bg-accent text-accent-fg"
                      : "text-fg-muted hover:bg-surface-3 hover:text-fg")
                  }
                >
                  <Icon name={ICON[t.id] ?? "select"} size={18} />
                </ToggleButton>
                <Tooltip offset={10} className="z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop">
                  {t.label}
                  {TOOL_KEYS[t.id] && <Kbd inverted>{TOOL_KEYS[t.id]}</Kbd>}
                </Tooltip>
              </TooltipTrigger>
            </span>
          );
        })}
      </ToggleButtonGroup>
    </div>
  );
}
