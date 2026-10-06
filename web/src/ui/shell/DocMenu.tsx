import { useState } from "react";
import { Button as RacButton, Header, Menu, MenuSection, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { useRenderer } from "../../store/rendererChoice";
import { useTheme } from "./theme";
import { useDocNameEditing } from "./DocName";
import { pickSvgFile } from "../../tools/svgImport";
import { DiagramDialog } from "../DiagramDialog";
import { useAppNavigate } from "../../home/nav";

// THE DOCUMENT MENU: the logo is the button. Inside: Home, new document,
// rename, theme, renderer. The document name and the panel buttons sit
// in the TopBar instead.
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

// Renaming now lives in the name in the middle of the TopBar (shell/DocName.tsx);
// the re-export keeps working whoever imported it from here.
export { renameOpenDocument } from "./DocName";

export function DocMenu({ onNewDocument }: { onNewDocument: () => void }) {
  const navigate = useAppNavigate();
  const theme = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);
  const renderer = useRenderer((s) => s.choice);
  const setRenderer = useRenderer((s) => s.setChoice);
  const [open, setOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  return (
    <>
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <RacButton aria-label="Document menu" className="flex h-9 w-9 items-center justify-center rounded-lg outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]">
        <Logo />
      </RacButton>
      <Popover placement="bottom start" offset={10} className="z-50 min-w-[220px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop">
        <Menu className="outline-none" onAction={(k) => {
          if (k === "home") navigate("/");
          else if (k === "new") onNewDocument();
          else if (k === "rename") useDocNameEditing.getState().setEditing(true);
          else if (k === "import-svg") void pickSvgFile();
          else if (k === "diagram") setDiagramOpen(true);
          else if (k === "renderer") setRenderer(renderer === "gpu" ? "cpu" : "gpu");
          else if (k === "system" || k === "light" || k === "dark") setTheme(k);
        }}>
              <MenuItem id="home" className={ITEM}>
                <Icon name="page" size={14} /> Home
              </MenuItem>
              <MenuItem id="new" className={ITEM}>
                <Icon name="plus" size={14} /> New document
              </MenuItem>
              <MenuItem id="rename" className={ITEM}>
                <Icon name="pen" size={14} /> Rename document
              </MenuItem>
              <MenuItem id="import-svg" className={ITEM}>
                <Icon name="image" size={14} /> Import SVG…
              </MenuItem>
              <MenuItem id="diagram" className={ITEM}>
                <Icon name="plus" size={14} /> Diagram (Mermaid, UML)…
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
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
