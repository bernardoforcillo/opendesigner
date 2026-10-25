# Platform (block 10)

## Ink manager and overprint
Menu *Document > Ink manager…*. MCP: `ink_report`, `convert_spots_to_process`, `merge_spot_inks`, `set_overprint`.
- **Inks**: process (CMYK swatches and the objects painted with them) and spot (swatches with a spot name, with their CMYK alternate). Swatches over the total-ink limit (300% by default) are listed; PDF/X-1a and X-3 preflight warn about them.
- **Spot → process**: all or named spot inks become process colours (their CMYK alternate); tints follow. **Alias**: one spot ink prints as another (one plate).
- **Overprint**: per object (`fill`, `stroke`, `both`, `off`, stored in the node's `meta.overprint`). The PDF export writes the overprint graphics state (`/op`, `/OP`, `/OPM 1`). It is **not simulated on screen**. Preflight warns when white overprints (it prints nothing).
- Not done: separation preview, trapping, ICC-aware ink limits, an ink-limit setting in the document.

## Chinese, Japanese, Arabic, Hebrew
- **CJK line breaking** (canvas, SVG, PDF, EPUB share one layout): lines break between ideographs and kana without spaces, with the **kinsoku** rules: closing punctuation (。 、 ！ ？ ） 」 …), the prolonged-sound mark ー and small kana never start a line; opening brackets never end one; "……" and "——" are not split. Hangul breaks at spaces.
- **Right-to-left text**: the screen and the SVG export leave shaping and ordering to the browser. The **PDF** writer, which has no text engine, shapes Arabic into joined presentation forms (isolated, final, initial, medial, lam-alef ligatures; checked against forms derived from the Unicode database) and puts mixed text in visual order (a simplified UAX #9: strong types, neutrals, numbers, mirrored brackets). Checked end to end with an embedded font read back by pdf.js (without the step the text reads reversed).
- Limits: no paragraph direction setting (alignment is not mirrored: choose right alignment for Arabic and Hebrew); no explicit bidi marks (LRE, RLO, isolates); in the PDF each style run is ordered on its own, so a line that mixes styles *and* directions can come out wrong; Arabic diacritics are not positioned in the PDF; the font must contain the presentation forms (a font without them is reported as missing glyphs); no vertical writing, ruby, tate-chu-yoko, kerning of CJK punctuation, or Thai/Indic shaping.

## Control channel
MCP is the control channel (see mcp-editor.md): every editor function is a tool. New here:
- `batch`: up to 50 editor commands in one round trip, in order, stopping at the first failure (each is its own undo step; commands that need a file and nested batches are refused).
- `list_editor_commands`: the names the connected editor runs (a test keeps the list in step with the code).
