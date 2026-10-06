import { useEffect, useRef, useState } from "react";
import { Button as RacButton, Header, Menu, MenuSection, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { useScene } from "../../store/store";
import { useRenderer } from "../../store/rendererChoice";
import { docClient } from "../../rpc/client";
import { useTheme } from "./theme";
import { usePanels } from "./panels";
import { pickSvgFile } from "../../tools/svgImport";
import { DiagramDialog } from "../DiagramDialog";
import { useAppNavigate } from "../../home/nav";

// THE DOCUMENT MENU: the logo is the button. Inside: the document name
// (renamable in place), Home, new document, theme, renderer.
// It sits in the dock, not in a separate bar.
export function Logo() {
  return (
    <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="var(--accent)" />
      <rect x="6.5" y="6.5" width="8" height="8" rx="2" fill="var(--accent-fg)" opacity="0.95" />
      <circle cx="19.5" cy="19.5" r="3.6" fill="none" stroke="var(--accent-fg)" strokeWidth="2" />
      <path d="M14.8 10.5h3a2.2 2.2 0 012.2 2.2v3.6" stroke="var(--accent-fg)" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}

/**
 * Renames the open document: first on the server (which makes it durable), then
 * in the store, both in the view and in the confirmed base -- the view is
 * rebuilt from that one on every record, and a name written only on the view
 * would go back to the old one at the next op.
 */
export async function renameOpenDocument(name: string, client: Pick<typeof docClient, "renameDocument"> = docClient): Promise<void> {
  const scene = useScene.getState().scene;
  if (!scene) return;
  await client.renameDocument({ docId: scene.id, name });
  useScene.setState((st) => ({
    scene: st.scene ? { ...st.scene, name } : st.scene,
    confirmed: st.confirmed ? { ...st.confirmed, name } : st.confirmed,
  }));
}

// The document name in the menu header: a title that becomes a
// field (Enter confirms, Esc cancels, losing focus confirms).
function DocTitle({ editing, onEditingChange }: { editing: boolean; onEditingChange: (v: boolean) => void }) {
  const docName = useScene((s) => s.scene?.name ?? "");
  const [draft, setDraft] = useState(docName);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!editing) return;
    done.current = false;
    setDraft(docName);
    setError(null);
    // After the popover has returned focus to its button.
    const t = setTimeout(() => { input.current?.focus(); input.current?.select(); }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  async function commit() {
    if (done.current) return;
    const name = draft.trim();
    if (name === "" || name === docName) { done.current = true; onEditingChange(false); return; }
    done.current = true;
    try {
      await renameOpenDocument(name);
      onEditingChange(false);
    } catch (e) {
      done.current = false;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        aria-label="Rename document"
        title="Rename document"
        onClick={() => onEditingChange(true)}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-semibold outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
      >
        <span className="min-w-0 flex-1 truncate">{docName === "" ? "Untitled" : docName}</span>
        <Icon name="pen" size={12} className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }
  return (
    <div className="px-1 py-0.5">
      <input
        ref={input}
        aria-label="Document name"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // The field lives inside a menu popover: keys must not
          // reach the menu's navigation/typeahead nor the shortcuts.
          e.stopPropagation();
          if (e.key === "Enter") void commit();
          else if (e.key === "Escape") { done.current = true; onEditingChange(false); }
        }}
        onBlur={() => void commit()}
        className="h-7 w-full rounded-md border border-accent bg-surface px-2 text-[13px] font-semibold text-fg outline-none"
      />
      {error && <p role="alert" className="px-1 pt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

export function DocMenu({ onNewDocument }: { onNewDocument: () => void }) {
  const navigate = useAppNavigate();
  const theme = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);
  const renderer = useRenderer((s) => s.choice);
  const setRenderer = useRenderer((s) => s.setChoice);
  const left = usePanels((s) => s.left);
  const right = usePanels((s) => s.right);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  return (
    <>
    <MenuTrigger isOpen={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(false); }}>
      <RacButton aria-label="Document menu" className="flex h-9 w-9 items-center justify-center rounded-lg outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]">
        <Logo />
      </RacButton>
      <Popover placement="top start" offset={10} className="z-50 min-w-[220px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop">
        <DocTitle editing={editing} onEditingChange={setEditing} />
        <Separator className="my-1 h-px bg-line" />
        <Menu className="outline-none" onAction={(k) => {
          if (k === "home") navigate("/");
          else if (k === "new") onNewDocument();
          else if (k === "rename") setEditing(true);
          else if (k === "import-svg") void pickSvgFile();
          else if (k === "diagram") setDiagramOpen(true);
          else if (k === "renderer") setRenderer(renderer === "gpu" ? "cpu" : "gpu");
          else if (k === "panel-left") usePanels.getState().toggle("left");
          else if (k === "panel-right") usePanels.getState().toggle("right");
          else if (k === "system" || k === "light" || k === "dark") setTheme(k);
        }}>
              <MenuItem id="home" className={ITEM}>
                <Icon name="page" size={14} /> Home
              </MenuItem>
              <MenuItem id="new" className={ITEM}>
                <Icon name="plus" size={14} /> New document
              </MenuItem>
              <MenuItem id="rename" shouldCloseOnSelect={false} className={ITEM}>
                <Icon name="pen" size={14} /> Rename document
              </MenuItem>
              <MenuItem id="import-svg" className={ITEM}>
                <Icon name="image" size={14} /> Import SVG…
              </MenuItem>
              <MenuItem id="diagram" className={ITEM}>
                <Icon name="plus" size={14} /> Diagram (Mermaid, UML)…
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <MenuItem id="panel-left" className={ITEM}>
                <Icon name="panelLeft" size={14} /> Left panel
                <span className="ml-auto text-[11px] text-fg-subtle">{left ? "[" : "[ · closed"}</span>
              </MenuItem>
              <MenuItem id="panel-right" className={ITEM}>
                <Icon name="panelRight" size={14} /> Right panel
                <span className="ml-auto text-[11px] text-fg-subtle">{right ? "]" : "] · closed"}</span>
              </MenuItem>
              <MenuItem id="renderer" className={ITEM}>
                <Icon name="bolt" size={14} /> Renderer {renderer === "gpu" ? "GPU" : "CPU"}
                <span className="ml-auto text-[11px] text-fg-subtle">switch to {renderer === "gpu" ? "CPU" : "GPU"}</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <MenuSection>
              <Header className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Theme</Header>
              {([["system", "System", "cpu"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]] as const).map(([id, label, icon]) => (
                <MenuItem key={id} id={id} className={ITEM}>
                  <Icon name={icon} size={14} /> {label}
                  {theme === id && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
              </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
    <DiagramDialog isOpen={diagramOpen} onOpenChange={setDiagramOpen} />
    </>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
