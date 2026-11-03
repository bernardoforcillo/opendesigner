import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ITEMS, MAX_SNIPPET_CHARS, findItem, loadLibrary, removeItem, saveItem } from "@/store/objectLibrary";

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

let st: MemStorage;
beforeEach(() => { st = new MemStorage(); });

describe("object library", () => {
  it("starts empty and keeps what is saved, in order", () => {
    expect(loadLibrary(st)).toEqual([]);
    const a = saveItem("Logo", "{a}", st, 1);
    const b = saveItem("Callout", "{b}", st, 2);
    expect(typeof a).toBe("object");
    expect(typeof b).toBe("object");
    expect(loadLibrary(st).map((i) => i.name)).toEqual(["Logo", "Callout"]);
  });
  it("replaces an item of the same name (ignoring case) and keeps its id", () => {
    const a = saveItem("Logo", "{a}", st, 1);
    const b = saveItem(" logo ", "{b}", st, 2);
    if (typeof a === "string" || typeof b === "string") throw new Error("save failed");
    expect(b.id).toBe(a.id);
    expect(loadLibrary(st)).toHaveLength(1);
    expect(loadLibrary(st)[0].snippet).toBe("{b}");
  });
  it("finds by id or by name and removes", () => {
    const a = saveItem("Logo", "{a}", st, 1);
    if (typeof a === "string") throw new Error(a);
    expect(findItem(loadLibrary(st), "LOGO")?.id).toBe(a.id);
    expect(findItem(loadLibrary(st), a.id)?.name).toBe("Logo");
    expect(removeItem("nothing", st)).toBe(false);
    expect(removeItem("logo", st)).toBe(true);
    expect(loadLibrary(st)).toEqual([]);
  });
  it("refuses an empty name, a huge snippet and a full library", () => {
    expect(saveItem("  ", "{}", st)).toBe("name is required");
    expect(saveItem("x", "x".repeat(MAX_SNIPPET_CHARS + 1), st)).toMatch(/too large/);
    for (let i = 0; i < MAX_ITEMS; i++) saveItem(`n${i}`, "{}", st, i);
    expect(saveItem("one more", "{}", st)).toMatch(/at most/);
    expect(typeof saveItem("n0", "{new}", st)).toBe("object"); // replacing is still allowed
  });
  it("reads garbage as an empty library and reports missing storage", () => {
    st.setItem("opendesigner.objectLibrary.v1", "not json");
    expect(loadLibrary(st)).toEqual([]);
    st.setItem("opendesigner.objectLibrary.v1", JSON.stringify([{ id: 1 }, { id: "a", name: "n", snippet: "s", createdAt: 1 }]));
    expect(loadLibrary(st)).toHaveLength(1);
    expect(saveItem("a", "{}", null)).toMatch(/not available/);
  });
});
