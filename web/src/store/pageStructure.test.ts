import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { invertOp } from "@/store/history";
import { effectiveGuides, deriveMasters, isLeftPage, masterCopyId, masterFieldsValid } from "@/store/masters";
import { formatPageNumber, pageNumbers } from "@/store/pageNumbers";
import { isValidPageSetup, pageColumns, pageGuideBoxes, pageTextArea } from "@/store/docSettings";
import { emptyScene, type NodeLite, type PageLite, type SceneState } from "@/store/types";

const op = (kind: Op["kind"]): Op => create(OpSchema, { opId: "o", docId: "d", kind });
const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const withPages = (pages: PageLite[], settings?: SceneState["settings"]): SceneState => ({ ...emptyScene("d", "Book"), pages, ...(settings ? { settings } : {}) });

describe("page numbers", () => {
  it("formats roman and alphabetic styles", () => {
    expect([1, 4, 9, 14, 1994].map((n) => formatPageNumber(n, "i"))).toEqual(["i", "iv", "ix", "xiv", "mcmxciv"]);
    expect(formatPageNumber(12, "I")).toBe("XII");
    expect([1, 26, 27, 52].map((n) => formatPageNumber(n, "a"))).toEqual(["a", "z", "aa", "az"]);
    expect(formatPageNumber(3, "A")).toBe("C");
    expect(formatPageNumber(7, undefined)).toBe("7");
  });

  it("restarts the count in a section, skipping masters", () => {
    const n = pageNumbers([
      { id: "p1", name: "1", numberStyle: "i" }, { id: "m", name: "M", isMaster: true }, { id: "p2", name: "2" },
      { id: "p3", name: "3", sectionStart: true, numberStart: 5 }, { id: "p4", name: "4" },
    ]);
    expect([...n.values()].map((x) => x.label)).toEqual(["i", "ii", "5", "6"]);
    expect(n.has("m")).toBe(false);
  });
});

describe("master chains, sides and overrides", () => {
  const pages = (): PageLite[] => [
    { id: "base", name: "Base", isMaster: true, guides: [{ vertical: true, position: 30 }] },
    { id: "mr", name: "Right", isMaster: true, masterId: "base" },
    { id: "ml", name: "Left", isMaster: true },
    { id: "p1", name: "1", masterId: "mr", leftMasterId: "ml", guides: [{ vertical: false, position: 90 }] },
    { id: "p2", name: "2", masterId: "mr", leftMasterId: "ml", hiddenMasterItems: ["logo"] },
  ];
  const scene = (facing: boolean): SceneState => {
    let s = withPages(pages(), facing ? { facingPages: true } : undefined);
    for (const n of [
      node({ id: "bg", parentId: "base", orderKey: "a0" }), node({ id: "logo", parentId: "mr", orderKey: "a0" }),
      node({ id: "note", parentId: "ml", orderKey: "a0" }),
    ]) s = { ...s, nodes: s.nodes.set(n.id, n) };
    return s;
  };

  it("validates chains: cycles, depth and left masters", () => {
    const ps = pages();
    expect(masterFieldsValid(ps, { id: "base", name: "b", isMaster: true, masterId: "mr" })).toBe(false); // cycle
    expect(masterFieldsValid(ps, { id: "x", name: "x", masterId: "mr" })).toBe(true);
    expect(masterFieldsValid(ps, { id: "x", name: "x", isMaster: true, leftMasterId: "ml" })).toBe(false);
    expect(masterFieldsValid(ps, { id: "x", name: "x", leftMasterId: "p1" })).toBe(false);
    const deep: PageLite[] = [0, 1, 2, 3, 4].map((i) => ({ id: `m${i}`, name: `m${i}`, isMaster: true, ...(i > 0 ? { masterId: `m${i - 1}` } : {}) }));
    expect(masterFieldsValid(deep, { id: "x", name: "x", masterId: "m4" })).toBe(false); // 5 links
    expect(masterFieldsValid(deep, { id: "x", name: "x", masterId: "m3" })).toBe(true);
  });

  it("draws the base behind the master, and ignores the left master without facing pages", () => {
    const out = deriveMasters(scene(false));
    expect(out.nodes.get(masterCopyId("p1", "bg"))).toBeDefined();
    expect(out.nodes.get(masterCopyId("p1", "logo"))).toBeDefined();
    expect(out.nodes.get(masterCopyId("p1", "note"))).toBeUndefined();
    expect(out.nodes.get(masterCopyId("p1", "bg"))!.orderKey < out.nodes.get(masterCopyId("p1", "logo"))!.orderKey).toBe(true);
  });

  it("uses the left master on even pages of facing pages, and hides overridden items", () => {
    const out = deriveMasters(scene(true));
    expect(out.nodes.get(masterCopyId("p1", "note"))).toBeUndefined(); // page 1 is a right-hand page
    expect(out.nodes.get(masterCopyId("p2", "note"))).toBeDefined();   // page 2 is a left-hand page
    expect(out.nodes.get(masterCopyId("p2", "logo"))).toBeUndefined(); // hidden on p2 (and p2 is left: ml has no logo anyway)
    expect(out.nodes.get(masterCopyId("p1", "logo"))).toBeDefined();
    expect(isLeftPage(scene(true), pages()[4])).toBe(true);
    expect(isLeftPage(scene(false), pages()[4])).toBe(false);
  });

  it("hides an item of the page's own master with its children", () => {
    let s = scene(false);
    s = { ...s, pages: s.pages.map((p) => (p.id === "p1" ? { ...p, hiddenMasterItems: ["logo"] } : p)), nodes: s.nodes.set("kid", node({ id: "kid", parentId: "logo" })) };
    const out = deriveMasters(s);
    expect(out.nodes.get(masterCopyId("p1", "logo"))).toBeUndefined();
    expect(out.nodes.get(masterCopyId("p1", "kid"))).toBeUndefined();
  });

  it("inherits the guides of the master chain", () => {
    const s = scene(false);
    expect(effectiveGuides(s, s.pages[3])).toEqual([{ vertical: true, position: 30 }, { vertical: false, position: 90 }]);
    expect(effectiveGuides(s, s.pages[1])).toEqual([]);
  });
});

