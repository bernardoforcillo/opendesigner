import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "../store/applyOp";
import { emptyScene, toPbFills, type SceneState } from "../store/types";
import { childrenOf } from "../store/tree";
import { orderKeyBetween } from "../store/orderKey";
import { makeCreateNodeOp, uuid } from "./ops";
import { changeObjectsOps, clipWithShapeOps, exportSnippet, findObjects, fitOps, gapOps, placeSnippetOps, qrOps, releaseClipOps, stepRepeatOps } from "./objectTools";

const TOP = orderKeyBetween(orderKeyBetween(orderKeyBetween(null, null), null), null);
const run = (s: SceneState, ops: Op[]) => ops.reduce(applyOp, s);

function rectOp(id: string, x: number, y: number, w: number, h: number, rgb = { r: 1, g: 0, b: 0 }, parentId = "page1", key = orderKeyBetween(null, null), name = "Rect"): Op {
  return makeCreateNodeOp(create(NodeSchema, { id, parentId, orderKey: key, name, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0, fills: toPbFills([{ ...rgb, a: 1 }]), shape: { case: "rect", value: {} } }));
}
function scene3(): SceneState {
  let k = orderKeyBetween(null, null);
  const ops: Op[] = [];
  for (const [id, x] of [["a", 0], ["b", 50], ["c", 300]] as const) { ops.push(rectOp(id, x, 10, 40, 20, undefined, "page1", k)); k = orderKeyBetween(k, null); }
  return run(emptyScene("d", "d"), ops);
}

describe("step and repeat", () => {
  it("makes count copies, each one step further, in the same parent", () => {
    const s = scene3();
    const made = stepRepeatOps(s, ["a"], { count: 3, dx: 100, dy: 5 });
    expect(typeof made).not.toBe("string");
    const after = run(s, (made as { ops: Op[] }).ops);
    const copies = (made as { ids: string[] }).ids.map((id) => after.nodes.get(id)!);
    expect(copies.map((c) => [c.x, c.y])).toEqual([[100, 15], [200, 20], [300, 25]]);
    expect(copies.every((c) => c.parentId === "page1" && c.width === 40)).toBe(true);
    expect(new Set(copies.map((c) => c.orderKey)).size).toBe(3);
  });
  it("copies a group with its children", () => {
    const s = scene3();
    const g = run(s, [makeCreateNodeOp(create(NodeSchema, { id: "g", parentId: "page1", orderKey: TOP, name: "G", visible: true, opacity: 1, x: 0, y: 0, width: 0, height: 0, fills: [], shape: { case: "group", value: {} } })), rectOp("in", 5, 5, 10, 10, undefined, "g")]);
    const made = stepRepeatOps(g, ["g"], { count: 2, dx: 0, dy: 50 }) as { ops: Op[]; ids: string[] };
    const after = run(g, made.ops);
    expect(childrenOf(after, made.ids[0]!)).toHaveLength(1);
    expect(childrenOf(after, made.ids[1]!)).toHaveLength(1);
  });
  it("refuses nonsense", () => {
    const s = scene3();
    expect(stepRepeatOps(s, ["a"], { count: 0, dx: 1, dy: 0 })).toMatch(/count/);
    expect(stepRepeatOps(s, ["a"], { count: 201, dx: 1, dy: 0 })).toMatch(/count/);
    expect(stepRepeatOps(s, ["a"], { count: 2, dx: 0, dy: 0 })).toMatch(/zero/);
    expect(stepRepeatOps(s, ["nope"], { count: 2, dx: 1, dy: 0 })).toMatch(/no such/);
  });
});

describe("gap tool", () => {
  it("sets the space between neighbours, keeping the first, whatever the selection order", () => {
    const s = scene3();
    const ops = gapOps(s, ["c", "a", "b"], "x", 10) as Op[];
    const after = run(s, ops);
    expect([after.nodes.get("a")!.x, after.nodes.get("b")!.x, after.nodes.get("c")!.x]).toEqual([0, 50, 100]);
  });
  it("needs two nodes and a number", () => {
    const s = scene3();
    expect(gapOps(s, ["a"], "x", 1)).toMatch(/two/);
    expect(gapOps(s, ["a", "b"], "x", NaN)).toMatch(/number/);
  });
});

describe("frame fitting", () => {
  it("sets how an image fill covers its frame", () => {
    const s0 = scene3();
    const imgFill = run(s0, [makeCreateNodeOp(create(NodeSchema, { id: "f", parentId: "page1", orderKey: TOP, name: "F", visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 50, fills: toPbFills([{ r: 0.8, g: 0.8, b: 0.8, a: 1, image: { assetHash: "a".repeat(64), mode: "fill" } }]), shape: { case: "rect", value: {} } }))]);
    const after = run(imgFill, fitOps(imgFill, "f", "fit") as Op[]);
    expect(after.nodes.get("f")!.fills[0]!.image!.mode).toBe("fit");
    expect(fitOps(s0, "a", "fill")).toMatch(/no image fill/);
  });
  it("resizes an image node to its natural proportions", () => {
    const s = run(scene3(), [makeCreateNodeOp(create(NodeSchema, { id: "i", parentId: "page1", orderKey: TOP, name: "I", visible: true, opacity: 1, x: 0, y: 0, width: 200, height: 200, shape: { case: "image", value: { assetHash: "h", pixelWidth: 400, pixelHeight: 100 } } }))]);
    expect(run(s, fitOps(s, "i", "frame-to-content") as Op[]).nodes.get("i")!.height).toBe(50);
    expect(fitOps(s, "a", "frame-to-content")).toMatch(/image node/);
  });
});

