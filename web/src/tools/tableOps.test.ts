import { describe, it, expect } from "vitest";
import { applyOp } from "@/store/applyOp";
import { emptyScene, type SceneState } from "@/store/types";
import { childrenOf } from "@/store/tree";
import { makeSetTextOp } from "@/tools/ops";
import { addColumnOps, addRowOps, cellOf, coverage, createTableOps, deleteColumnOps, deleteRowOps, mergeCellsOps, readTable, resizeTableOps, selectionCellRange, spanOf, splitCellOps, tableIdOf } from "@/tools/tableOps";

const run = (s: SceneState, ops: { length: number }[] | ReturnType<typeof addRowOps>) => (ops as ReturnType<typeof addRowOps>).reduce(applyOp, s);

function make(rows = 2, cols = 3): { scene: SceneState; id: string } {
  const base = emptyScene("d", "d");
  const t = createTableOps(base, "page1", 100, 50, rows, cols, 100, 30, 1)!;
  return { scene: run(base, t.ops), id: t.selection[0] };
}
const at = (s: SceneState, id: string, r: number, c: number) => readTable(s, id)!.cells.get(`${r},${c}`)!;

describe("tables", () => {
  it("creates a group of cells with the grid in its meta", () => {
    const { scene, id } = make();
    const t = readTable(scene, id)!;
    expect(t.cols).toEqual([100, 100, 100]);
    expect(t.rows).toEqual([30, 30]);
    expect(t.head).toBe(1);
    expect(t.cells.size).toBe(6);
    expect(childrenOf(scene, id)).toHaveLength(12); // a rectangle and a text per cell
    expect(at(scene, id, 1, 2).rect).toMatchObject({ x: 300, y: 80, width: 100, height: 30 });
    expect(at(scene, id, 0, 0).rect!.fills[0].r).toBeLessThan(1); // header tint
    expect(at(scene, id, 0, 0).text!.text!.style.fontWeight).toBe("700");
    expect(at(scene, id, 1, 0).text!.text!.style.fontWeight).toBe("");
  });
  it("finds the table and the cell from any of its nodes", () => {
    const { scene, id } = make();
    const text = at(scene, id, 1, 1).text!;
    expect(tableIdOf(scene, text.id)).toBe(id);
    expect(tableIdOf(scene, id)).toBe(id);
    expect(tableIdOf(scene, "page1")).toBeNull();
    expect(cellOf(scene, text.id)).toEqual([1, 1]);
  });
  it("refuses an empty or oversized grid", () => {
    expect(createTableOps(emptyScene("d", "d"), "page1", 0, 0, 0, 3)).toBeNull();
    expect(createTableOps(emptyScene("d", "d"), "page1", 0, 0, 3, 101)).toBeNull();
    expect(createTableOps(emptyScene("d", "d"), "page1", 0, 0, 3, 3, 2, 2)).toBeNull();
  });
  it("adds a row after another, moving the ones below and keeping the text", () => {
    let { scene, id } = make();
    const textBelow = at(scene, id, 1, 0).text!.id;
    scene = run(scene, addRowOps(scene, id, 0));
    const t = readTable(scene, id)!;
    expect(t.rows).toEqual([30, 30, 30]);
    expect(t.cells.size).toBe(9);
    expect(at(scene, id, 2, 0).text!.id).toBe(textBelow);
    expect(at(scene, id, 2, 0).rect).toMatchObject({ y: 110 });
    expect(at(scene, id, 1, 0).rect).toMatchObject({ y: 80, height: 30 });
  });
  it("adds a row above the header, which becomes part of the header", () => {
    let { scene, id } = make();
    scene = run(scene, addRowOps(scene, id, -1));
    expect(readTable(scene, id)!.head).toBe(2);
    expect(readTable(scene, id)!.rows).toHaveLength(3);
    expect(at(scene, id, 0, 0).rect!.fills[0].r).toBeLessThan(1);
  });
  it("adds a column, shifting the ones to its right", () => {
    let { scene, id } = make();
    const last = at(scene, id, 0, 2).rect!.id;
    scene = run(scene, addColumnOps(scene, id, 0));
    expect(readTable(scene, id)!.cols).toEqual([100, 100, 100, 100]);
    expect(at(scene, id, 0, 3).rect).toMatchObject({ id: last, x: 400 });
  });
  it("deletes a row and a column, never the last one", () => {
    let { scene, id } = make(3, 3);
    scene = run(scene, deleteRowOps(scene, id, 1));
    scene = run(scene, deleteColumnOps(scene, id, 0));
    const t = readTable(scene, id)!;
    expect(t.rows).toHaveLength(2);
    expect(t.cols).toHaveLength(2);
    expect(t.cells.size).toBe(4);
    expect(childrenOf(scene, id)).toHaveLength(8);
    const one = make(1, 1);
    expect(deleteRowOps(one.scene, one.id, 0)).toEqual([]);
    expect(deleteColumnOps(one.scene, one.id, 0)).toEqual([]);
  });
  it("resizes a column and a row, moving everything after", () => {
    let { scene, id } = make();
    scene = run(scene, resizeTableOps(scene, id, "col", 0, 150));
    expect(at(scene, id, 0, 1).rect).toMatchObject({ x: 250 });
    expect(at(scene, id, 0, 0).text).toMatchObject({ width: 138 });
    scene = run(scene, resizeTableOps(scene, id, "row", 0, 50));
    expect(at(scene, id, 1, 0).rect).toMatchObject({ y: 100 });
    expect(resizeTableOps(scene, id, "row", 0, 50)).toEqual([]); // unchanged
    expect(resizeTableOps(scene, id, "row", 0, 2)).toEqual([]); // too small
  });
});

