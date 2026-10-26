import { describe, it, expect } from "vitest";
import { emptyScene, type PageLite, type SceneState } from "@/store/types";
import { BLANK_PAGE, bookletGroups } from "@/export/printPdf";

const sceneOf = (n: number): SceneState => {
  const s = emptyScene("d", "d");
  const pages: PageLite[] = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, width: 100, height: 150 }));
  return { ...s, pages };
};
const names = (s: SceneState) => bookletGroups(s).map((g) => g.map((p) => (p.id.startsWith(BLANK_PAGE) ? "-" : p.name)).join("|"));

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
