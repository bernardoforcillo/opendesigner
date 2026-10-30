# PDF fonts and validation

Files: `web/src/pdf/write/fontSubset.ts`, `fontLayout.ts`, `pdfFonts.ts`, `pdfValidate.ts`.

## Font subsetting

TrueType (`glyf`) fonts are subset to the glyphs the text uses. Glyph ids are kept (the CID -> GID mapping stays
Identity), unused outlines are emptied, composite glyphs keep their parts, and only `head hhea maxp hmtx loca glyf
cvt fpgm prep` are written. The font name gets the `ABCDEF+` tag. CFF (`OTTO`) fonts are embedded whole.
`report.fontBytesSaved` says how much was saved. A font that cannot be parsed is embedded whole.

## OpenType layout

`readGsub` reads GSUB lookup types 1 (single), 3 (alternate) and 4 (ligature), also behind extension lookups.
`liga` and `clig` are on by default (off when letter-spacing is set, as in browsers); the style's `fontFeatures`
(`"salt" 2, ss01`) overrides. A ligature glyph keeps the text it stands for, so the ToUnicode map writes `fi` and
search and copy still work. Not done: contextual/chaining lookups (`calt`, most Arabic/Indic shaping), multiple
substitution, lookup flags, GPOS (kerning, mark positioning), script/language selection.

## Validation reports

`report.validation` has `pdfx` (null unless a PDF/X mode is chosen) and `pdfua`, each a list of
pass / warn / fail checks, and is written into the print package's `Report.txt`. It reports on the file the writer
just built, not on arbitrary PDFs.

- PDF/X: version, TrimBox, output intent, ICC profile (always missing: warn, fail under X-1a), fonts embedded,
  glyph coverage, title, transparency (before X-4), RGB (X-1a), image resolution. It is never "conformant" while
  no ICC profile is embedded.
- PDF/UA: tagged, language, title, fonts embedded, figure alternate text, heading order, tagged content, plus a
  fixed warning that reading order, contrast and table structure need a human or veraPDF.

Not done: showing the checks in the Export PDF dialog, embedding an ICC profile, a real PDF/X or PDF/UA validator.