describe("clipping path", () => {
  it("groups the shape under its content as a mask, and releases it", () => {
    const s = scene3();
    const made = clipWithShapeOps(s, "a", ["b"]) as { ops: Op[]; groupId: string };
    const after = run(s, made.ops);
    const kids = childrenOf(after, made.groupId);
    expect(kids.map((k) => k.id)).toEqual(["a", "b"]);
    expect(after.nodes.get("a")!.isMask).toBe(true);
    const released = run(after, releaseClipOps(after, "a") as Op[]);
    expect(released.nodes.get("a")!.isMask).toBeFalsy();
    expect(releaseClipOps(released, "a")).toMatch(/not a clipping/);
  });
  it("refuses a text as the shape and an empty content", () => {
    const s = scene3();
    expect(clipWithShapeOps(s, "a", [])).toMatch(/nothing to clip/);
    expect(clipWithShapeOps(s, "missing", ["a"])).toMatch(/must be/);
  });
});

describe("QR code", () => {
  it("draws a light square and one dark vector inside a group", () => {
    const s = scene3();
    const made = qrOps(s, { text: "https://example.org", x: 10, y: 20, size: 100, parentId: "page1" }) as { ops: Op[]; groupId: string };
    const after = run(s, made.ops);
    const kids = childrenOf(after, made.groupId);
    expect(kids.map((k) => k.kind)).toEqual(["rect", "vector"]);
    expect(kids[0]).toMatchObject({ x: 10, y: 20, width: 100, height: 100 });
    // the dark modules stay inside the square, inside the quiet zone
    const v = kids[1]!;
    expect(v.x).toBeGreaterThanOrEqual(10);
    expect(v.x + v.width).toBeLessThanOrEqual(110);
  });
  it("says when the text is too long", () => {
    expect(qrOps(scene3(), { text: "x".repeat(400), x: 0, y: 0, parentId: "page1" })).toMatch(/too long/);
  });
});

describe("find and change objects", () => {
  it("finds by kind, name and colour, and recolours only that colour", () => {
    let s = scene3();
    s = run(s, [rectOp("blue", 0, 0, 5, 5, { r: 0, g: 0, b: 1 }, "page1", TOP, "Logo blue")]);
    expect((findObjects(s, { fill: { r: 1, g: 0, b: 0 } }) as { id: string }[]).map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    const hits = findObjects(s, { name: "^logo", kind: "rect" }) as { id: string }[];
    expect(hits.map((n) => n.id)).toEqual(["blue"]);
    const all = findObjects(s, { fill: { r: 1, g: 0, b: 0 } }) as never[];
    const after = run(s, changeObjectsOps(s, all, { fill: { r: 0, g: 1, b: 0, a: 1 } }, { fill: { r: 1, g: 0, b: 0 } }));
    expect(after.nodes.get("a")!.fills[0]).toMatchObject({ r: 0, g: 1, b: 0 });
    expect(after.nodes.get("blue")!.fills[0]).toMatchObject({ r: 0, g: 0, b: 1 });
  });
  it("needs a criterion and a valid pattern", () => {
    expect(findObjects(scene3(), {})).toMatch(/at least one/);
    expect(findObjects(scene3(), { name: "(" })).toMatch(/regular expression/);
  });
});

describe("snippets", () => {
  it("exports a group and places it elsewhere with its children", () => {
    const base = scene3();
    const s = run(base, [makeCreateNodeOp(create(NodeSchema, { id: "g", parentId: "page1", orderKey: TOP, name: "G", visible: true, opacity: 1, x: 20, y: 30, width: 0, height: 0, fills: [], shape: { case: "group", value: {} } })), rectOp("in", 0, 0, 10, 10, undefined, "g")]);
    const text = exportSnippet(s, ["g"])!;
    const placed = placeSnippetOps(emptyScene("d2", "d2"), text, 500, 600, "page1") as { ops: Op[]; ids: string[] };
    if (typeof placed === "string") throw new Error(placed);
    const after = run(emptyScene("d2", "d2"), placed.ops);
    expect(after.nodes.get(placed.ids[0]!)).toMatchObject({ x: 500, y: 600, kind: "group" });
    expect(childrenOf(after, placed.ids[0]!)).toHaveLength(1);
    expect(placeSnippetOps(s, "nope", 0, 0, "page1")).toMatch(/not an opendesigner/);
    expect(uuid()).toBeTruthy();
  });
});
