import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { invertOp } from "@/store/history";
import { deriveMasters, deletePageAllowed, masterCopyId, masterFieldsValid, updatePageAllowed } from "@/store/masters";
import { resolveScene } from "@/store/variables";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";
import { hitTest as pickAt, sortedVisible } from "@/renderer/canvasRenderer";

const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

const op = (kind: Op["kind"]): Op => create(OpSchema, { opId: "o", docId: "d", kind });

// page1, page2 apply master m1; page3 has none. m1 holds a header band and a page-number text.
function book(): SceneState {
  let s: SceneState = {
    ...emptyScene("d", "Book"),
    pages: [
      { id: "page1", name: "Page 1", masterId: "m1" },
      { id: "m1", name: "A-Master", isMaster: true },
      { id: "page2", name: "Page 2", masterId: "m1" },
      { id: "page3", name: "Page 3" },
    ],
  };
  for (const n of [
    node({ id: "band", parentId: "m1", width: 400, height: 20, orderKey: "a0" }),
    node({ id: "num", parentId: "m1", kind: "text", orderKey: "a1", text: { content: "Page <#>", style: { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 0, align: "left" } } }),
    node({ id: "body", parentId: "page1", orderKey: "a0", x: 100, y: 100 }),
  ]) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}

describe("deriveMasters", () => {
  it("returns the scene itself when no page applies a master", () => {
    const s = emptyScene("d", "x");
    expect(deriveMasters(s)).toBe(s);
  });

  it("copies the master's nodes onto each page that applies it, flagged and behind the page's own", () => {
    const out = deriveMasters(book());
    const band = out.nodes.get(masterCopyId("page1", "band"))!;
    expect(band).toMatchObject({ parentId: "page1", fromMaster: true, width: 400 });
    expect(out.nodes.get(masterCopyId("page2", "band"))).toBeDefined();
    expect(out.nodes.get(masterCopyId("page3", "band"))).toBeUndefined();
    // Behind: sorted by order key, the copies come before page1's own node.
    const order = sortedVisible(out).filter((n) => n.parentId === "page1").map((n) => n.id);
    expect(order.indexOf(band.id)).toBeLessThan(order.indexOf("body"));
    // The master's own nodes and the real document are untouched.
    expect(out.nodes.get("band")!.fromMaster).toBeUndefined();
    expect(book().nodes.get(band.id)).toBeUndefined();
  });

  it("writes each page's number (masters do not count) in place of <#>", () => {
    const out = deriveMasters(book());
    expect(out.nodes.get(masterCopyId("page1", "num"))!.text!.content).toBe("Page 1");
    expect(out.nodes.get(masterCopyId("page2", "num"))!.text!.content).toBe("Page 2");
    expect(out.nodes.get("num")!.text!.content).toBe("Page <#>"); // the master shows the raw token
  });

  it("is part of resolveScene and cached per scene", () => {
    const s = book();
    expect(resolveScene(s).nodes.get(masterCopyId("page1", "band"))).toBeDefined();
    expect(deriveMasters(s)).toBe(deriveMasters(s));
  });

  it("cannot be picked from the page that shows it", () => {
    const out = deriveMasters(book());
    // (10, 10) is inside the master band only.
    expect(pickAt(out, 10, 10, 1, "page1")).toBeNull();
    expect(pickAt(out, 110, 110, 1, "page1")).toBe("body");
  });

  it("keeps the master's nested nodes under their copied parents", () => {
    let s = book();
    s = { ...s, nodes: s.nodes.set("grp", node({ id: "grp", parentId: "m1", kind: "group", orderKey: "a2" })).set("kid", node({ id: "kid", parentId: "grp" })) };
    const out = deriveMasters(s);
    expect(out.nodes.get(masterCopyId("page1", "kid"))!.parentId).toBe(masterCopyId("page1", "grp"));
  });
});

describe("page ops with masters", () => {
  const upd = (page: object) => op({ case: "updatePage", value: { page } } as Op["kind"]);

  it("validates master fields like the Go core", () => {
    const pages = book().pages;
    expect(masterFieldsValid(pages, { id: "x", name: "x", masterId: "m1" })).toBe(true);
    expect(masterFieldsValid(pages, { id: "x", name: "x", masterId: "page2" })).toBe(false);
    expect(masterFieldsValid(pages, { id: "x", name: "x", isMaster: true, masterId: "m1" })).toBe(true);
    expect(masterFieldsValid(pages, { id: "m1", name: "x", masterId: "m1" })).toBe(false);
  });

  it("protects a master in use and the last regular page", () => {
    const pages = book().pages;
    expect(deletePageAllowed(pages, "m1")).toBe(false);
    expect(updatePageAllowed(pages, { id: "m1", name: "A-Master" })).toBe(false);
    expect(deletePageAllowed(pages, "page3")).toBe(true);
    const lone = [{ id: "page1", name: "P" }, { id: "m1", name: "M", isMaster: true }];
    expect(deletePageAllowed(lone, "page1")).toBe(false);
    expect(updatePageAllowed(lone, { id: "page1", name: "P", isMaster: true })).toBe(false);
  });

  it("updatePage applies a master, and its inverse puts the previous page back", () => {
    const s = book();
    const o = upd({ id: "page3", name: "Page 3", masterId: "m1" });
    const next = applyOp(s, o);
    expect(next.pages.find((p) => p.id === "page3")).toEqual({ id: "page3", name: "Page 3", masterId: "m1" });
    const inv = invertOp(s, o)!;
    expect(inv).toHaveLength(1);
    const back = applyOp(next, inv[0]);
    expect(back.pages).toEqual(s.pages);
  });

  it("rejects what Go rejects, with no inverse", () => {
    const s = book();
    for (const o of [
      upd({ id: "page3", name: "x", masterId: "page2" }),
      upd({ id: "m1", name: "A-Master" }),
      op({ case: "deletePage", value: { id: "m1" } } as Op["kind"]),
      op({ case: "createPage", value: { page: { id: "z", name: "z", masterId: "z" } } } as Op["kind"]),
    ]) {
      expect(applyOp(s, o)).toBe(s);
      expect(invertOp(s, o)).toBeNull();
    }
  });

  it("undoes the deletion of a master page with its flags", () => {
    let s = book();
    s = applyOp(applyOp(s, upd({ id: "page1", name: "Page 1" })), upd({ id: "page2", name: "Page 2" }));
    const del = op({ case: "deletePage", value: { id: "m1" } } as Op["kind"]);
    const inv = invertOp(s, del)!;
    let after = applyOp(s, del);
    expect(after.pages.some((p) => p.id === "m1")).toBe(false);
    for (const i of inv) after = applyOp(after, i);
    expect(after.pages.find((p) => p.id === "m1")).toEqual({ id: "m1", name: "A-Master", isMaster: true });
    expect(after.nodes.get("band")).toBeDefined();
  });
});
