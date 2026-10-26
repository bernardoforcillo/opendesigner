import { describe, it, expect } from "vitest";
import { hyphenPoints } from "@/renderer/hyphenate";

const split = (w: string) => {
  const pts = hyphenPoints(w);
  const out: string[] = [];
  let prev = 0;
  for (const p of pts) { out.push(w.slice(prev, p)); prev = p; }
  out.push(w.slice(prev));
  return out.join("-");
};

describe("hyphenPoints", () => {
  it("breaks before a consonant between vowels", () => {
    expect(split("typography")).toContain("-");
    expect(split("computer")).toBe("com-pu-ter");
    expect(split("camera")).toBe("ca-mera");
  });
  it("breaks double consonants and keeps clusters together", () => {
    expect(split("bottega")).toBe("bot-tega");
    expect(split("lettera")).toBe("let-tera");
    expect(split("patrono")).not.toContain("t-r");
  });
  it("never leaves fewer than two letters before or three after", () => {
    for (const w of ["abacus", "elementary", "quadrato", "ubiquity"]) {
      for (const p of hyphenPoints(w)) {
        expect(p).toBeGreaterThanOrEqual(2);
        expect(w.length - p).toBeGreaterThanOrEqual(3);
      }
    }
  });
  it("leaves short words, digits and punctuation alone", () => {
    expect(hyphenPoints("cat")).toEqual([]);
    expect(hyphenPoints("room")).toEqual([]);
    expect(hyphenPoints("abc123def")).toEqual([]);
    expect(hyphenPoints("well-known")).toEqual([]);
  });
});
