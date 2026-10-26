import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { invertOp } from "@/store/history";
import { isValidDocSettings, isValidPageSetup, pageColumns, pageTextArea, setupOf, verticalOf } from "@/store/docSettings";
import { emptyScene, type SceneState } from "@/store/types";

const op = (kind: Op["kind"]): Op => create(OpSchema, { opId: "o", docId: "d", kind });
const settings = (s: Partial<{ vertical: string; baselineIncrement: number; baselineStart: number; presentDevice: string }>) =>
  op({ case: "setDocSettings", value: { settings: { vertical: "", baselineIncrement: 0, baselineStart: 0, ...s } } } as Op["kind"]);
const createPage = (page: object) => op({ case: "createPage", value: { page } } as Op["kind"]);
const updatePage = (page: object) => op({ case: "updatePage", value: { page } } as Op["kind"]);

describe("document settings", () => {
  it("defaults to the product vertical and stores nothing for defaults", () => {
    const s = emptyScene("d", "d");
    expect(verticalOf(s)).toBe("product");
    expect(applyOp(s, settings({ vertical: "" })).settings).toBeUndefined();
  });

  it("sets the vertical and the baseline grid as an absolute upsert, and undoes it", () => {
    const s = emptyScene("d", "d");
    const o = settings({ vertical: "publishing", baselineIncrement: 14, baselineStart: 36 });
    const next = applyOp(s, o);
    expect(next.settings).toEqual({ vertical: "publishing", baselineIncrement: 14, baselineStart: 36 });
    expect(verticalOf(next)).toBe("publishing");
    // The next op replaces all of it.
    const second = applyOp(next, settings({ vertical: "design" }));
    expect(second.settings).toEqual({ vertical: "design" });
    const back = applyOp(next, invertOp(next, settings({ vertical: "design" }))![0]);
    expect(back.settings).toEqual(next.settings);
    expect(applyOp(next, invertOp(s, o)![0]).settings).toBeUndefined();
  });

  it("keeps the Present device frame: generic is stored as nothing, an unknown device is rejected, undo restores it", () => {
    const s = emptyScene("d", "d");
    expect(applyOp(s, settings({ presentDevice: "generic" })).settings).toBeUndefined();
    const phone = settings({ presentDevice: "phone" });
    const next = applyOp(s, phone);
    expect(next.settings).toEqual({ presentDevice: "phone" });
    // A later write of other fields in the same upsert keeps the device only if it carries it (absolute upsert).
    expect(applyOp(next, settings({ vertical: "design" })).settings).toEqual({ vertical: "design" });
    expect(applyOp(next, invertOp(s, phone)![0]).settings).toBeUndefined();
    const back = applyOp(next, invertOp(next, settings({ presentDevice: "tablet" }))![0]);
    expect(back.settings).toEqual({ presentDevice: "phone" });
    expect(applyOp(s, settings({ presentDevice: "watch" }))).toBe(s);
    expect(invertOp(s, settings({ presentDevice: "watch" }))).toBeNull();
  });

  it("rejects what the Go core rejects, with no inverse", () => {
    const s = emptyScene("d", "d");
    for (const bad of [{ vertical: "cinema" }, { baselineIncrement: -1 }, { baselineIncrement: 5000 }, { baselineStart: -3 }, { baselineIncrement: NaN }]) {
      expect(applyOp(s, settings(bad))).toBe(s);
      expect(invertOp(s, settings(bad))).toBeNull();
    }
    expect(isValidDocSettings(undefined)).toBe(false);
  });
});

