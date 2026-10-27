import { describe, it, expect } from "vitest";
import { applyOp } from "@/store/applyOp";
import { emptyScene, type SceneState } from "@/store/types";
import { childrenOf } from "@/store/tree";
import { addColumnOps, addRowOps, cellOf, createTableOps, deleteColumnOps, deleteRowOps, readTable, resizeTableOps, tableIdOf } from "@/tools/tableOps";

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