describe("facing-page geometry and validation", () => {
  const page: PageLite = { id: "p", name: "p", width: 400, height: 600, marginLeft: 60, marginRight: 20, marginTop: 30, marginBottom: 30, columns: 2, gutter: 20 };
  it("swaps the margins on a left-hand page", () => {
    expect(pageTextArea(page)).toMatchObject({ x: 60, width: 320 });
    expect(pageTextArea(page, true)).toMatchObject({ x: 20, width: 320 });
    expect(pageColumns(page, true)[0].x).toBe(20);
  });
  it("adds page guides to the snap targets", () => {
    const boxes = pageGuideBoxes({ id: "p", name: "p", width: 100, height: 100 }, undefined, { guides: [{ vertical: true, position: 40 }, { vertical: false, position: 70 }] });
    expect(boxes).toContainEqual({ x: 40, y: 0, width: 0, height: 100 });
    expect(boxes).toContainEqual({ x: 0, y: 70, width: 100, height: 0 });
  });
  it("rejects what Go rejects", () => {
    const bad: Partial<PageLite>[] = [{ numberStyle: "x" as never }, { slug: -1 }, { numberStart: 1e6 }, { hiddenMasterItems: [""] }, { guides: [{ vertical: true, position: 1e12 }] }];
    for (const b of bad) expect(isValidPageSetup(b), JSON.stringify(b)).toBe(false);
    expect(isValidPageSetup({ numberStyle: "i", numberStart: 3, slug: 9, guides: [{ vertical: true, position: -4 }] })).toBe(true);
  });
});

describe("movePage", () => {
  it("moves a page and its inverse moves it back", () => {
    const s = withPages([{ id: "a", name: "a" }, { id: "b", name: "b" }, { id: "c", name: "c" }]);
    const mv = op({ case: "movePage", value: { id: "c", index: 0 } } as Op["kind"]);
    const next = applyOp(s, mv);
    expect(next.pages.map((p) => p.id)).toEqual(["c", "a", "b"]);
    const inv = invertOp(s, mv)!;
    expect(applyOp(next, inv[0]).pages.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
  it("rejects a missing page or an index out of range, with no inverse", () => {
    const s = withPages([{ id: "a", name: "a" }, { id: "b", name: "b" }]);
    for (const k of [{ id: "zz", index: 0 }, { id: "a", index: 2 }]) {
      const o = op({ case: "movePage", value: k } as Op["kind"]);
      expect(applyOp(s, o)).toBe(s);
      expect(invertOp(s, o)).toBeNull();
    }
  });
});

describe("facing pages setting", () => {
  it("round-trips through setDocSettings and its inverse", () => {
    const s = withPages([{ id: "a", name: "a" }]);
    const o = op({ case: "setDocSettings", value: { settings: { vertical: "publishing", baselineIncrement: 0, baselineStart: 0, facingPages: true } } } as Op["kind"]);
    const next = applyOp(s, o);
    expect(next.settings).toEqual({ vertical: "publishing", facingPages: true });
    expect(applyOp(next, invertOp(s, o)![0]).settings).toBeUndefined();
  });
});
