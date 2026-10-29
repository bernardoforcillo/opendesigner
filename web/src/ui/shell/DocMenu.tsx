import { useState } from "react";
import { Button as RacButton, Header, Menu, MenuSection, MenuItem, MenuTrigger, Popover, Separator } from "react-aria-components";
import { Icon } from "@/ui/ds";
import { useRenderer } from "@/store/rendererChoice";
import { useViewPrefs } from "@/store/viewPrefs";
import { useScene } from "@/store/store";
import { useTheme } from "@/ui/shell/theme";
import { LANGUAGES, useLanguage, useT, type LanguageChoice } from "@/i18n";
import { useDocNameEditing } from "@/ui/shell/DocName";
import { pickSvgFile } from "@/tools/svgImport";
import { importFigFile, pickFigFile } from "@/fig/importFig";
import { importPdfFile, pickPdfFile } from "@/pdf/importPdf";
import { pickFile } from "@/ui/pickFile";
import { runCommand } from "@/jobs/commands";
import { runDocumentExport } from "@/export/exportScene";
import { DiagramDialog } from "@/ui/DiagramDialog";
import { VariablesDialog } from "@/ui/VariablesDialog";
import { useShareDialog, useVariablesDialog } from "@/store/dialogs";
import { FontsDialog } from "@/ui/FontsDialog";
import { StylesDialog } from "@/ui/StylesDialog";
import { PageSetupDialog } from "@/ui/PageSetupDialog";
import { FindReplaceDialog } from "@/ui/FindReplaceDialog";
import { SwatchesDialog } from "@/ui/SwatchesDialog";
import { ObjectStylesDialog } from "@/ui/ObjectStylesDialog";
import { LayersDialog } from "@/ui/LayersDialog";
import { LinksDialog } from "@/ui/LinksDialog";
import { PrintPdfDialog } from "@/ui/PrintPdfDialog";
import { DataMergeDialog } from "@/ui/DataMergeDialog";
import { BookMetadataDialog } from "@/ui/BookMetadataDialog";
import { LongDocumentDialog } from "@/ui/LongDocumentDialog";
import { ObjectToolsDialog } from "@/ui/ObjectToolsDialog";
import { InkManagerDialog } from "@/ui/InkManagerDialog";
import { InsertTableDialog } from "@/ui/InsertTableDialog";
import { generateContentsOps } from "@/tools/contents";
import { VersionsDialog } from "@/ui/VersionsDialog";
import { PluginsDialog } from "@/ui/PluginsDialog";
import { ShareDialog } from "@/ui/ShareDialog";
import { BoardDialog } from "@/ui/BoardDialog";
import { useAppNavigate } from "@/home/nav";
import { verticalOf } from "@/store/docSettings";
import { makeSetDocSettingsOp } from "@/tools/ops";
import { menuShows, VERTICAL_LIST } from "@/verticals";

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
export { renameOpenDocument } from "@/ui/shell/DocName";

