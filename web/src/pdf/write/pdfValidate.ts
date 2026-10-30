// VALIDATION REPORTS for the PDF the writer produced: PDF/X checks and PDF/UA (accessibility) checks. Each check is a
// fact the writer knows about the file it just built, so this is a report on OUR output, not a general PDF validator:
// it cannot read a file made elsewhere, and it does not replace veraPDF, Acrobat's preflight or a printer's checker.
// A check is "pass", "fail" (the standard would reject the file) or "warn" (the standard asks for it but the writer
// cannot prove it, or it is advisory). `conformant` is true only when nothing failed AND nothing is only a warning on a
// mandatory requirement we could not verify -- in practice it is never true for PDF/X while no ICC profile is embedded.

export type CheckStatus = "pass" | "fail" | "warn";
export interface ValidationCheck { id: string; status: CheckStatus; detail?: string }
export interface Validation { standard: string; checks: ValidationCheck[]; conformant: boolean }

export interface ValidationFacts {
  pdfx: "none" | "x1a" | "x3" | "x4";
  tagged: boolean;
  language: string | undefined;
  title: string;
  pages: number;
  /** Every page has TrimBox and BleedBox (the writer always writes both under PDF/X). */
  hasTrimBox: boolean;
  hasOutputIntent: boolean;
  /** An ICC profile is embedded in the output intent (the writer does not do this yet). */
  iccEmbedded: boolean;
  substitutedFonts: readonly string[];
  missingGlyphs: readonly string[];
  usesRgb: boolean;
  transparency: boolean;
  lowResolution: number;
  /** Structure: heading levels in reading order, figures with an empty alternate text, and marked content count. */
  headingLevels: readonly number[];
  figuresWithoutAlt: number;
  figures: number;
  taggedItems: number;
}

const c = (id: string, ok: boolean, detail?: string, level: "fail" | "warn" = "fail"): ValidationCheck => ({
  id, status: ok ? "pass" : level, ...(detail !== undefined && !ok ? { detail } : {}),
});

/** PDF/X checks for the mode; null when the file is not meant as PDF/X. */
export function validatePdfX(f: ValidationFacts): Validation | null {
  if (f.pdfx === "none") return null;
  const x1a = f.pdfx === "x1a", x4 = f.pdfx === "x4";
  const checks: ValidationCheck[] = [
    c("pdfx.version", true),
    c("pdfx.trimbox", f.hasTrimBox, "TrimBox is missing"),
    c("pdfx.outputIntent", f.hasOutputIntent, "no output intent"),
    c("pdfx.iccProfile", f.iccEmbedded, "the output intent names the print condition but embeds no ICC profile", x1a ? "fail" : "warn"),
    c("pdfx.fontsEmbedded", f.substitutedFonts.length === 0, `not embedded: ${f.substitutedFonts.join(", ")}`),
    c("pdfx.glyphs", f.missingGlyphs.length === 0, `${f.missingGlyphs.length} character(s) have no glyph`, "warn"),
    c("pdfx.title", f.title.trim() !== "", "the document has no title"),
    c("pdfx.transparency", x4 || !f.transparency, "transparency is not allowed before PDF/X-4"),
    c("pdfx.rgb", !x1a || !f.usesRgb, "RGB colour is not allowed in PDF/X-1a"),
    c("pdfx.resolution", f.lowResolution === 0, `${f.lowResolution} image(s) under the print resolution`, "warn"),
  ];
  return { standard: `PDF/X (${f.pdfx})`, checks, conformant: checks.every((k) => k.status === "pass") };
}

/** PDF/UA-1 checks (the part of it the writer can see); null when the PDF is not tagged and no one asked for UA. */
export function validatePdfUa(f: ValidationFacts): Validation {
  let skipped = false;
  for (let i = 1; i < f.headingLevels.length; i++) if (f.headingLevels[i]! > f.headingLevels[i - 1]! + 1) skipped = true;
  const firstOk = f.headingLevels.length === 0 || f.headingLevels[0] === 1;
  const checks: ValidationCheck[] = [
    c("ua.tagged", f.tagged, "the PDF is not tagged (turn on tagged PDF)"),
    c("ua.language", f.tagged && !!f.language, "no document language"),
    c("ua.title", f.title.trim() !== "", "the document has no title"),
    c("ua.fontsEmbedded", f.substitutedFonts.length === 0, `not embedded: ${f.substitutedFonts.join(", ")}`),
    c("ua.figureAlt", f.figuresWithoutAlt === 0, `${f.figuresWithoutAlt} of ${f.figures} figure(s) have no alternate text`),
    c("ua.headings", !skipped && firstOk, "heading levels skip or do not start at 1", "warn"),
    c("ua.content", f.tagged && f.taggedItems > 0, "no tagged content", "warn"),
    // Not checkable here: reading order against the visual order, table headers, contrast, artifacts marked correctly.
    { id: "ua.manual", status: "warn", detail: "reading order, contrast and table structure need a human or veraPDF" },
  ];
  // The manual item is always a warning, so a UA pass means: no failure and only that one warning.
  return { standard: "PDF/UA-1", checks, conformant: checks.every((k) => k.status === "pass" || k.id === "ua.manual") && f.tagged };
}
