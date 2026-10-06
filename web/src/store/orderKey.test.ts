import { describe, it, expect } from "vitest";
import { nextOrderKey, orderKeyBetween } from "./orderKey";
import { emptyScene } from "./types";
import type { SceneState, NodeLite } from "./types";

function sceneWith(keys: string[]): SceneState {
  const s = emptyScene("d", "n");
  keys.forEach((k, i) => {
    s.nodes = s.nodes.set("n" + i, { id: "n" + i, parentId: "page1", orderKey: k, name: "n", visible: true,
      opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], strokes: [],
      kind: "rect", cornerRadius: 0, clipsContent: false } as NodeLite);
  });
  return s;
}

describe("nextOrderKey", () => {
  it("starts at a stable first key on an empty scene", () => {
    expect(nextOrderKey(emptyScene("d", "n"))).toBe("a000000");
  });

  it("REGRESSION: never collides with keys already in the document", () => {
    // The M0 bug: a module counter restarted from 0 after reload and re-emitted a000000.
    const s = sceneWith(["a000000", "a000001", "a000002"]);
    const k = nextOrderKey(s);
    expect([...s.nodes.values()].some((n) => n.orderKey === k)).toBe(false);
    expect(k > "a000002").toBe(true);
  });

  it("sorts after the highest existing key, not the count", () => {
    const s = sceneWith(["a000005"]);           // a single node, but a high key
    expect(nextOrderKey(s) > "a000005").toBe(true);
  });

  it("is monotonic when called repeatedly against a growing scene", () => {
    const s = sceneWith([]);
    let prev = "";
    for (let i = 0; i < 5; i++) {
      const k = nextOrderKey(s);
      expect(k > prev).toBe(true);
      s.nodes = s.nodes.set("x" + i, { orderKey: k } as NodeLite);
      prev = k;
    }
  });
});

describe("orderKeyBetween", () => {
  it("produces a key strictly between two adjacent keys", () => {
    const k = orderKeyBetween("a000001", "a000002");
    expect(k > "a000001").toBe(true);
    expect(k < "a000002").toBe(true);
  });

  it("supports repeated insertion in the same gap (the reorder stress case)", () => {
    let lo = "a000001", hi = "a000002";
    for (let i = 0; i < 50; i++) {
      const k = orderKeyBetween(lo, hi);
      expect(k > lo && k < hi).toBe(true);
      hi = k;                       // I always insert just above lo
    }
  });

  it("handles the open ends", () => {
    expect(orderKeyBetween(null, "a000001") < "a000001").toBe(true);
    expect(orderKeyBetween("a000001", null) > "a000001").toBe(true);
    expect(typeof orderKeyBetween(null, null)).toBe("string");
  });

  it("keeps existing M1a keys sortable alongside new ones", () => {
    const mid = orderKeyBetween("a000000", "a000001");
    expect(["a000001", mid, "a000000"].sort()).toEqual(["a000000", mid, "a000001"]);
  });

  it("rejects an inverted or equal range instead of emitting a broken key", () => {
    expect(() => orderKeyBetween("a000002", "a000001")).toThrow();
    expect(() => orderKeyBetween("a000001", "a000001")).toThrow();
  });

  // Fractional index invariant: if a key ended with the lowest digit
  // of the alphabet, no key could ever be inserted right before it
  // (between "x" and "x0" no string exists).
  it("never emits a key ending in the lowest digit of the alphabet", () => {
    let lo = "a000001", hi = "a000002";
    for (let i = 0; i < 30; i++) {
      const down = orderKeyBetween(lo, hi);
      expect(down.endsWith("0")).toBe(false);
      hi = down;
      const up = orderKeyBetween(lo, hi);
      expect(up.endsWith("0")).toBe(false);
      lo = up;                      // I narrow the gap from both sides
    }
    expect(orderKeyBetween(null, "a000001").endsWith("0")).toBe(false);
    expect(orderKeyBetween("a00000z", null).endsWith("0")).toBe(false);
  });

  it("stays compact when keys are only ever appended (every new shape)", () => {
    // The carry must not shorten the key: 1000 appends stay at 7 characters.
    let k: string | null = null;
    let prev = "";
    for (let i = 0; i < 1000; i++) {
      k = orderKeyBetween(k, null);
      expect(k > prev).toBe(true);
      prev = k;
    }
    expect((k as string).length).toBe("a000000".length);
  });

  it("keeps a whole reordered list sorted the way the drag intended", () => {
    // Simulates drag-and-drop in the layers panel: N insertions into different gaps.
    const keys = ["a000000", "a000001", "a000002", "a000003"];
    for (let i = 0; i < 20; i++) {
      const at = i % (keys.length - 1);
      const k = orderKeyBetween(keys[at], keys[at + 1]);
      keys.splice(at + 1, 0, k);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
