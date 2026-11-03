import { describe, it, expect } from "vitest";
import { emptyScene, type PageLite, type SceneState } from "@/store/types";
import { BLANK_PAGE, bookletGroups, creepShift } from "@/export/printPdf";

const sceneOf = (n: number): SceneState => {
  const s = emptyScene("d", "d");
  const pages: PageLite[] = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, width: 100, height: 150 }));
  return { ...s, pages };
};
const names = (s: SceneState) => bookletGroups(s).map((g) => g.map((p) => (p.id.startsWith(BLANK_PAGE) ? "-" : p.name)).join("|"));

describe("creepShift", () => {
  it("leaves the outermost sheet alone and moves inner sheets toward the spine", () => {
    // sides 0 and 1 are the outer sheet; 2 and 3 the next one in.
    expect(creepShift(0, 2, "left")).toBe(0);
    expect(creepShift(1, 2, "right")).toBe(0);
    expect(creepShift(2, 2, "left")).toBe(2);
    expect(creepShift(3, 2, "right")).toBe(-2);
    expect(creepShift(4, 2, "left")).toBe(4);
  });
  it("is zero without creep", () => {
    expect(creepShift(5, 0, "left")).toBe(0);
    expect(creepShift(5, -1, "right")).toBe(0);
  });
});

describe("bookletGroups", () => {
  it("pairs 8 pages as saddle-stitch sheets", () => {
    expect(names(sceneOf(8))).toEqual(["P8|P1", "P2|P7", "P6|P3", "P4|P5"]);
  });
  it("pads to a multiple of four with blanks at the back", () => {
    expect(names(sceneOf(5))).toEqual(["-|P1", "P2|-", "-|P3", "P4|P5"]);
    expect(bookletGroups(sceneOf(5)).flat().filter((p) => p.id.startsWith(BLANK_PAGE))).toHaveLength(3);
  });
  it("is empty without pages and ignores master pages", () => {
    expect(bookletGroups({ ...emptyScene("d", "d"), pages: [] })).toEqual([]);
    const s = sceneOf(4);
    expect(names({ ...s, pages: [...s.pages, { id: "m", name: "A-Master", isMaster: true }] })).toEqual(["P4|P1", "P2|P3"]);
  });
});
