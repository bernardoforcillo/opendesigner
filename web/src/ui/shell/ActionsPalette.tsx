import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Kbd } from "@/ui/ds";
import { rankActions, useActionsPalette, type PaletteAction } from "@/store/actions";

// THE ACTIONS PALETTE (Ctrl/Cmd+K, or Ctrl/Cmd+/): type to find a command and press Enter. Up and Down move
// the highlight, Escape closes. It runs the same functions as the buttons and shortcuts (see
// ui/shell/paletteActions.ts) and closes itself first, so a command that moves focus is not fighting it.
export function ActionsPalette({ actions }: { actions: readonly PaletteAction[] }) {
  const open = useActionsPalette((s) => s.open);
  const setOpen = useActionsPalette((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K" || e.key === "/")) {
        e.preventDefault();
        useActionsPalette.getState().setOpen(!useActionsPalette.getState().open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (open) { setQuery(""); setAt(0); } }, [open]);

  const results = useMemo(() => rankActions(actions, query), [actions, query]);
  const active = Math.min(at, Math.max(0, results.length - 1));
  useEffect(() => { listRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" }); }, [active]);

  const run = (a: PaletteAction | undefined) => {
    if (!a) return;
    setOpen(false);
    a.run();
  };

  return (
    <ModalOverlay isDismissable isOpen={open} onOpenChange={setOpen} className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[15vh]">
      <Modal className="w-full max-w-[520px] overflow-hidden rounded-xl bg-raised text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Actions" className="flex flex-col outline-none">
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
            aria-label="Search actions"
            placeholder="Search actions"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setAt(Math.min(results.length - 1, active + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(0, active - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(results[active]); }
            }}
            className="h-11 border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-fg-subtle"
          />
          <ul id="palette-list" ref={listRef} role="listbox" aria-label="Actions" className="max-h-[50vh] overflow-y-auto p-1">
            {results.length === 0 && <li className="px-3 py-6 text-center text-fg-subtle">No matching action</li>}
            {results.map((a, i) => (
              <li
                key={a.id}
                id={`palette-${a.id}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setAt(i)}
                onClick={() => run(a)}
                className={"flex h-8 cursor-default items-center gap-2 rounded-md px-3 " + (i === active ? "bg-accent-soft text-accent" : "")}
              >
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="shrink-0 text-[11px] text-fg-subtle">{a.group}</span>
                {a.keys && <Kbd>{a.keys}</Kbd>}
              </li>
            ))}
          </ul>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
