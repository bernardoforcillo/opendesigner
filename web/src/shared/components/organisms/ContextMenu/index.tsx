import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useContextMenu, type MenuEntry } from "@/ui/contextMenuStore";

// The context menu host: mounted once (in the App), it draws the menu `useContextMenu` holds at the
// pointer, kept inside the viewport. It closes on Escape, on a click elsewhere, on scroll and on
// resize, and after an entry runs. Keyboard: arrows move, Right opens a submenu, Left closes it,
// Enter / Space run the focused entry.

const PANEL = "z-[60] min-w-[11rem] rounded-lg border border-line bg-surface p-1 text-[13px] text-fg shadow-lg";
const ITEM = "flex h-7 w-full items-center justify-between gap-6 rounded-md px-2 text-left outline-none " +
  "hover:bg-surface-3 focus:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent";

type Item = Extract<MenuEntry, { id: string }>;

function Menu({ entries, x, y, onClose, closeAll, depth = 0 }: { entries: readonly MenuEntry[]; x: number; y: number; onClose: () => void; closeAll: () => void; depth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ id: string; x: number; y: number } | null>(null);

  // Keep the menu inside the viewport once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  useEffect(() => {
    if (depth === 0) own()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  // This menu's own entries (not those of a submenu open inside it).
  const own = (): HTMLElement[] =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []).filter((el) => el.closest('[role="menu"]') === ref.current);
  const items = own;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(i + step + list.length) % list.length]?.focus();
    } else if (e.key === "ArrowLeft" && depth > 0) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const open = (it: Item, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSub({ id: it.id, x: r.right - 2, y: r.top - 4 });
  };

  return (
    <div ref={ref} role="menu" aria-label="Context menu" className={`${PANEL} fixed`} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {entries.map((e, k) => {
        if (e.type === "separator") return <div key={`sep${k}`} role="separator" className="my-1 h-px bg-line" />;
        const it = e;
        return (
          <div key={it.id} className="contents">
            <button
              type="button" role="menuitem" disabled={it.disabled}
              aria-haspopup={it.children ? "menu" : undefined} aria-expanded={it.children ? sub?.id === it.id : undefined}
              className={`${ITEM} ${it.danger ? "text-danger" : ""}`}
              onMouseEnter={(ev) => (it.children && !it.disabled ? open(it, ev.currentTarget) : setSub(null))}
              onKeyDown={(ev) => {
                if (it.children && !it.disabled && (ev.key === "ArrowRight" || ev.key === "Enter" || ev.key === " ")) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  open(it, ev.currentTarget);
                }
              }}
              onClick={(ev) => {
                if (it.children) return open(it, ev.currentTarget);
                closeAll();
                it.onSelect?.();
              }}
            >
              <span className="truncate">{it.label}</span>
              {it.children ? <span aria-hidden>›</span> : it.shortcut ? <span className="font-mono text-[11px] text-fg-subtle">{it.shortcut}</span> : null}
            </button>
            {it.children && sub?.id === it.id && (
              <Menu entries={it.children} x={sub.x} y={sub.y} depth={depth + 1} onClose={() => setSub(null)} closeAll={closeAll} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenuHost() {
  const open = useContextMenu((s) => s.open);
  const hide = useContextMenu((s) => s.hide);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('[role="menu"]')) hide();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("wheel", hide, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("wheel", hide);
    };
  }, [open, hide]);
  if (!open) return null;
  return createPortal(<Menu key={`${open.x},${open.y}`} entries={open.entries} x={open.x} y={open.y} onClose={hide} closeAll={hide} />, document.body);
}