export function DocMenu({ onNewDocument }: { onNewDocument: () => void }) {
  const navigate = useAppNavigate();
  const { t } = useT();
  const langChoice = useLanguage((s) => s.choice);
  const theme = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);
  const renderer = useRenderer((s) => s.choice);
  const setRenderer = useRenderer((s) => s.setChoice);
  const pixelSnap = useViewPrefs((s) => s.pixelSnap);
  const [open, setOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const variablesOpen = useVariablesDialog((s) => s.open);
  const setVariablesOpen = useVariablesDialog((s) => s.setOpen);
  const [fontsOpen, setFontsOpen] = useState(false);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const shareOpen = useShareDialog((s) => s.open);
  const setShareOpen = useShareDialog((s) => s.setOpen);
  const [boardOpen, setBoardOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [swatchesOpen, setSwatchesOpen] = useState(false);
  const [objectStylesOpen, setObjectStylesOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [longOpen, setLongOpen] = useState(false);
  const [objectToolsOpen, setObjectToolsOpen] = useState(false);
  const [inksOpen, setInksOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  // What this kind of document needs: entries of other kinds of work are tucked away, not removed.
  const vertical = useScene((s) => verticalOf(s.scene));
  const show = (id: string) => menuShows(vertical, id);
  return (
    <>
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <RacButton aria-label={t("Document menu")} className="flex h-9 w-9 items-center justify-center rounded-lg outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]">
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
              useScene.setState({ notice: r.ok ? `${r.message}${left}` : `.fig import failed: ${r.message}` });
            });
          }
          else if (k === "import-pdf" || k === "import-pdf-image") {
            void pickPdfFile().then(async (f) => {
              if (!f) return;
              useScene.setState({ notice: `Importing ${f.name}…` });
              const r = await importPdfFile(f, undefined, k === "import-pdf" ? "editable" : "image");
              useScene.setState({ notice: r.ok ? r.message : `PDF import failed: ${r.message}` });
            });
          }
          else if (k === "import-idml" || k === "place-document") {
            void pickFile(k === "import-idml" ? ".idml" : ".docx,.rtf,.xlsx").then(async (f) => {
              if (!f) return;
              useScene.setState({ notice: `Reading ${f.name}…` });
              const r = await runCommand({ name: k === "import-idml" ? "import_idml" : "place_document" }, f);
              const data = r.ok && r.text ? (JSON.parse(r.text) as { message?: string }) : null;
              useScene.setState({ notice: r.ok ? data?.message ?? "Done." : `${f.name}: ${r.message}` });
            });
          }
          else if (k === "export-html") void runDocumentExport("html");
          else if (k === "export-pptx") void runDocumentExport("pptx");
          else if (k === "export-idml") void runDocumentExport("idml");
          else if (k === "export-pdf") void runDocumentExport("pdf");
          else if (k === "export-pdf-bleed") setPrintOpen(true);
          else if (k === "page-setup") setPageSetupOpen(true);
          else if (k === "export-epub") void runDocumentExport("epub");
          else if (k === "export-epub-reflow") void runDocumentExport("epub-reflow");
          else if (k === "export-html-text") void runDocumentExport("html-text");
          else if (k === "diagram") setDiagramOpen(true);
          else if (k === "variables") setVariablesOpen(true);
          else if (k === "fonts") setFontsOpen(true);
          else if (k === "styles") setStylesOpen(true);
          else if (k === "find") setFindOpen(true);
          else if (k === "swatches") setSwatchesOpen(true);
          else if (k === "object-styles") setObjectStylesOpen(true);
          else if (k === "layers") setLayersOpen(true);
          else if (k === "links") setLinksOpen(true);
          else if (k === "data-merge") setMergeOpen(true);
          else if (k === "book-metadata") setBookOpen(true);
          else if (k === "long-document") setLongOpen(true);
          else if (k === "object-tools") setObjectToolsOpen(true);
          else if (k === "ink-manager") setInksOpen(true);
          else if (k === "table") setTableOpen(true);
          else if (k === "contents" || k === "index" || k === "endnotes") generateContents(k === "contents" ? "toc" : k === "index" ? "index" : "endnotes");
          else if (k === "versions") setVersionsOpen(true);
          else if (k === "plugins") setPluginsOpen(true);
          else if (k === "share") setShareOpen(true);
          else if (k === "board") setBoardOpen(true);
          else if (typeof k === "string" && k.startsWith("vertical:")) {
            const v = k.slice("vertical:".length) as (typeof VERTICAL_LIST)[number]["id"];
            const st = useScene.getState();
            const cur = st.scene?.settings ?? {};
            st.beginGesture();
            st.endGesture([makeSetDocSettingsOp({ ...cur, vertical: v === "product" ? undefined : v })]);
          }
          else if (k === "pixel-snap") useViewPrefs.getState().cyclePixelSnap();
          else if (k === "renderer") setRenderer(renderer === "gpu" ? "cpu" : "gpu");
          else if (k === "system" || k === "light" || k === "dark") setTheme(k);
          else if (typeof k === "string" && k.startsWith("lang:")) useLanguage.getState().set(k.slice("lang:".length) as LanguageChoice);
        }}>
              <MenuItem id="home" className={ITEM}>
                <Icon name="page" size={14} /> {t("Home")}
              </MenuItem>
              <MenuItem id="new" className={ITEM}>
                <Icon name="plus" size={14} /> {t("New document")}
              </MenuItem>
              <MenuItem id="rename" className={ITEM}>
                <Icon name="pen" size={14} /> {t("Rename document")}
              </MenuItem>
              <MenuItem id="import-svg" className={ITEM}>
                <Icon name="image" size={14} /> {t("Import SVG…")}
              </MenuItem>
              {show("import-fig") && (
                <MenuItem id="import-fig" className={ITEM}>
                <Icon name="image" size={14} /> {t("Import .fig file…")} <span className="ml-auto text-[11px] text-fg-subtle">{t("experimental")}</span>
              </MenuItem>
              )}
              <MenuItem id="import-pdf" className={ITEM}>
                <Icon name="page" size={14} /> {t("Import PDF…")} <span className="ml-auto text-[11px] text-fg-subtle">{t("editable text and shapes")}</span>
              </MenuItem>
              <MenuItem id="import-pdf-image" className={ITEM}>
                <Icon name="image" size={14} /> {t("Import PDF as pictures…")}
              </MenuItem>
              <MenuItem id="import-idml" className={ITEM}>
                <Icon name="page" size={14} /> Import InDesign IDML… <span className="ml-auto text-[11px] text-fg-subtle">shapes and text</span>
              </MenuItem>
              <MenuItem id="place-document" className={ITEM}>
                <Icon name="page" size={14} /> Place Word, RTF or Excel…
              </MenuItem>
              <MenuItem id="export-html" className={ITEM}>
                <Icon name="download" size={14} /> Export all pages as HTML
              </MenuItem>
              <MenuItem id="export-pptx" className={ITEM}>
                <Icon name="download" size={14} /> Export as PowerPoint (.pptx)
              </MenuItem>
              <MenuItem id="export-idml" className={ITEM}>
                <Icon name="download" size={14} /> Export as InDesign IDML
              </MenuItem>
              <MenuItem id="export-pdf" className={ITEM}>
                <Icon name="download" size={14} /> {t("Export all pages as PDF…")}
              </MenuItem>
              {show("export-pdf-bleed") && (
                <MenuItem id="export-pdf-bleed" className={ITEM}>
                  <Icon name="download" size={14} /> {t("Export PDF for print (with bleed)…")}
                </MenuItem>
              )}
              {show("export-epub") && (
                <MenuItem id="export-epub" className={ITEM}>
                  <Icon name="download" size={14} /> {t("Export all pages as EPUB")}
                </MenuItem>
              )}
              {show("export-epub") && (
                <MenuItem id="export-epub-reflow" className={ITEM}>
                  <Icon name="download" size={14} /> Export text as EPUB (reflowable)
                </MenuItem>
              )}
              {show("export-epub") && (
                <MenuItem id="export-html-text" className={ITEM}>
                  <Icon name="download" size={14} /> Export text as HTML (reflowable)
                </MenuItem>
              )}
              {show("page-setup") && (
                <MenuItem id="page-setup" className={ITEM}>
                  <Icon name="page" size={14} /> {t("Page setup…")}
                </MenuItem>
              )}
              <MenuItem id="diagram" className={ITEM}>
                <Icon name="plus" size={14} /> {t("Diagram (Mermaid, UML)…")}
              </MenuItem>
              {show("board") && (
                <MenuItem id="board" className={ITEM}>
                <Icon name="plus" size={14} /> {t("Whiteboard (sticky, table, kanban…)…")}
              </MenuItem>
              )}
              {show("variables") && (
                <MenuItem id="variables" className={ITEM}>
                <Icon name="plus" size={14} /> {t("Variables…")}
              </MenuItem>
              )}
              <MenuItem id="fonts" className={ITEM}>
                <Icon name="plus" size={14} /> {t("Fonts…")}
              </MenuItem>
              <MenuItem id="styles" className={ITEM}>
                <Icon name="plus" size={14} /> {t("Styles (paragraph, character)…")}
              </MenuItem>
              <MenuItem id="swatches" className={ITEM}>
                <Icon name="grid" size={14} /> Swatches and colour mode…
              </MenuItem>
              <MenuItem id="object-styles" className={ITEM}>
                <Icon name="plus" size={14} /> Object styles…
              </MenuItem>
              <MenuItem id="layers" className={ITEM}>
                <Icon name="layers" size={14} /> Layers (shared by all pages)…
              </MenuItem>
              <MenuItem id="links" className={ITEM}>
                <Icon name="link" size={14} /> Links (images)…
              </MenuItem>
              <MenuItem id="ink-manager" className={ITEM}>
                <Icon name="plus" size={14} /> Ink manager (spot inks, overprint)…
              </MenuItem>
              <MenuItem id="object-tools" className={ITEM}>
                <Icon name="plus" size={14} /> Object tools (repeat, gap, QR, clip, snippets)…
              </MenuItem>
              <MenuItem id="long-document" className={ITEM}>
                <Icon name="plus" size={14} /> Long documents (conditions, table styles, notes)…
              </MenuItem>
              <MenuItem id="book-metadata" className={ITEM}>
                <Icon name="plus" size={14} /> Book metadata (ONIX)…
              </MenuItem>
              <MenuItem id="data-merge" className={ITEM}>
                <Icon name="plus" size={14} /> Data merge (CSV)…
              </MenuItem>
              <MenuItem id="find" className={ITEM}>
                <Icon name="search" size={14} /> Find and change…
              </MenuItem>
              <MenuItem id="table" className={ITEM}>
                <Icon name="plus" size={14} /> Insert table…
              </MenuItem>
              {show("contents") && (
                <>
                  <MenuItem id="contents" className={ITEM}>
                    <Icon name="page" size={14} /> Table of contents <span className="ml-auto text-[11px] text-fg-subtle">from heading styles</span>
                  </MenuItem>
                  <MenuItem id="index" className={ITEM}>
                    <Icon name="page" size={14} /> Index <span className="ml-auto text-[11px] text-fg-subtle">from [#term] marks</span>
                  </MenuItem>
                  <MenuItem id="endnotes" className={ITEM}>
                    <Icon name="page" size={14} /> Endnotes <span className="ml-auto text-[11px] text-fg-subtle">from [*note] marks</span>
                  </MenuItem>
                </>
              )}
              <MenuItem id="versions" className={ITEM}>
                <Icon name="page" size={14} /> {t("Versions…")}
              </MenuItem>
              <MenuItem id="share" className={ITEM}>
                <Icon name="share" size={14} /> {t("Share…")}
              </MenuItem>
              {show("plugins") && (
                <MenuItem id="plugins" className={ITEM}>
                <Icon name="code" size={14} /> {t("Plugins…")}
              </MenuItem>
              )}
              <Separator className="my-1 h-px bg-line" />
              <MenuItem id="pixel-snap" className={ITEM}>
                <Icon name="plus" size={14} /> {pixelSnap > 0 ? t("Pixel snap {n} px", { n: pixelSnap }) : t("Pixel snap off")}
                <span className="ml-auto text-[11px] text-fg-subtle">{t("cycles 1 / 4 / 8 / off")}</span>
              </MenuItem>
              <MenuItem id="renderer" className={ITEM}>
                <Icon name="bolt" size={14} /> {t("Renderer {name}", { name: renderer === "gpu" ? "GPU" : "CPU" })}
                <span className="ml-auto text-[11px] text-fg-subtle">{t("switch to {name}", { name: renderer === "gpu" ? "CPU" : "GPU" })}</span>
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <MenuSection>
              <Header className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">{t("Document type")}</Header>
              {VERTICAL_LIST.map((v) => (
                <MenuItem key={v.id} id={`vertical:${v.id}`} className={ITEM}>
                  <Icon name={v.icon} size={14} /> {v.name}
                  {vertical === v.id && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
              </MenuSection>
              <Separator className="my-1 h-px bg-line" />
              <MenuSection>
              <Header className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">{t("Theme")}</Header>
              {([["system", "System", "cpu"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]] as const).map(([id, label, icon]) => (
                <MenuItem key={id} id={id} className={ITEM}>
                  <Icon name={icon} size={14} /> {t(label)}
                  {theme === id && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
              </MenuSection>
              <Separator className="my-1 h-px bg-line" />
              <MenuSection>
              <Header className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">{t("Language")}</Header>
              <MenuItem id="lang:system" className={ITEM}>
                <Icon name="cpu" size={14} /> {t("System")}
                {langChoice === "system" && <Icon name="check" size={14} className="ml-auto text-accent" />}
              </MenuItem>
              {LANGUAGES.map((l) => (
                <MenuItem key={l.code} id={`lang:${l.code}`} className={ITEM} textValue={l.name}>
                  <span lang={l.code}>{l.name}</span>
                  {l.draft && <span className="text-[11px] text-fg-subtle">{t("machine draft")}</span>}
                  {langChoice === l.code && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
              </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
    <DiagramDialog isOpen={diagramOpen} onOpenChange={setDiagramOpen} />
    <VariablesDialog isOpen={variablesOpen} onOpenChange={setVariablesOpen} />
    <FontsDialog isOpen={fontsOpen} onOpenChange={setFontsOpen} />
    <StylesDialog isOpen={stylesOpen} onOpenChange={setStylesOpen} />
    <PageSetupDialog isOpen={pageSetupOpen} onOpenChange={setPageSetupOpen} />
    <VersionsDialog isOpen={versionsOpen} onOpenChange={setVersionsOpen} />
    <PluginsDialog isOpen={pluginsOpen} onOpenChange={setPluginsOpen} />
    <ShareDialog isOpen={shareOpen} onOpenChange={setShareOpen} />
    <BoardDialog isOpen={boardOpen} onOpenChange={setBoardOpen} />
    <FindReplaceDialog isOpen={findOpen} onOpenChange={setFindOpen} />
    <SwatchesDialog isOpen={swatchesOpen} onOpenChange={setSwatchesOpen} />
    <ObjectStylesDialog isOpen={objectStylesOpen} onOpenChange={setObjectStylesOpen} />
    <LayersDialog isOpen={layersOpen} onOpenChange={setLayersOpen} />
    <LinksDialog isOpen={linksOpen} onOpenChange={setLinksOpen} />
    <PrintPdfDialog isOpen={printOpen} onOpenChange={setPrintOpen} />
    <DataMergeDialog isOpen={mergeOpen} onOpenChange={setMergeOpen} />
    <BookMetadataDialog isOpen={bookOpen} onOpenChange={setBookOpen} />
    <LongDocumentDialog isOpen={longOpen} onOpenChange={setLongOpen} />
    <ObjectToolsDialog isOpen={objectToolsOpen} onOpenChange={setObjectToolsOpen} />
    <InkManagerDialog isOpen={inksOpen} onOpenChange={setInksOpen} />
    <InsertTableDialog isOpen={tableOpen} onOpenChange={setTableOpen} />
    </>
  );
}

// Writes (or refreshes) the contents or the index of the document into its frame on the page on screen.
function generateContents(kind: "toc" | "index" | "endnotes"): void {
  const st = useScene.getState();
  const scene = st.scene;
  const pageId = st.currentPageId ?? scene?.pages[0]?.id;
  if (!scene || !pageId) return;
  const made = generateContentsOps(scene, kind, pageId);
  if (!made) {
    useScene.setState({ notice: kind === "toc"
      ? "No headings yet: give a paragraph style a heading level (Styles… → Heading level) and use it."
      : kind === "endnotes" ? "No endnotes yet: write [*the note] in the text where the reference goes."
      : "No index terms yet: mark a word in the text with [#term]." });
    return;
  }
  st.beginGesture();
  st.endGesture(made.ops);
  st.setSelection(made.selection);
  useScene.setState({ notice: `${kind === "toc" ? "Contents" : kind === "endnotes" ? "Endnotes" : "Index"} written: ${made.lines} ${made.lines === 1 ? "line" : "lines"}.` });
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
