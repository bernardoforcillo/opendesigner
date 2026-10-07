import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FontLite } from "../store/types";
import { resetFontRegistry, syncDocumentFonts } from "./fontRegistry";

class FakeFace {
  static all: FakeFace[] = [];
  loaded = false;
  constructor(public family: string, public source: string, public descriptors: { weight: string; style: string }) { FakeFace.all.push(this); }
  async load() { this.loaded = true; }
}
class FakeSet {
  items = new Set<unknown>();
  add = vi.fn((f: unknown) => this.items.add(f));
  delete = vi.fn((f: unknown) => this.items.delete(f));
}
const font = (id: string, hash = "a".repeat(64), weight = "400"): FontLite => ({ id, family: "Brand Sans", weight, style: "normal", assetHash: hash });

describe("syncDocumentFonts", () => {
  let set: FakeSet;
  beforeEach(() => { resetFontRegistry(); FakeFace.all = []; set = new FakeSet(); });
  const sync = (doc: string, fonts: Record<string, FontLite>) => syncDocumentFonts(doc, fonts, null, set, FakeFace);

  it("registers each font once, from the asset route, with its weight and style", () => {
    const fonts = { f1: font("f1"), f2: font("f2", "b".repeat(64), "700") };
    sync("doc1", fonts);
    sync("doc1", fonts);                                   // same object: nothing to do
    expect(FakeFace.all).toHaveLength(2);
    expect(FakeFace.all[0]).toMatchObject({ family: "Brand Sans", source: `url(/assets-api/doc1/${"a".repeat(64)})`, descriptors: { weight: "400", style: "normal" }, loaded: true });
    expect(set.items.size).toBe(2);
  });

  it("replaces a font whose file changed, removes a deleted one and keeps the untouched", () => {
    sync("doc1", { f1: font("f1"), f2: font("f2", "b".repeat(64), "700") });
    const [first, second] = FakeFace.all;
    sync("doc1", { f1: font("f1", "c".repeat(64)) });
    expect(set.items.has(first)).toBe(false);              // replaced
    expect(set.items.has(second)).toBe(false);             // deleted
    expect(FakeFace.all).toHaveLength(3);
    expect(set.items.size).toBe(1);
    const survivor = FakeFace.all[2];
    sync("doc1", { f1: font("f1", "c".repeat(64)), f3: font("f3", "d".repeat(64), "300") });
    expect(set.items.has(survivor)).toBe(true);            // not re-created
    expect(FakeFace.all).toHaveLength(4);
  });

  it("does nothing without a FontFaceSet (non-browser environments)", () => {
    expect(() => syncDocumentFonts("doc1", { f1: font("f1") }, null, undefined, undefined)).not.toThrow();
  });

  it("a font that fails to load does not throw", async () => {
    class Failing extends FakeFace { async load(): Promise<void> { throw new Error("offline"); } }
    expect(() => syncDocumentFonts("doc1", { f1: font("f1") }, null, set, Failing)).not.toThrow();
    await Promise.resolve();
  });
});

describe("syncDocumentFonts — only what the page needs", () => {
  it("registers every face but loads only the families in use, and the rest when the page changes", () => {
    const loaded: string[] = [];
    class Face { constructor(public family: string) {} load() { loaded.push(this.family); return Promise.resolve(); } }
    const set = { add: () => {}, delete: () => {} };
    const fonts = { a: { ...font("a"), family: "Alpha" }, b: { ...font("b"), family: "Beta" } };
    resetFontRegistry();
    syncDocumentFonts("d", fonts, new Set(["alpha"]), set, Face as never);
    expect(loaded).toEqual(["Alpha"]);
    syncDocumentFonts("d", fonts, new Set(["alpha"]), set, Face as never);
    expect(loaded).toEqual(["Alpha"]);
    syncDocumentFonts("d", fonts, new Set(["alpha", "beta"]), set, Face as never);
    expect(loaded).toEqual(["Alpha", "Beta"]);
  });
});
