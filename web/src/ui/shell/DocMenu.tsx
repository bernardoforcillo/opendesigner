import { useState } from "react";
import { Button as RacButton, Header, Menu, MenuSection, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "../ds";
import { useRenderer } from "../../store/rendererChoice";
import { useViewPrefs } from "../../store/viewPrefs";
import { useScene } from "../../store/store";
import { useTheme } from "./theme";
import { useDocNameEditing } from "./DocName";
import { pickSvgFile } from "../../tools/svgImport";
import { importFigFile, pickFigFile } from "../../fig/importFig";
import { DiagramDialog } from "../DiagramDialog";
import { VariablesDialog } from "../VariablesDialog";
import { FontsDialog } from "../FontsDialog";
import { VersionsDialog } from "../VersionsDialog";
import { PluginsDialog } from "../PluginsDialog";
import { ShareDialog } from "../ShareDialog";
import { BoardDialog } from "../BoardDialog";
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
  const pixelSnap = useViewPrefs((s) => s.pixelSnap);
  const [open, setOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [fontsOpen, setFontsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
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
          else if (k === "import-fig") {
            void pickFigFile().then(async (f) => {
              if (!f) return;
              const r = await importFigFile(f);
              // The banner the SVG import uses: what came across, or why nothing did, and what was left out.
              const left = r.warnings.length > 0 ? ` Not carried over: ${r.warnings.join("; ")}.` : "";
              useScene.setState({ notice: r.ok ? `${r.message}${left}` : `Figma import failed: ${r.message}` });
            });
          }
          else if (k === "diagram") setDiagramOpen(true);
          else if (k === "variables") setVariablesOpen(true);
          else if (k === "fonts") setFontsOpen(true);
          else if (k === "versions") setVersionsOpen(true);
          else if (k === "plugins") setPluginsOpen(true);
          else if (k === "share") setShareOpen(true);
          else if (k === "board") setBoardOpen(true);
          else if (k === "pixel-snap") useViewPrefs.getState().cyclePixelSnap();
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
              <MenuItem id="import-fig" className={ITEM}>
                <Icon name="image" size={14} /> Import Figma file… <span className="ml-auto text-[11px] text-fg-subtle">experimental</span>
              </MenuItem>
              <MenuItem id="diagram" className={ITEM}>
                <Icon name="plus" size={14} /> Diagram (Mermaid, UML)…
              </MenuItem>
              <MenuItem id="board" className={ITEM}>
                <Icon name="plus" size={14} /> Whiteboard (sticky, table, kanban…)…
              </MenuItem>
              <MenuItem id="variables" className={ITEM}>
                <Icon name="plus" size={14} /> Variables…
              </MenuItem>
              <MenuItem id="fonts" className={ITEM}>
                <Icon name="plus" size={14} /> Fonts…
              </MenuItem>
              <MenuItem id="versions" className={ITEM}>
                <Icon name="page" size={14} /> Versions…
              </MenuItem>
              <MenuItem id="share" className={ITEM}>
                <Icon name="share" size={14} /> Share…
              </MenuItem>
              <MenuItem id="plugins" className={ITEM}>
                <Icon name="code" size={14} /> Plugins…
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <MenuItem id="pixel-snap" className={ITEM}>
                <Icon name="plus" size={14} /> Pixel snap {pixelSnap > 0 ? `${pixelSnap} px` : "off"}
                <span className="ml-auto text-[11px] text-fg-subtle">cycles 1 / 4 / 8 / off</span>
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
    <VariablesDialog isOpen={variablesOpen} onOpenChange={setVariablesOpen} />
    <FontsDialog isOpen={fontsOpen} onOpenChange={setFontsOpen} />
    <VersionsDialog isOpen={versionsOpen} onOpenChange={setVersionsOpen} />
    <PluginsDialog isOpen={pluginsOpen} onOpenChange={setPluginsOpen} />
    <ShareDialog isOpen={shareOpen} onOpenChange={setShareOpen} />
    <BoardDialog isOpen={boardOpen} onOpenChange={setBoardOpen} />
    </>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
