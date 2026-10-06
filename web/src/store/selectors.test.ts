import { describe, it, expect } from "vitest";
import { layersInDrawOrder, selectionSummary, MIXED } from "./selectors";
import { emptyScene } from "./types";
import type { SceneState, NodeLite } from "./types";

function node(over: Partial<NodeLite> & { id: string; orderKey: string }): NodeLite {
  return {
    parentId: "page1", name: "n", visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function sceneWith(nodes: NodeLite[]): SceneState {
  const s = emptyScene("d", "n");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

describe("layersInDrawOrder", () => {
  it("returns an empty list for an empty scene", () => {
    expect(layersInDrawOrder(emptyScene("d", "n"))).toEqual([]);
  });

  it("orders front-most first — the reverse of paint order", () => {
    // Paint order (back to front) by orderKey ascending: n1, n2, n3.
    const s = sceneWith([
      node({ id: "n1", orderKey: "a000000" }),
      node({ id: "n2", orderKey: "a000001" }),
      node({ id: "n3", orderKey: "a000002" }),
    ]);
    expect(layersInDrawOrder(s).map((n) => n.id)).toEqual(["n3", "n2", "n1"]);
  });

  it("re-derives order from orderKey regardless of insertion order into the map", () => {
    const s = sceneWith([
      node({ id: "b", orderKey: "a000005" }),
      node({ id: "a", orderKey: "a000001" }),
      node({ id: "c", orderKey: "a000009" }),
    ]);
    expect(layersInDrawOrder(s).map((n) => n.id)).toEqual(["c", "b", "a"]);
  });
});

describe("selectionSummary", () => {
  it("returns null for an empty selection", () => {
    const s = sceneWith([node({ id: "n1", orderKey: "a000000" })]);
    expect(selectionSummary(s, [])).toBeNull();
  });

  it("ignores ids that no longer exist in the scene", () => {
    const s = sceneWith([node({ id: "n1", orderKey: "a000000" })]);
    expect(selectionSummary(s, ["ghost"])).toBeNull();
  });

  it("reports every field as its actual value for a single selected node", () => {
    const s = sceneWith([
      node({ id: "n1", orderKey: "a000000", name: "Rect", x: 10, y: 20, width: 30, height: 40,
        rotation: 5, opacity: 0.5, visible: false, cornerRadius: 2, clipsContent: false, kind: "rect",
        fills: [{ r: 0.1, g: 0.2, b: 0.3, a: 1 }] }),
    ]);
    const sum = selectionSummary(s, ["n1"]);
    expect(sum).toEqual({
      count: 1,
      name: "Rect", kind: "rect", visible: false, opacity: 0.5,
      x: 10, y: 20, width: 30, height: 40, rotation: 5, cornerRadius: 2,
      fills: [{ r: 0.1, g: 0.2, b: 0.3, a: 1 }],
      strokes: [],
    });
  });

  it("reports a shared value as common and a differing value as MIXED", () => {
    const s = sceneWith([
      node({ id: "n1", orderKey: "a000000", name: "Rect", x: 0, y: 0, kind: "rect" }),
      node({ id: "n2", orderKey: "a000001", name: "Rect", x: 100, y: 0, kind: "ellipse" }),
    ]);
    const sum = selectionSummary(s, ["n1", "n2"]);
    expect(sum?.count).toBe(2);
    expect(sum?.name).toBe("Rect");   // same on both -> common value
    expect(sum?.y).toBe(0);           // same on both -> common value
    expect(sum?.x).toBe(MIXED);       // 0 vs 100 -> mixed
    expect(sum?.kind).toBe(MIXED);    // rect vs ellipse -> mixed
  });

  it("compares fills structurally, not by reference", () => {
    const s = sceneWith([
      node({ id: "n1", orderKey: "a000000", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
      node({ id: "n2", orderKey: "a000001", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
    ]);
    const sum = selectionSummary(s, ["n1", "n2"]);
    expect(sum?.fills).toEqual([{ r: 1, g: 0, b: 0, a: 1 }]);

    const s2 = sceneWith([
      node({ id: "n1", orderKey: "a000000", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
      node({ id: "n2", orderKey: "a000001", fills: [{ r: 0, g: 1, b: 0, a: 1 }] }),
    ]);
    expect(selectionSummary(s2, ["n1", "n2"])?.fills).toBe(MIXED);
  });

  it("compares strokes on ALL three fields, not just on color", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const same = sceneWith([
      node({ id: "n1", orderKey: "a000000", strokes: [{ color: black, weight: 2, align: "center" }] }),
      node({ id: "n2", orderKey: "a000001", strokes: [{ color: black, weight: 2, align: "center" }] }),
    ]);
    expect(selectionSummary(same, ["n1", "n2"])?.strokes)
      .toEqual([{ color: black, weight: 2, align: "center" }]);

    // Same color, different thickness: NOT the same stroke.
    const byWeight = sceneWith([
      node({ id: "n1", orderKey: "a000000", strokes: [{ color: black, weight: 2, align: "center" }] }),
      node({ id: "n2", orderKey: "a000001", strokes: [{ color: black, weight: 8, align: "center" }] }),
    ]);
    expect(selectionSummary(byWeight, ["n1", "n2"])?.strokes).toBe(MIXED);

    // Same color and thickness, different position: neither.
    const byAlign = sceneWith([
      node({ id: "n1", orderKey: "a000000", strokes: [{ color: black, weight: 2, align: "inside" }] }),
      node({ id: "n2", orderKey: "a000001", strokes: [{ color: black, weight: 2, align: "outside" }] }),
    ]);
    expect(selectionSummary(byAlign, ["n1", "n2"])?.strokes).toBe(MIXED);

    // And "no stroke" versus "a stroke" is mixed, not a common value.
    const byCount = sceneWith([
      node({ id: "n1", orderKey: "a000000", strokes: [] }),
      node({ id: "n2", orderKey: "a000001", strokes: [{ color: black, weight: 2, align: "center" }] }),
    ]);
    expect(selectionSummary(byCount, ["n1", "n2"])?.strokes).toBe(MIXED);
  });

  // x/y are the ORIGIN OF THE FRAME (store/groups.ts::frameOriginOf), not the
  // raw field: for a group the two things do not coincide -- a group's x/y
  // are the translation that contributes to the children, and showing them as "X" would
  // make the panel report a different number from the one where the frame is seen.
  it("reports a group's x/y as the origin of its FRAME, not its translation", () => {
    const s = sceneWith([
      node({ id: "g", orderKey: "a000000", kind: "group", x: 0, y: 0, width: 0, height: 0, fills: [] }),
      node({ id: "c", orderKey: "a000000", parentId: "g", x: 10, y: 20, width: 30, height: 40 }),
    ]);
    const sum = selectionSummary(s, ["g"]);
    expect(sum?.x).toBe(10);
    expect(sum?.y).toBe(20);
  });

  it("is MIXED across three nodes when only the third differs", () => {
    const s = sceneWith([
      node({ id: "n1", orderKey: "a000000", opacity: 1 }),
      node({ id: "n2", orderKey: "a000001", opacity: 1 }),
      node({ id: "n3", orderKey: "a000002", opacity: 0.2 }),
    ]);
    expect(selectionSummary(s, ["n1", "n2", "n3"])?.opacity).toBe(MIXED);
  });
});
