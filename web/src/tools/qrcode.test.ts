import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { qrMatrix, qrRuns, qrVersionFor, qrCapacity } from "./qrcode";

const PINNED = { helloM: "6e548e55859cd0121b4b7df64c45c4cdcab87e76", longL: "5cc6683e965db4b0e951d5a1b26f9babb39e2717", foxM: "c6db65cc33d480d74d7e6ba82acc90ce9eb44cc3" };

describe("qrcode", () => {
  it("picks the smallest version and rejects what does not fit", () => {
    expect(qrVersionFor(17, "L")).toBe(1);
    expect(qrVersionFor(18, "L")).toBe(2);
    expect(() => qrMatrix("x".repeat(qrCapacity("L") + 1), "L")).toThrow(/too long/);
  });
  it("has the size of its version and finder patterns", () => {
    const m = qrMatrix("hello", "M");
    expect(m.length).toBe(21);
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true);
    expect(m[3]![3]).toBe(true);
  });
  it("covers every dark module with runs", () => {
    const m = qrMatrix("https://example.org/a", "Q");
    const dark = m.flat().filter(Boolean).length;
    expect(qrRuns(m).reduce((a, r) => a + r.width, 0)).toBe(dark);
  });
  it("is stable: matrices decoded by an external reader (OpenCV) stay byte-identical", () => {
    const sig = (t: string, l: "L" | "M" | "Q" | "H") => createHash("sha1").update(qrMatrix(t, l).map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex");
    expect(sig("hello", "M")).toBe(PINNED.helloM);
    expect(sig("y".repeat(250), "L")).toBe(PINNED.longL);
    expect(sig("The quick brown fox".repeat(9), "M")).toBe(PINNED.foxM);
  });
});
