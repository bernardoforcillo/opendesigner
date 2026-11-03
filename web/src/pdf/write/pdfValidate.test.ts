import { describe, it, expect } from "vitest";
import { validatePdfUa, validatePdfX, type ValidationFacts } from "@/pdf/write/pdfValidate";

const facts = (over: Partial<ValidationFacts> = {}): ValidationFacts => ({
  pdfx: "x4", tagged: true, language: "en", title: "Doc", pages: 1, hasTrimBox: true, hasOutputIntent: true, iccEmbedded: false,
  substitutedFonts: [], missingGlyphs: [], usesRgb: false, transparency: false, lowResolution: 0,
  headingLevels: [1, 2], figures: 1, figuresWithoutAlt: 0, taggedItems: 3, ...over,
});
const status = (v: { checks: { id: string; status: string }[] } | null, id: string) => v!.checks.find((k) => k.id === id)!.status;

describe("PDF/X validation", () => {
  it("is absent when the file is not PDF/X", () => expect(validatePdfX(facts({ pdfx: "none" }))).toBeNull());
  it("never claims conformance while no ICC profile is embedded", () => {
    const v = validatePdfX(facts())!;
    expect(status(v, "pdfx.iccProfile")).toBe("warn");
    expect(v.conformant).toBe(false);
    expect(validatePdfX(facts({ iccEmbedded: true }))!.conformant).toBe(true);
  });
  it("fails what the mode forbids", () => {
    const v = validatePdfX(facts({ pdfx: "x1a", usesRgb: true, transparency: true, substitutedFonts: ["Inter → Helvetica"] }))!;
    expect(status(v, "pdfx.rgb")).toBe("fail");
    expect(status(v, "pdfx.transparency")).toBe("fail");
    expect(status(v, "pdfx.fontsEmbedded")).toBe("fail");
    expect(status(v, "pdfx.iccProfile")).toBe("fail");
    expect(status(validatePdfX(facts({ transparency: true })), "pdfx.transparency")).toBe("pass");
  });
});

describe("PDF/UA reporting", () => {
  it("passes a tagged, titled, described document (with the manual-review note)", () => {
    const v = validatePdfUa(facts());
    expect(v.conformant).toBe(true);
    expect(status(v, "ua.manual")).toBe("warn");
  });
  it("fails untagged files, figures without alt text and skipped heading levels", () => {
    expect(status(validatePdfUa(facts({ tagged: false, language: undefined })), "ua.tagged")).toBe("fail");
    const v = validatePdfUa(facts({ figuresWithoutAlt: 1, headingLevels: [1, 3] }));
    expect(status(v, "ua.figureAlt")).toBe("fail");
    expect(status(v, "ua.headings")).toBe("warn");
    expect(v.conformant).toBe(false);
  });
});
