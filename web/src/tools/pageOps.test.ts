import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { deriveMasters, masterCopyId } from "../store/masters";
import { emptyScene, type NodeLite, type SceneState } from "../store/types";
import { childrenOf } from "../store/tree";
import { detachMasterOps, duplicatePageOps, masterItemAt, movePageBy, overrideMasterItemOps } from "./pageOps";

const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const run = (s: SceneState, ops: ReturnType<typeof duplicatePageOps>) => ops.reduce(applyOp, s);

function book(): SceneState {
  let s: SceneState = {
    ...emptyScene("d", "Book"),
    pages: [{ id: "page1", name: "One", width: 400, height: 600, masterId: "m1", guides: [{ vertical: true, position: 20 }] }, { id: "page2", name: "Two" }, { id: "m1", name: "A-Master", isMaster: true }],
  };
  for (const n of [
    node({ id: "a", orderKey: "a0", meta: { "text.next": "b" } }), node({ id: "b", orderKey: "a1" }),
    node({ id: "grp", orderKey: "a2", kind: "group" }), node({ id: "kid", parentId: "grp" }),
    node({ id: "logo", parentId: "m1", width: 80, height: 30 }),
  ]) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}

describe("page gestures", () => {
  it("duplicates a page right after the original, with new ids and its thread inside the copy", () => {
    const s = book();
    const out = run(s, duplicatePageOps(s, "page1", "copy"));
    expect(out.pages.map((p) => p.id)).toEqual(["page1", "copy", "page2", "m1"]);
    expect(out.pages[1]).toMatchObject({ name: "One copy", width: 400, masterId: "m1", guides: [{ vertical: true, position: 20 }] });
    const kids = childrenOf(out, "copy");
    expect(kids.map((n) => n.name)).toEqual(["a", "b", "grp"]);
    expect(kids.every((n) => !["a", "b", "grp"].includes(n.id))).toBe(true);
    expect(kids[0].meta?.["text.next"]).toBe(kids[1].id);
    expect(out.nodes.size).toBe(s.nodes.size + 4); // a, b, grp and kid were copied
  });

  it("drops a thread link that leaves the page", () => {
    let s = book();
    s = { ...s, nodes: s.nodes.set("a", { ...s.nodes.get("a")!, meta: { "text.next": "elsewhere" } }) };
    const out = run(s, duplicatePageOps(s, "page1", "copy"));
    expect(childrenOf(out, "copy")[0].meta?.["text.next"]).toBeUndefined();
  });

  it("moves a page, and not past the ends", () => {
    const s = book();
    expect(run(s, movePageBy(s.pages, "page2", -1)).pages.map((p) => p.id)).toEqual(["page2", "page1", "m1"]);
    expect(movePageBy(s.pages, "page1", -1)).toEqual([]);
  });

  it("detaches pages and masters from a master before it goes", () => {
    let s = book();
    s = { ...s, pages: [...s.pages, { id: "m2", name: "B", isMaster: true, masterId: "m1" }, { id: "page3", name: "3", leftMasterId: "m1" }] };
    const out = run(s, detachMasterOps(s.pages, "m1"));
    expect(out.pages.every((p) => p.masterId !== "m1" && p.leftMasterId !== "m1")).toBe(true);
  });

  it("overrides a master item: a page copy appears and the master's is hidden there", () => {
    const s = book();
    const ops = overrideMasterItemOps(s, s.pages[0], "logo");
    const out = run(s, ops);
    expect(out.pages[0].hiddenMasterItems).toEqual(["logo"]);
    const own = childrenOf(out, "page1").find((n) => n.name === "logo")!;
    expect(own.id).not.toBe("logo");
    expect(own.fromMaster).toBeUndefined();
    const derived = deriveMasters(out);
    expect(derived.nodes.get(masterCopyId("page1", "logo"))).toBeUndefined();
    expect(derived.nodes.get("logo")).toBeDefined(); // the master keeps its own
  });

  it("finds the master item under a point", () => {
    const d = deriveMasters(book());
    expect(masterItemAt(d, "page1", 10, 10, 1)).toBe("logo");
    expect(masterItemAt(d, "page1", 300, 300, 1)).toBeNull();
    expect(masterItemAt(d, "page2", 10, 10, 1)).toBeNull();
  });
});
