# Typography: shaping on the GPU renderer, and the rest of the typography gap

Date: 2026-10-15. Status: draft for review. No product code is part of this document.

## 1. Goal

The roadmap (docs/roadmap.md, sections 1 and 4) lists the typography items:
loadable fonts, text styles, multi-line text, user-loadable fonts in the GPU
renderer, plus two open items: "kerning and text shaping in the GPU renderer
(CanvasKit's Paragraph)" and "letter spacing, decoration, case, per-range styling,
kerning/shaping on the GPU".

Reading the code shows that the first four are already shipped (docs/typography.md,
roadmap lines 25 and 78). This spec therefore covers what is actually left inside
that scope:

1. Make the GPU renderer shape text (kerning, ligatures, per-glyph fallback) so it
   matches the 2D canvas, instead of summing glyph advances.
2. Make wrapping and measurement agree across the 2D canvas, the GPU renderer, SVG
   export, region/PNG export and generated code, so one text node has one layout.
3. Close the cheap, well-contained items of the "Not yet" list that share the same
   plumbing: letter spacing, case, decoration, paragraph spacing. Per-range styling,
   variable-font axes and partial-override styles are decided here (deferred, with
   reasons).
4. Settle font storage, licensing and local-first behaviour, currently implicit.

Non-goals: a rich-text editor, bidirectional editing in the textarea overlay, font
subsetting, a font marketplace, fetching hosted fonts (Google Fonts) at runtime.

## 2. Current state (with files)

Model (already in place):
- `proto/opendesigner/v1/opendesigner.proto`: `TextStyle` (family, size, weight,
  line_height, align, italic; fields 1-6), `FontFace` (id, family, weight, style,
  asset_hash), `TextStyleDef`, `Node.text_style_id = 43`, ops 31-34 (`SetFont`,
  `DeleteFont`, `SetTextStyleDef`, `DeleteTextStyleDef`).
- `internal/core/typography.go`: validation and apply (the Go authority).
  `web/src/store/typography.ts` mirrors it; `testdata/golden/typography.json` runs
  both sides, rejections included (`web/src/store/golden.test.ts`).
- `internal/merge/definitions.go`: merge of definitions across clients.
- `text_style_id` is resolved in the same pipeline as variables
  (`resolveNode`/`resolveScene`, `web/src/store/variables.ts`), so every consumer
  sees the resolved style.

Layout (one source, pure, injectable measure):
- `web/src/renderer/text.ts`: `layoutText(measure, content, style, maxWidth)`,
  `placeTextLines`, `textPaintBounds`, `lineHeightOf`, `fontString`. Greedy word
  wrap; trailing spaces hang; a single glyph is never rejected. The measure is a
  plain function `(s) => number`. Ascent is an approximation (`ASCENT_RATIO = 0.8`).
- The 2D canvas measures with `ctx.measureText(s).width` (`paintText` in text.ts),
  so it is shaped by the browser (kerning, ligatures, fallback).
- SVG and region export reuse `placeTextLines` with a canvas-backed `MeasureText`
  (`web/src/export/svg.ts`, `region.ts`, `exportScene.ts::canvasMeasure`) and emit
  real `<text>`/`<tspan>` with explicit x/y per line. PNG goes through the 2D path.

GPU renderer:
- `web/src/renderer/ck/ckRenderer.ts` (`measureFor`, `paintText`): the measure is the
  sum of `font.getGlyphWidths(font.getGlyphIDs(s))` (cached per string); drawing is
  `canvas.drawText(line, x, y, paint, font)` per line. No kerning, no ligatures, no
  per-glyph fallback. The file header and `web/scripts/render-parity.mjs` both state
  "CanvasKit does not do kerning" and tolerate 1.5% differing pixels because of it.
- `web/src/renderer/ck/canvaskit.ts` (`FontBook`): Inter 400/500/600/700 from
  `web/public/fonts/` (OFL text shipped as `Inter-OFL.txt`), plus the document's
  uploaded fonts via `setDocumentFonts` -> `Typeface.MakeFreeTypeFaceFromData`,
  chosen by family, then italic, then nearest weight. `Font` objects are cached per
  (face, size); hinting off, subpixel on.
- Uploaded fonts reach the 2D canvas through `document.fonts`
  (`web/src/renderer/fontRegistry.ts`), downloaded only for families the current
  page uses (`web/src/renderer/pageFonts.ts`, docs/performance.md item 8).

Codegen, MCP, editor:
- `internal/codegen/build.go` (`fontFamilyCSS`, defaults near line 644) emits CSS and
  `@font-face` per uploaded font; line breaks are left to the browser (comment near
  line 698: widths depend on real font metrics, about 1 px at 16 px).
- `internal/mcp/typography.go`: `list_text_styles`, `set_text_style`,
  `delete_text_style`, `apply_text_style`, `list_fonts`, `set_font`, `delete_font`;
  `create_text`/`set_text` take `italic` and `lineHeight`. Uploading bytes is an
  editor-only action.
- `web/src/ui/TypographyControls.tsx`, `typographyOps.ts`, `PropertiesPanel.tsx`
  (Text section), `TextEditorOverlay.tsx` (a textarea sized with the same
  `fontSizeOf`/`lineHeightOf` as the canvas).

Gap summary: shaping exists only in the 2D path. The GPU path is the odd one out,
and its measure also feeds hit-testing and bounds when it is the active renderer.

## 3. Data-model and op changes

Guiding rule (the project's op-log design): additive proto fields, absolute upserts,
validation in Go first and mirrored in TS, a golden-file entry for each new rule.
No new op numbers are needed.

### 3.1 Phase A (shaping): no model change

Shaping is a renderer concern; `TextStyle` is unchanged. What must be guaranteed is
that a given (content, style, width) yields the same line breaks on every renderer.
That is a layout-contract change (section 4.1), not a data change.

### 3.2 Phase B (cheap style properties): additive `TextStyle` fields

All optional; zero means "renderer default", exactly like `line_height = 0 => 1.2`.

| Field | Number | Type | Zero means | Validation |
|---|---|---|---|---|
| `letter_spacing` | 7 | double, em fraction (e.g. 0.02) | 0 em | finite, -1..10 |
| `text_decoration` | 8 | enum NONE/UNDERLINE/STRIKETHROUGH | none | known enum |
| `text_case` | 9 | enum ORIGINAL/UPPER/LOWER/TITLE | original | known enum |
| `paragraph_spacing` | 10 | double, em fraction | 0 | finite, >= 0 |

Letter spacing is stored in em so a text style survives a size change. Case is a
rendering transform of `content`, never a mutation of it (copy/paste and MCP
`get_document` must return what the user typed). Because these are `TextStyle`
fields, `SetProperties` (mask paths such as `style.letter_spacing`),
`SetTextStyleDef`, merge, the `.fig` importer (`internal/figimport/fig.go`) and `pack`
carry them without a new op. `web/src/store/maskPaths.ts` and `types.ts`
(`TextStyleLite`) get the same fields; `toNodeLite` keeps the all-zero default so the
mirror stays identical to `core.Apply`.

### 3.3 Not proposed

- Per-range styling: needs a run model (`repeated TextRun {start, end, style}`) and a
  rebase of run offsets under concurrent edits to `content`. The op log replaces whole
  `content` strings today, so runs would silently drift under merge. Deferred to its
  own spec with a collaboration section.
- OpenType feature flags and variable-font axes: the CSS mapping is easy to export but
  needs the Paragraph path to render and a UI that does not exist. Deferred; reserve
  `TextStyle` 11-15 for them.
- Partial-override text styles (a style setting only some properties): needs presence
  bits (`optional` fields or a mask on `TextStyleDef`). See open question 3.

## 4. Renderers

### 4.1 Layout contract

`layoutText` stays the single wrapper and stays pure. What changes is the measure each
renderer injects. Today the two measures differ (browser-shaped vs sum of advances), so
a wrap boundary can land differently and a text box can reflow when the user flips
CPU/GPU. The contract after this work:

- The measure must be shaped (kerning and ligature aware) and include letter spacing,
  because both change line width.
- Whatever measure is used for layout is the measure used for painting. Painting a
  Paragraph while laying out with a different measure reintroduces the drift that
  `placeTextLines` was extracted to prevent.
- Case transform is applied to the string before measuring and painting.

### 4.2 CPU (Canvas 2D)

Already shaped by the browser. Additions: set `ctx.fontKerning = "normal"` and
`ctx.textRendering` explicitly in `paintText` so defaults cannot drift; `ctx.letterSpacing`
(Chrome 99+, Safari 17+; feature-test, fall back to per-glyph advance adjustment);
decoration drawn as a line (canvas 2D has no decoration API) using font metrics
approximations; case via the transformed string. Stroke stays centered on the outline
(existing declared approximation in `strokeText`).

### 4.3 GPU (CanvasKit)

Use CanvasKit's Paragraph API for measuring and painting text:

- Fonts: `CK.TypefaceFontProvider.Make()`; each face known to `FontBook` is registered
  under its CSS family name (`registerFont(bytes, family)`), Inter as "Inter". The
  `FontBook` selection logic (family, italic, nearest weight) is kept for the
  non-Paragraph fallback and the flat LOD drawing; Paragraph resolves weight and slant
  from the registered faces.
- Layout: `ParagraphBuilder.MakeFromFontProvider(paraStyle, provider)`. Under the
  recommended approach (section 8, A) the wrap stays in `layoutText`; Paragraph supplies
  a shaped single-line width and paints each placed line.
- Letter spacing: Paragraph text style `letterSpacing`. Decoration: `decoration` and
  `decorationColor`. Case: transformed string.
- Cache: key (content, style hash, width) to `Paragraph`, invalidated in
  `fontsChanged()`. Paragraphs are WASM objects and must be `delete()`d on eviction and
  in `dispose()`, the same lifecycle rule `FontBook` follows for `Font`. Cap the cache
  (for example 2,000 entries, LRU). At 50,000 nodes only visible text is laid out,
  because `drawScene` culls and the LOD replaces text below about 4 px with a flat
  rectangle (docs/performance.md items 3-4).
- Fallback: if Paragraph is unavailable (open question 1) or throws, keep today's
  glyph-sum path so the renderer never loses text.
- Fonts are loaded only for families the page uses (`pageFonts.ts`); text whose family
  has not loaded paints with Inter and repaints on `fontsChanged()`, as now.

### 4.4 Parity tolerance

`web/scripts/render-parity.mjs` has `MAX_DIFFERING_PCT = 1.5`, with a comment that the
budget exists because CanvasKit does not kern. After shaping lands the budget should
shrink (target below 0.5%, measured not guessed) and the comment must be rewritten.
Leaving 1.5% would hide regressions.

## 5. Export

- SVG (`web/src/export/svg.ts`): keeps real `<text>` with a `<tspan>` per line and
  explicit x/y. Add `letter-spacing` and `text-decoration`; apply case to the emitted
  string (more portable to Figma/Illustrator than `text-transform`). The explicit
  per-line x pins line starts; the export measure must be the same shaped measure as the
  canvas (it is, through `canvasMeasure`).
- PNG/region: same path; `textPaintBounds` must include letter-spacing overhang so the
  crop does not clip it.
- Generated code (`internal/codegen/build.go`): emit `letter-spacing: <n>em`,
  `text-decoration`, `text-transform` (CSS native is right here: content stays as
  typed) and a margin for paragraph spacing. Wrapping stays the browser's, so
  editor-to-code pixel parity is approximate by nature, as docs already say.
- Fonts in export: `@font-face` per uploaded font already ships. Add the font's license
  note next to the copied file and respect the embedding flag (section 7).

## 6. Panel and MCP

Panel (`TypographyControls.tsx`, `PropertiesPanel.tsx`): a letter-spacing field
(percent display, em storage), a decoration segmented control, a case segmented control,
paragraph spacing. All write `SetProperties` through `typographyOps.ts` and keep the
rule that editing a styled text first detaches the style. The Fonts dialog gains a
license field and a "cannot be embedded" warning (section 7). Shaping itself has no UI.

MCP (`internal/mcp/typography.go`, `tools.go`): `set_text_style`, `create_text` and
`set_text` accept `letterSpacing`, `textDecoration`, `textCase`, `paragraphSpacing`;
`get_document` and `list_text_styles` return them, omitting defaults to keep agent
payloads small. Uploading font bytes stays an editor action; MCP registers an
already-uploaded hash. Agents cannot inspect shaping results, which is fine. A
`review_design` check for extreme tracking is possible later, not in this spec.

## 7. Font storage, licensing and local-first concerns

Storage (as built): font bytes are content-addressed assets under
`<workspace>/<docId>.opendesigner/assets/`, served immutable from
`/assets-api/{doc}/{hash}`, allowlisted by magic bytes, `nosniff`. The document holds
only the hash. This suits local-first: the workspace folder holds everything needed to
open the document offline. `pack`/`unpack` must carry the assets (open question 4).

Concerns this spec proposes to handle:

1. Licensing. Uploading a font does not grant redistribution rights, yet export copies
   the file into the generated project and bundle. Add optional `license` (string) and
   `embedding_allowed` (read from the OS/2 `fsType` at upload) to `FontFace`. Export
   warns, and by default skips copying a font whose fsType forbids embedding, emitting
   the `@font-face` with a comment instead. This is a warning system, not DRM; the user
   is the licensee and decides.
2. Sharing (docs/collaboration.md): a viewer on a share link receives the font bytes.
   Surface the same warning when creating a share link for a document that contains a
   restricted font.
3. Bundled fonts: only Inter ships, under OFL, with its license beside it. Any new
   bundled font must be OFL/Apache and add its license text. No runtime fetch from
   Google Fonts (breaks offline use, leaks usage). A curated "add OFL font" picker that
   downloads once into the workspace is a possible later feature.
4. Missing fonts: a document opened with a missing asset must degrade to the fallback
   and say so in the Fonts dialog, not throw. Both loaders already tolerate a failed
   fetch silently; add the visible state.
5. Format and size: verify `MakeFreeTypeFaceFromData` and `registerFont` accept WOFF and
   WOFF2 (open question 1). If not, decode WOFF2 to TTF at upload and store a derived
   file. Do not bundle large CJK/emoji fallbacks; accept tofu with a visible warning
   (open question 6).
6. Privacy: assets are served by the local server and cached by hash; nothing leaves
   the machine.

## 8. Approaches

### Approach A: Paragraph as shaped measure and painter, `layoutText` stays the wrapper (recommended)

`layoutText` keeps deciding line breaks. The GPU measure becomes a Paragraph-backed
single-line width (shaped, includes letter spacing); each placed line is painted as a
one-line Paragraph at the position `placeTextLines` computed.

Pros: one wrap authority for 2D, GPU, SVG, region and the textarea overlay; the existing
pure-function tests keep covering layout; parity compares like with like; existing
documents' line breaks change only where kerning changes a width; lands incrementally
(measure first, paint second).
Cons: one Paragraph per visible line rather than per node (more WASM objects; mitigated
by cache and culling); no ICU line breaking, so CJK and other no-space scripts wrap
poorly (identically on every renderer); the ascent approximation remains unless real
metrics are fed through `layoutText`.

### Approach B: Paragraph owns wrapping and painting on the GPU

One Paragraph per node, `layout(width)`, paint whole, line positions from
`getLineMetrics()`.

Pros: best typographic quality (ICU breaking, bidi, per-glyph fallback, real
ascent/descent), fewer WASM objects, simplest GPU code, a natural base for per-range
styling.
Cons: GPU line breaks stop being `layoutText`'s, so the 2D canvas, SVG export and the
textarea overlay can disagree with the GPU about where a line ends. Fixing that means
moving every consumer to a Paragraph-derived layout, which needs the CanvasKit WASM
everywhere (including export) and breaks "layout is pure and testable in Node". High
blast radius.

### Recommendation

Approach A, in two steps (measure, then paint), then the Phase B style fields. It fixes
the visible defect (kerning/ligature mismatch, the reason for the 1.5% parity budget)
without breaking the invariant the codebase leans on: one pure layout shared by every
consumer. Revisit B when per-range styling is specced, since that feature needs a run
model and a layout that understands runs; the migration is then justified and done once.

## 9. Testing plan

Unit (`pnpm --dir web test`, vitest):
- `renderer/text.test.ts`: layout with a fake measure stays unchanged; add cases for
  letter spacing in the measure, case before wrap, decoration geometry helpers.
- `renderer/ck/canvaskit.test.ts`: the fake CanvasKit gains `TypefaceFontProvider` and
  `ParagraphBuilder` stubs; assert registration per family, eviction calls `delete()`,
  `dispose()` frees every paragraph, and fallback to glyph-sum when Paragraph is absent.
- `store/typography.test.ts` and `golden.test.ts`: new cases in
  `testdata/golden/typography.json` for the new fields, including rejections (NaN,
  out of range, unknown enum) so Go and TS reject identically.
- `export/svg.test.ts`, `region.test.ts`: letter-spacing and decoration in `<text>`; the
  crop includes tracking overhang.

Go (`go test ./...`): `internal/core/typography_test.go` (validation),
`internal/mcp/typography_test.go` (tool args/outputs), `internal/codegen` tests (CSS
properties), `internal/merge` (concurrent edits of the new fields), `internal/figimport`
if `.fig` carries tracking/decoration.

Render parity (`pnpm --dir web parity`): add a typography section to
`src/bench/gallery.ts`: kerning pairs ("AV To Ty"), ligatures ("fi ffi"), letter
spacing, underline, wrapped paragraphs at several widths, an uploaded font, italic and
mixed weights. The fixture loads an uploaded font through the production path using a
small OFL font checked into `testdata/`. Procedure: record the baseline differing
percentage per zoom before any change, re-run after each step, then lower
`MAX_DIFFERING_PCT` to the measured value plus headroom. Parity is a pixel count and
does not prove equal line breaks, so add a second assertion in `bench/parity.ts` that
dumps the placed lines of each text node from both renderers and compares them as
strings; this guards the layout contract of section 4.1. Also run
`pnpm --dir web export-parity` to confirm PNG/SVG text did not move.

Performance: re-run `bench-ck.html` at 20,000 and 50,000 nodes and compare frame time
and WASM memory with docs/performance.md. An uncapped or unculled Paragraph cache is the
regression to look for.

Manual: flip CPU/GPU on a document with wrapped text and confirm nothing reflows; open a
document with a deleted font asset; upload a WOFF2.

## 10. Ordered task breakdown

1. Spike (about 1 hour, gates the rest): confirm the shipped `canvaskit-wasm` includes
   Paragraph and `TypefaceFontProvider`, and how it handles WOFF/WOFF2. Record results
   in this spec.
2. Add the typography section to the parity gallery and the placed-lines comparison to
   the parity script; record baseline numbers before any renderer change.
3. GPU measure via Paragraph (Approach A step 1): font provider registration, shaped
   single-line measure, cache, `fontsChanged()` invalidation, lifecycle and `dispose()`
   tests, glyph-sum fallback.
4. GPU paint via Paragraph (step 2): one-line paragraph per placed line; stroke path
   unchanged (centered outline via `Font`); lower `MAX_DIFFERING_PCT` and rewrite the
   comment.
5. 2D canvas: set `fontKerning`/`textRendering` explicitly; confirm export measure is
   unchanged. Update docs/typography.md and docs/performance.md (GPU section); tick the
   roadmap item.
6. Proto: `TextStyle` 7-10; Go validation/apply; TS mirror, `maskPaths.ts`, `types.ts`;
   golden file; merge test; regenerate with buf (`buf.gen.yaml`).
7. Renderers and export for the new fields: 2D, GPU, SVG, region bounds, codegen CSS,
   figimport mapping.
8. Panel controls and MCP arguments/outputs, with tests.
9. Font licensing: `FontFace.license` and `embedding_allowed`, Fonts dialog display,
   export and share-link warnings, missing-font indicator.
10. Docs and roadmap: update docs/typography.md ("Not yet"), roadmap lines 25-26 and 79;
    tick only what shipped.

Steps 1-5 are independently shippable and deliver the open roadmap item. Steps 6-10 are
the follow-up for letter spacing, decoration and case, and can be reordered or cut.

## 11. Open questions

1. Does the `canvaskit-wasm` build we ship (`^0.42.0` in `web/package.json`) include
   Paragraph and `TypefaceFontProvider`, and do `MakeFreeTypeFaceFromData`/`registerFont`
   accept WOFF and WOFF2? `node_modules` was not installed when this was drafted, so
   neither was verified. If Paragraph is absent, the work needs a custom CanvasKit build
   or another shaper (HarfBuzz WASM), which changes the estimate entirely.
2. Who owns line breaking on the GPU: keep `layoutText` (consistent for all consumers,
   poor for CJK/no-space scripts, recommended) or let Paragraph wrap (better text,
   divergent layouts)? This decides Approach A vs B and affects the textarea overlay,
   export and saved node height.
3. Should a text style stay all-or-nothing, or become partial-override (`optional`
   fields or a mask)? More style fields make all-or-nothing more painful, and presence
   bits cost much less in proto/merge/golden now than after more fields exist.
4. Do `pack`/`unpack` and the share-link flow carry font assets, and what should happen
   for a restricted-embedding font on share and on code export: warn, block, or skip the
   copy?
5. Is per-range styling coming soon? If yes, design Approach B and a run model together
   rather than building A first and replacing it.
6. Fallback policy for scripts Inter does not cover (CJK, Arabic, emoji): visible tofu
   plus a warning, or bundle a small subset font?
