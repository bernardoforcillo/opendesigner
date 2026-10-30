import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { en } from "@/i18n/locales/en";
import { preflightReport } from "@/export/preflight";

// Every message the preflight writes is a key of the English catalog (so the panel can translate it).
describe("preflight messages are translatable", () => {
  it("each msg(...) key is in the catalog", () => {
    const src = readFileSync("src/export/preflight.ts", "utf8");
    const keys = [...src.matchAll(/msg\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)].map((m) => (m[1] ?? m[2]!).replace(/\\"/g, '"'));
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) expect(Object.keys(en), k).toContain(k);
  });

  it("keeps the English text and the template together", () => {
    const [a] = preflightReport({ lowResolution: [{ page: "P1", ppi: 72 }], missingGlyphs: [], flattened: [], transparency: false, usesRgb: false } as never);
    expect(a.message).toBe('An image on "P1" prints at 72 ppi (under 150).');
    expect(a.key).toBe('An image on "{page}" prints at {ppi} ppi (under 150).');
    const [b] = preflightReport({ lowResolution: [], missingGlyphs: [], flattened: [1, 2], transparency: false, usesRgb: false } as never);
    expect(b.message).toContain("2 objects use blur");
    expect(b.plural).toBe(true);
  });
});
