import { describe, it, expect } from "vitest";
import { NodeMap } from "./nodeMap";
import type { NodeLite } from "./types";

const n = (id: string, x = 0): NodeLite => ({
  id, parentId: "p", orderKey: "a", name: id, visible: true, opacity: 1, x, y: 0, width: 1, height: 1, rotation: 0,
  fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});

describe("NodeMap", () => {
  it("get/has/set/delete are persistent: the old map does not change", () => {
    const a = NodeMap.from([["a", n("a")], ["b", n("b")]]);
    const b = a.set("c", n("c")).set("a", n("a", 5)).delete("b");
    expect([...a.ids()].sort()).toEqual(["a", "b"]);
    expect(a.get("a")!.x).toBe(0);
    expect([...b.ids()].sort()).toEqual(["a", "c"]);
    expect(b.get("a")!.x).toBe(5);
    expect(b.has("b")).toBe(false);
    expect(a.size).toBe(2);
    expect(b.size).toBe(2);
  });

  it("set of the same object and delete of an absent one return the same map", () => {
    const x = n("a");
    const a = NodeMap.from([["a", x]]);
    expect(a.set("a", x)).toBe(a);
    expect(a.delete("zzz")).toBe(a);
    expect(a.edit().done()).toBe(a);
  });

  it("the editor copies each bucket once and does not touch the base", () => {
    const base = NodeMap.from(Array.from({ length: 1000 }, (_, i) => [`n${i}`, n(`n${i}`)] as const));
    const e = base.edit();
    for (let i = 0; i < 1000; i += 2) e.set(`n${i}`, n(`n${i}`, 9));
    for (let i = 1; i < 1000; i += 10) e.delete(`n${i}`);
    const out = e.done();
    expect(base.size).toBe(1000);
    expect(base.get("n0")!.x).toBe(0);
    expect(out.get("n0")!.x).toBe(9);
    expect(out.size).toBe(1000 - 100);
    expect([...out.ids()].length).toBe(out.size);
  });

  it("diff finds new, changed and removed, ignoring shared buckets", () => {
    const base = NodeMap.from(Array.from({ length: 5000 }, (_, i) => [`n${i}`, n(`n${i}`)] as const));
    const next = base.set("n7", n("n7", 1)).set("new", n("new")).delete("n9");
    const changed: string[] = [];
    const removed: string[] = [];
    expect(next.diff(base, changed, removed)).toBe(true);
    expect(changed.sort()).toEqual(["n7", "new"]);
    expect(removed).toEqual(["n9"]);
    // Over the limit: gives up.
    expect(next.diff(base, [], [], 0)).toBe(false);
  });

  it("updating one entry out of 20,000 is much cheaper than copying everything", () => {
    const base = NodeMap.from(Array.from({ length: 20000 }, (_, i) => [`id-${i}-abcdef`, n(`id-${i}-abcdef`)] as const));
    const t0 = performance.now();
    let m = base;
    for (let i = 0; i < 100; i++) m = m.set("id-5-abcdef", n("id-5-abcdef", i));
    const per = (performance.now() - t0) / 100;
    expect(per).toBeLessThan(1);
  });
});
