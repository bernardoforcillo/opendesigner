# Verticals: publishing, design, design × development

opendesigner is one editor for three kinds of work. A document is made for one of them -- its **vertical** -- and the editor shows what that work needs. A vertical shapes the interface and the starting points (which modes, tools and menu entries are offered, the templates on the Home, how a new page starts); it **never limits what a document can hold**: any document opens in any vertical's editor, and changing the vertical loses nothing.

| Vertical | For | Modes | Starting points |
|---|---|---|---|
| **Publishing** | books, magazines, reports | *Layout* | Blank publication (A4), Book, Magazine, Report |
| **Design** | illustration, UI design, boards | Board, Design | Blank canvas, Poster, Brand sheet |
| **Design × Development** | screens, flows, prototype, code | Board, Design, Flows, Develop | Blank, Onboarding, Sign in, Checkout, SaaS dashboard |

The vertical is stored **in the document** (`settings.vertical`), so everyone who opens it sees the same editor. A document that does not say (every one made before verticals) is *Design × Development* and behaves as it always did.

## Choosing and changing it

- On the **Home**, pick the kind of document above the templates: the templates, the headline and the journey change with it, and the choice is remembered. *New document* starts the blank document of that kind.
- In the editor, **document menu → Document type** switches the current document (one undo step). The top bar, the menu entries and the left panel follow at once. Entries of other kinds of work are tucked away, not removed: *Publishing* hides whiteboard, `.fig` import, plugins and tokens; *Design* and *Design × Development* hide the EPUB export, the print PDF and page setup.
- Over MCP: `set_document_settings { vertical }` (and `create_document`-style creation through the RPC: `CreateDocumentRequest.vertical`).

## Publishing

A publication is built from the features of the publishing track:

- **Pages as sheets.** *Page setup…* (page list, the **Pages** panel, or the document menu) sets, per page or for all pages, the **size** (A3 – A6, US Letter, Legal, Tabloid, book, square, custom, portrait or landscape; points), **margins**, **columns** with their gutter and **bleed**. The editor draws the sheet (the area outside is dimmed), the bleed in red, the margins and the column edges; objects **snap** to all of them. A page without a size is an unbounded canvas, as before.
- **Baseline grid.** The same dialog sets the document's grid (every *n*, starting at *m* from the top of the page); it is drawn on the sheet and objects snap to its lines. Paragraph styles with *Align to baseline grid* put their lines on it (docs/rich-text.md).
- **Master pages** (docs/master-pages.md): the running head, the rules and the page number (`<#>`) are drawn once and shown on every page that applies the master.
- **Text that flows** (docs/text-frames.md): linked frames, across pages and columns, with the paragraph and character styles and the tracking of docs/rich-text.md.
- **Pages panel** (left panel, Publishing only): every page as a thumbnail, numbered the way `<#>` counts (masters are not pages), with its master; click to open, add a page or a master, open the setup.
- **Output.** *Export all pages as PDF…* and *as EPUB* export each page as **its sheet** (a sized page is exported as the sheet, not as the bounding box of its content; an empty sheet is still a page). *Export PDF for print (with bleed)…* adds each page's bleed around the sheet. EPUB is fixed-layout: one page per sheet, at its size. A page export of the page on screen is the sheet too.

### The Publishing workspace

A publication opens in a page-layout shell instead of the design editor's: the same document and canvas, different chrome (`web/src/ui/shell/`).

- **Tool rail** (left): the tools as a vertical column (`ToolDock variant="rail"`), history at the bottom; shape tools and shortcuts are unchanged.
- **Control panel** (under the document bar, `ControlPanel.tsx`): X, Y, W, H and rotation of the selection, always in place (disabled when nothing is selected). It writes the same ops as the Properties panel, so a typed value or a label drag is one undo step. With text frames selected it adds the paragraph style, the character style, the size and the alignment; the size is read-only while a paragraph style decides it.
- **Dock** (right): Properties, Pages, Layers, Styles, Preflight and Comments as tabs (there is no left panel). Something outside the dock can bring a tab forward (`store/dock.ts::showDockTab`): the status bar's preflight verdict opens Preflight.
- **Styles** (`StylesPanel.tsx`): the document's paragraph styles and character styles in two lists. Choosing one applies it to the selected text frames (every paragraph, or the whole text), the one in use is marked and *None* clears it; *Edit styles…* opens the Styles dialog. Inside a text being edited, the pickers of the text editor apply a style to the selection instead.
- **Preflight** (`PreflightPanel.tsx`): everything the editor can see wrong -- fonts that cannot be embedded, text that does not fit its frame, stories that overflow their last frame, unsized pages, layers that do not print -- grouped as errors, warnings and notes, recomputed shortly after edits settle. Choosing one goes to its page and selects the object. It is the print dialog's check (`export/preflight.ts`), run live; not a PDF/X validator.
- **Status bar** (bottom, `StatusBar.tsx`): zoom, the page navigator (regular pages, numbered as `<#>` counts them) and the preflight verdict (`export/preflight.ts`: errors, warnings or "No errors").

