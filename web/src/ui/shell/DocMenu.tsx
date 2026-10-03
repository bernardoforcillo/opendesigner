import { useEffect, useRef, useState } from "react";
import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { useScene } from "../../store/store";
import { useRenderer } from "../../store/rendererChoice";
import { docClient } from "../../rpc/client";
import { useTheme } from "./theme";
import { usePanels } from "./panels";
import { pickSvgFile } from "../../tools/svgImport";

// IL MENU DEL DOCUMENTO: il logo è il pulsante. Dentro: il nome del documento
// (rinominabile sul posto), la Home, il nuovo documento, il tema, il renderer.
// Sta nel dock, non in una barra a parte.
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
 * Rinomina il documento aperto: prima sul server (che lo rende durevole), poi
 * nello store, sia nella vista che nella base confermata -- la vista si
 * ricostruisce da quella a ogni record, e un nome scritto solo sulla vista
 * tornerebbe quello vecchio al primo op successivo.
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

// Il nome del documento nell'intestazione del menu: un titolo che diventa un
// campo (Invio conferma, Esc annulla, perdere il fuoco conferma).
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
    // Dopo che il popover ha restituito il fuoco al suo pulsante.
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
        aria-label="Rinomina documento"
        title="Rinomina documento"
        onClick={() => onEditingChange(true)}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-semibold outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
      >
        <span className="min-w-0 flex-1 truncate">{docName === "" ? "Senza titolo" : docName}</span>
        <Icon name="pen" size={12} className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }
  return (
    <div className="px-1 py-0.5">
      <input
        ref={input}
        aria-label="Nome del documento"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Il campo vive dentro un popover di menu: i tasti non devono
          // arrivare alla navigazione/typeahead del menu né alle scorciatoie.
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
  const theme = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);
  const renderer = useRenderer((s) => s.choice);
  const setRenderer = useRenderer((s) => s.setChoice);
  const left = usePanels((s) => s.left);
  const right = usePanels((s) => s.right);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <MenuTrigger isOpen={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(false); }}>
      <RacButton aria-label="Menu del documento" className="flex h-9 w-9 items-center justify-center rounded-lg outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]">
        <Logo />
      </RacButton>
      <Popover placement="top start" offset={10} className="z-50 min-w-[220px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop">
        <DocTitle editing={editing} onEditingChange={setEditing} />
        <Separator className="my-1 h-px bg-line" />
        <Menu className="outline-none" onAction={(k) => {
          if (k === "home") location.hash = "";
          else if (k === "new") onNewDocument();
          else if (k === "rename") setEditing(true);
          else if (k === "import-svg") void pickSvgFile();
          else if (k === "renderer") setRenderer(renderer === "gpu" ? "cpu" : "gpu");
          else if (k === "panel-left") usePanels.getState().toggle("left");
          else if (k === "panel-right") usePanels.getState().toggle("right");
          else if (k === "system" || k === "light" || k === "dark") setTheme(k);
        }}>
              <MenuItem id="home" className={ITEM}>
                <Icon name="page" size={14} /> Home
              </MenuItem>
              <MenuItem id="new" className={ITEM}>
                <Icon name="plus" size={14} /> Nuovo documento
              </MenuItem>
              <MenuItem id="rename" shouldCloseOnSelect={false} className={ITEM}>
                <Icon name="pen" size={14} /> Rinomina documento
              </MenuItem>
              <MenuItem id="import-svg" className={ITEM}>
                <Icon name="image" size={14} /> Importa SVG…
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <MenuItem id="panel-left" className={ITEM}>
                <Icon name="panelLeft" size={14} /> Pannello sinistro
                <span className="ml-auto text-[11px] text-fg-subtle">{left ? "[" : "[ · chiuso"}</span>
              </MenuItem>
              <MenuItem id="panel-right" className={ITEM}>
                <Icon name="panelRight" size={14} /> Pannello destro
                <span className="ml-auto text-[11px] text-fg-subtle">{right ? "]" : "] · chiuso"}</span>
              </MenuItem>
              <MenuItem id="renderer" className={ITEM}>
                <Icon name="bolt" size={14} /> Renderer {renderer === "gpu" ? "GPU" : "CPU"}
                <span className="ml-auto text-[11px] text-fg-subtle">passa a {renderer === "gpu" ? "CPU" : "GPU"}</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Tema</div>
              {([["system", "Come il sistema", "cpu"], ["light", "Chiaro", "sun"], ["dark", "Scuro", "moon"]] as const).map(([id, label, icon]) => (
                <MenuItem key={id} id={id} className={ITEM}>
                  <Icon name={icon} size={14} /> {label}
                  {theme === id && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
