import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { arabicShape, forPdf, isRtl, visualOrder, hasArabic } from "./bidi";

describe("arabicShape", () => {
  it("joins letters into presentation forms", () => {
    expect(arabicShape("بيت")).toBe("ﺑﻴﺖ"); // beh initial, yeh medial, teh final
    expect(arabicShape("ب")).toBe("ﺏ");
    expect(arabicShape("لا")).toBe("ﻻ"); // lam-alef ligature
    expect(arabicShape("بلا")).toBe("ﺑﻼ"); // ... and its final form
    expect(arabicShape("abc ١٢")).toBe("abc ١٢");
  });
  it("does not join after right-joining letters (dal, reh, waw, alef)", () => {
    expect(arabicShape("دب")).toBe("ﺩﺏ");
    expect(arabicShape("وب")).toBe("ﻭﺏ");
  });
  // Expected strings were produced by an independent shaper whose forms and joining classes come from the Unicode database
  // (unicodedata decompositions of U+FE70..FEFF), stored in a fixture.
  it("agrees with the Unicode-derived shaper on real words", () => {
    const p = "src/renderer/__fixtures__/arabic-shaping.json";
    const table = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
    for (const [word, shaped] of Object.entries(table)) expect(arabicShape(word), word).toBe(shaped);
    expect(Object.keys(table).length).toBeGreaterThan(10);
    expect(existsSync(p)).toBe(true);
  });
});

describe("visualOrder", () => {
  it("leaves left-to-right text alone", () => {
    expect(visualOrder("Hello world")).toBe("Hello world");
    expect(isRtl("Hello")).toBe(false);
  });
  it("reverses right-to-left text", () => {
    expect(visualOrder("אבג")).toBe("גבא");
    expect(isRtl("אבג")).toBe(true);
  });
  it("keeps Latin words and numbers readable inside right-to-left text", () => {
    // logical: alef bet SPACE abc SPACE gimel  ->  visual (read left to right): gimel SPACE abc SPACE bet alef
    expect(visualOrder("אב abc ג")).toBe("ג abc בא");
    expect(visualOrder("אב 12 ג")).toBe("ג 12 בא");
  });
  it("puts the right-to-left phrase after an English start in a left-to-right paragraph", () => {
    expect(visualOrder("see אבג now")).toBe("see גבא now");
  });
  it("mirrors brackets in right-to-left runs", () => {
    expect(visualOrder("א(ב)")).toBe("(ב)א");
  });
  it("treats numbers after Arabic letters as Arabic numbers read left to right", () => {
    expect(visualOrder("ب 12")).toBe("12 ب");
  });
});

describe("forPdf", () => {
  it("is the identity for text without right-to-left characters, and shapes then reorders otherwise", () => {
    expect(forPdf("Plain text")).toBe("Plain text");
    expect(hasArabic("بيت")).toBe(true);
    expect(forPdf("بيت")).toBe("ﺖﻴﺑ"); // reversed shaped forms
  });
});