- **Spreads** (`store/spread.ts`): with *Facing pages* on (Page setup; the Book and Magazine templates have it), the canvas shows the page on screen **and the page it faces** side by side -- an open book -- with each page's master, sheet, margins, columns and baseline grid. The page on screen keeps its own coordinates (its origin stays at 0,0), so tools, snapping and the Control panel work unchanged; the facing page is drawn beside it (CPU and GPU renderers) and becomes the page on screen when you click it or move to it, with the view held still. The status bar's **Spread** toggle turns it on and off (a per-person view setting, not saved in the document) and the navigator names the pair ("2–3"). Moving to another page frames the whole spread.

Design and Design × Development keep the floating tool dock, the left panel and the timeline.

### The templates

Each publishing template is a real document, not a picture: sized sheets with margins, columns and bleed, a master (running head, page number), paragraph and character styles, a baseline grid, and body text that flows through linked frames from page to page.

- **Book** (6 × 9 in): cover, a master, and a chapter that flows over three pages.
- **Magazine** (A4, three columns): cover and an article that runs through six column frames over two pages.
- **Report** (US Letter): title page, summary, and findings flowing over two pages, on a master with header and footer rules.
- **Blank publication**: an A4 sheet with margins.

## Design

*Design* keeps the Board and the Design mode and the vector, component and token tools. Its templates: **Poster** (an A3 sheet with bleed: big type, tracking and shapes), **Brand sheet** (logo mark, palette and type specimen on an open canvas) and a **Blank canvas**.

## Design × Development

The original path: Board, Design, Flows (connect screens, try the prototype), Develop (readiness, generated code, export). Its templates are the original four screens-and-flows ones.

## Model and API

```
Document.settings : DocSettings { vertical, baseline_increment, baseline_start, facing_pages }
SetDocSettings    : absolute upsert of the settings (op 42; the inverse is the previous settings)
Page              + width, height, margin_top/right/bottom/left, columns, gutter, bleed, slug
Page              + section_start, number_start, number_style, left_master_id, hidden_master_items, guides
MovePage          : moves a page to an index in the page order (op 43; the inverse moves it back)
CreateDocumentRequest.vertical, DocInfo.vertical
```

Rules (Go `internal/core/docsettings.go` is the authority; `web/src/store/docSettings.ts` is its twin): the vertical is one of the three (or empty = product); the baseline increment is 0 – 1000 and its start is ≥ 0; a page's size is 0 (unbounded) or 1 – 100 000; margins, gutter and bleed are non-negative; columns are 0 – 24; the margins of a sized page leave room, and so do the gutters. A document created with a vertical has it from its first operation.

MCP: `set_document_settings`, `create_page` / `update_page` with the page-setup fields, and `get_document` / `list_pages` reporting them. Code: `web/src/verticals/index.ts` (what each vertical shows), `web/src/templates/{publishing,design,catalog}.ts` (templates as pure data: nodes, pages, styles, settings), `web/src/ui/{PageSetupDialog,PagesPanel}.tsx`.

## Pages, spreads and numbering

- **Facing pages** (Page setup): odd page numbers are right-hand pages; the left and right margins become **Inside** and **Outside**, so on a left-hand page the margins swap sides (margins, columns, snap guides and the drawn sheet follow). The Pages panel lays the pages out as spreads.
- **Numbering sections**: a page can *start a new section* with its own start number and style (`1`, `i`, `I`, `a`, `A`); the first page is always a section start. The number is what `<#>` shows on a master and what decides the side of a spread.
- **Slug**: extra area beyond the bleed, drawn as a dashed outline.
- **Guides**: vertical and horizontal ruler guides per page (Page setup, comma-separated), drawn in cyan and snapped to; guides of a master apply to its pages.
- **Pages panel**: *Duplicate* (a copy with new ids right after the page, text threads inside the page stay linked), *Earlier* / *Later* to reorder.

Rules (same in Go and TS): number style is empty or one of `i I a A`; number start ≤ 100 000; slug 0 – 1000; at most 200 guides with |position| ≤ 100 000; hidden master item ids are non-empty.

## Not yet

The facing page of a spread is drawn, not edited, until it becomes the page on screen: a marquee or drag cannot cross the spine, and text threads between facing pages are drawn but not followed across it.

Slug is drawn but not yet exported (PDF/EPUB use the bleed box), the PDF/EPUB export does not lay facing pages out as spreads, and a fixed `Align to grid` for text that has no paragraph style.