describe("cell spanning", () => {
  const typed = (s: SceneState, id: string, r: number, c: number, content: string) => {
    const n = at(s, id, r, c).text!;
    return applyOp(s, makeSetTextOp(n.id, content, n.text!.style));
  };
  const range = (id: string, r0: number, c0: number, r1: number, c1: number) => ({ tableId: id, r0, c0, r1, c1 });

  it("merges a block into its top-left cell: grown over the area, the others gone, their texts joined", () => {
    let { scene, id } = make(3, 3);
    scene = typed(typed(scene, id, 0, 0, "A"), id, 0, 1, "B");
    scene = typed(scene, id, 1, 1, "");
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 1, 1)));
    const t = readTable(scene, id)!;
    const anchor = t.cells.get("0,0")!;
    expect(spanOf(anchor)).toEqual([2, 2]);
    expect(anchor.rect).toMatchObject({ x: 100, y: 50, width: 200, height: 60 });
    expect(anchor.text).toMatchObject({ x: 106, y: 54, width: 188, height: 52 });
    expect(anchor.text!.text!.content).toBe("A\nB");
    expect(t.cells.has("0,1")).toBe(false);
    expect(t.cells.has("1,0")).toBe(false);
    expect(t.cells.has("1,1")).toBe(false);
    expect(t.cells.size).toBe(9 - 3);
    // every position is covered exactly once
    expect(coverage(t).size).toBe(9);
    expect(coverage(t).get("1,1")).toBe("0,0");
  });

  it("refuses a block of one cell, one outside the table, or one cutting through a merged cell", () => {
    let { scene, id } = make(3, 3);
    expect(mergeCellsOps(scene, range(id, 1, 1, 1, 1))).toEqual([]);
    expect(mergeCellsOps(scene, range(id, 0, 0, 3, 0))).toEqual([]);
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 0, 1)));
    expect(mergeCellsOps(scene, range(id, 0, 1, 1, 2))).toEqual([]); // the merged cell reaches in from the left
    expect(mergeCellsOps(scene, range(id, 0, 0, 1, 0))).toEqual([]); // and reaches out of this one
  });

  it("merges over an existing merged cell when it fits inside the block", () => {
    let { scene, id } = make(3, 3);
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 0, 1)));
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 1, 2)));
    const t = readTable(scene, id)!;
    expect(spanOf(t.cells.get("0,0"))).toEqual([2, 3]);
    expect(t.cells.size).toBe(1 + 3); // the merged cell and the third row
  });

  it("splits a merged cell back into empty single cells", () => {
    let { scene, id } = make(2, 3);
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 1, 1)));
    scene = run(scene, splitCellOps(scene, id, 0, 0));
    const t = readTable(scene, id)!;
    expect(t.cells.size).toBe(6);
    expect(spanOf(t.cells.get("0,0"))).toEqual([1, 1]);
    expect(t.cells.get("0,0")!.rect).toMatchObject({ width: 100, height: 30 });
    expect(t.cells.get("1,1")!.rect).toMatchObject({ x: 200, y: 80, width: 100, height: 30 });
    expect(splitCellOps(scene, id, 0, 0)).toEqual([]); // nothing to split
  });

  it("a row added inside a merged cell lengthens it; a row added beside it moves it", () => {
    let { scene, id } = make(3, 2);
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 1, 0)));
    scene = run(scene, addRowOps(scene, id, 0)); // between the two rows it covers
    let t = readTable(scene, id)!;
    expect(spanOf(t.cells.get("0,0"))).toEqual([3, 1]);
    expect(t.cells.get("0,0")!.rect).toMatchObject({ height: 90 });
    expect(coverage(t).size).toBe(4 * 2);
    scene = run(scene, addRowOps(scene, id, -1)); // above everything
    t = readTable(scene, id)!;
    expect(spanOf(t.cells.get("1,0"))).toEqual([3, 1]);
  });

  it("a row removed from a merged cell shortens it; removing its first row drops the merge", () => {
    let { scene, id } = make(4, 2);
    scene = run(scene, mergeCellsOps(scene, range(id, 1, 0, 3, 0)));
    scene = run(scene, deleteRowOps(scene, id, 2));
    let t = readTable(scene, id)!;
    expect(spanOf(t.cells.get("1,0"))).toEqual([2, 1]);
    expect(t.cells.get("1,0")!.rect).toMatchObject({ height: 60 });
    expect(coverage(t).size).toBe(3 * 2);
    scene = run(scene, deleteRowOps(scene, id, 1)); // the row the merged cell starts in
    t = readTable(scene, id)!;
    expect(t.rows).toHaveLength(2);
    expect(coverage(t).size).toBe(4); // the covered row got empty cells back
    for (const cell of t.cells.values()) expect(spanOf(cell)).toEqual([1, 1]);
  });

  it("a column resized under a merged cell resizes the cell", () => {
    let { scene, id } = make(2, 3);
    scene = run(scene, mergeCellsOps(scene, range(id, 0, 0, 0, 1)));
    scene = run(scene, resizeTableOps(scene, id, "col", 1, 150));
    expect(readTable(scene, id)!.cells.get("0,0")!.rect).toMatchObject({ width: 250 });
  });

  it("finds the block a selection of cells covers", () => {
    const { scene, id } = make(3, 3);
    const ids = [at(scene, id, 0, 1).rect!.id, at(scene, id, 1, 2).text!.id];
    expect(selectionCellRange(scene, ids)).toEqual({ tableId: id, r0: 0, c0: 1, r1: 1, c1: 2 });
    expect(selectionCellRange(scene, [ids[0], "page1"])).toBeNull();
    expect(selectionCellRange(scene, [])).toBeNull();
  });
});