describe("page setup", () => {
  const a5 = { id: "p2", name: "A5", width: 420, height: 595, marginTop: 40, marginBottom: 50, marginLeft: 36, marginRight: 36, columns: 2, gutter: 18, bleed: 9 };

  it("is stored by createPage and replaced by updatePage, and the inverse restores it", () => {
    const s = emptyScene("d", "d");
    const made = applyOp(s, createPage(a5));
    expect(made.pages[1]).toMatchObject({ width: 420, height: 595, columns: 2, gutter: 18, bleed: 9, marginLeft: 36 });
    const upd = updatePage({ id: "p2", name: "A5", width: 300, height: 400 });
    const next = applyOp(made, upd);
    expect(next.pages[1]).toEqual({ id: "p2", name: "A5", width: 300, height: 400 });
    expect(applyOp(next, invertOp(made, upd)![0]).pages).toEqual(made.pages);
    // Deleting the page and undoing brings the setup back.
    const del = op({ case: "deletePage", value: { id: "p2" } } as Op["kind"]);
    const gone = applyOp(made, del);
    let restored: SceneState = gone;
    for (const i of invertOp(made, del)!) restored = applyOp(restored, i);
    expect(restored.pages[1]).toEqual(made.pages[1]);
  });

  it("validates like the Go core", () => {
    const s = emptyScene("d", "d");
    for (const bad of [
      { width: -5 }, { width: 0.5 }, { height: 1e9 }, { marginTop: -1 },
      { width: 100, height: 200, marginLeft: 60, marginRight: 40 },
      { width: 100, height: 100, marginTop: 50, marginBottom: 50 },
      { width: 1000, height: 100, columns: 25 },
      { width: 100, height: 100, columns: 4, gutter: 40 },
      { bleed: 5000 },
    ]) {
      expect(applyOp(s, createPage({ id: "x", name: "x", ...bad }))).toBe(s);
      expect(invertOp(s, createPage({ id: "x", name: "x", ...bad }))).toBeNull();
    }
    // An unbounded page may carry margins and columns: they are guides at the origin.
    expect(isValidPageSetup({ marginLeft: 10, columns: 3, gutter: 5 })).toBe(true);
    expect(isValidPageSetup({ width: 100, columns: 2.5 })).toBe(false);
  });

  it("works out the text area and the columns", () => {
    const p = { id: "p", name: "p", width: 400, height: 600, marginTop: 50, marginBottom: 50, marginLeft: 40, marginRight: 40, columns: 3, gutter: 10 };
    expect(pageTextArea(p)).toEqual({ x: 40, y: 50, width: 320, height: 500 });
    const cols = pageColumns(p);
    expect(cols).toHaveLength(3);
    expect(cols[0]).toEqual({ x: 40, width: 100 });
    expect(cols[2]).toEqual({ x: 260, width: 100 });
    expect(pageColumns({ id: "p", name: "p", width: 400, height: 600 })).toEqual([]);
    expect(setupOf(p)).toEqual({ width: 400, height: 600, marginTop: 50, marginBottom: 50, marginLeft: 40, marginRight: 40, columns: 3, gutter: 10 });
    expect(setupOf(undefined)).toEqual({});
  });
});

import { baselineLines, MAX_BASELINE_LINES, pageGuideBoxes } from "@/store/docSettings";
import { snapTargets } from "@/selection/snap";

describe("page guides", () => {
  const page = { id: "p", name: "p", width: 400, height: 600, marginTop: 50, marginBottom: 50, marginLeft: 40, marginRight: 40, columns: 2, gutter: 20 };

  it("lists the baseline lines from the start down the sheet", () => {
    expect(baselineLines({ baselineIncrement: 100, baselineStart: 50 }, 600)).toEqual([50, 150, 250, 350, 450, 550]);
    expect(baselineLines(undefined, 600)).toEqual([]);
    expect(baselineLines({ baselineIncrement: 10 }, 0)).toEqual([]);
    expect(baselineLines({ baselineIncrement: 0.5 }, 1e6)).toHaveLength(MAX_BASELINE_LINES);
  });

  it("offers the sheet, margins, columns and baselines as degenerate boxes", () => {
    const boxes = pageGuideBoxes(page, { baselineIncrement: 200, baselineStart: 100 });
    const vertical = boxes.filter((b) => b.width === 0).map((b) => b.x).sort((a, b) => a - b);
    const horizontal = boxes.filter((b) => b.height === 0).map((b) => b.y).sort((a, b) => a - b);
    // Sheet edges 0 and 400, margins 40 and 360, the two columns' edges 40, 190, 210, 360.
    expect(new Set(vertical)).toEqual(new Set([0, 400, 40, 360, 190, 210]));
    // Sheet 0 and 600, margins 50 and 550, baselines 100, 300, 500.
    expect(new Set(horizontal)).toEqual(new Set([0, 600, 50, 550, 100, 300, 500]));
    expect(pageGuideBoxes({ id: "p", name: "p" }, { baselineIncrement: 10 })).toEqual([]);
    expect(pageGuideBoxes(undefined, undefined)).toEqual([]);
  });

  it("makes the guides of the current page snap targets", () => {
    const s = { ...emptyScene("d", "d"), pages: [page, { id: "free", name: "free" }], settings: { baselineIncrement: 200 } };
    const onPage = snapTargets(s, [], "p");
    expect(onPage.some((b) => b.width === 0 && b.x === 190)).toBe(true);
    expect(onPage.some((b) => b.height === 0 && b.y === 200)).toBe(true);
    expect(snapTargets(s, [], "free")).toEqual([]);
  });
});
