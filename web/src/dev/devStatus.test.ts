import { describe, it, expect } from "vitest";
import { baseScene } from "../flow/testSupport";
import { annotationsInside, annotationsOf, categoryColor, readyFrames } from "../store/devMode";
import { applyOp } from "../store/applyOp";
import type { SceneState } from "../store/types";
import { annotateOps, deleteAnnotationOps, devFrameOf, groupChanges, humanProperty, markReadyOps, unmarkOps } from "./devStatus";

const run = (scene: SceneState, ops: ReturnType<typeof markReadyOps>) => ops.reduce(applyOp, scene);

describe("devFrameOf", () => {
  const scene = baseScene();
  it("is the selected frame, or the nearest frame around the selected layer", () => {
    expect(devFrameOf(scene, ["A"])).toBe("A");
    expect(devFrameOf(scene, ["btn"])).toBe("A");
  });
  it("is null with no selection or outside every frame", () => {
    expect(devFrameOf(scene, [])).toBeNull();
    expect(devFrameOf(scene, ["loose"])).toBeNull();
    expect(devFrameOf(scene, ["nope"])).toBeNull();
  });
});

describe("ready for dev ops", () => {
  it("marking keeps the mark and trims the note; the same op on a non-frame changes nothing", () => {
    const marked = run(baseScene(), markReadyOps("A", "  go  ", "Ana", 100));
    expect(marked.dev?.ready.A).toEqual({ nodeId: "A", note: "go", markedBy: "Ana", markedAt: 100 });
    expect(run(baseScene(), markReadyOps("btn", "", "Ana", 1)).dev).toBeUndefined();
  });

  it("marking again replaces the mark; unmarking removes it and an unmarked frame has nothing to unmark", () => {
    let s = run(baseScene(), markReadyOps("A", "", "Ana", 100));
    s = run(s, markReadyOps("A", "again", "Bo", 200));
    expect(s.dev?.ready.A.markedBy).toBe("Bo");
    expect(unmarkOps(baseScene(), "A")).toEqual([]);
    s = run(s, unmarkOps(s, "A"));
    expect(s.dev?.ready).toEqual({});
  });

  it("lists the ready frames oldest first", () => {
    let s = run(baseScene(), markReadyOps("B", "", "x", 5));
    s = run(s, markReadyOps("A", "", "x", 9));
    s = run(s, markReadyOps("C", "", "x", 1));
    expect(readyFrames(s).map((r) => r.nodeId)).toEqual(["C", "B", "A"]);
  });
});

describe("annotations", () => {
  it("are validated like the server: category, text, node", () => {
    const s = baseScene();
    expect(annotateOps("btn", "interaction", "  Opens the cart ", "Ana", 1, "a1")).toHaveLength(1);
    expect(annotateOps("btn", "interaction", "   ", "Ana", 1, "a1")).toEqual([]);
    expect(run(s, annotateOps("btn", "loud", "x", "Ana", 1, "a1")).dev).toBeUndefined();
    expect(run(s, annotateOps("ghost", "note", "x", "Ana", 1, "a1")).dev).toBeUndefined();
    expect(run(s, annotateOps("btn", "note", "x".repeat(2001), "Ana", 1, "a1")).dev).toBeUndefined();
  });

  it("belong to their node, oldest first; a frame's list includes what is inside it", () => {
    let s = run(baseScene(), annotateOps("btn", "interaction", "second", "Ana", 20, "b"));
    s = run(s, annotateOps("btn", "content", "first", "Ana", 10, "a"));
    s = run(s, annotateOps("A", "accessibility", "frame", "Ana", 5, "c"));
    s = run(s, annotateOps("B", "note", "elsewhere", "Ana", 1, "d"));
    expect(annotationsOf(s, "btn").map((a) => a.text)).toEqual(["first", "second"]);
    expect(annotationsInside(s, "A").map((a) => a.id)).toEqual(["c", "a", "b"]);
    expect(annotationsInside(baseScene(), "A")).toEqual([]);
  });

  it("deleting removes one; deleting an unknown id sends nothing", () => {
    let s = run(baseScene(), annotateOps("btn", "note", "x", "Ana", 1, "a"));
    expect(deleteAnnotationOps(s, "zzz")).toEqual([]);
    s = run(s, deleteAnnotationOps(s, "a"));
    expect(s.dev?.annotations).toEqual({});
  });

  it("have a colour per category", () => {
    expect(categoryColor("interaction")).toBe("#3b82f6");
    expect(categoryColor("unknown")).toBe("#8a8f98");
  });
});

describe("Compare changes: presentation", () => {
  it("groups the rows by layer in report order and leaves added / removed layers without rows", () => {
    const rows = [
      { nodeId: "a", nodeName: "Buy", kind: "changed" as const, property: "width", before: "1", after: "2" },
      { nodeId: "a", nodeName: "Buy", kind: "changed" as const, property: "fills[0]", before: "x", after: "y" },
      { nodeId: "b", nodeName: "Badge", kind: "added" as const, property: "", before: "", after: "" },
    ];
    const g = groupChanges(rows);
    expect(g.map((x) => [x.nodeId, x.kind, x.rows.length])).toEqual([["a", "changed", 2], ["b", "added", 0]]);
  });

  it("reads property paths as words", () => {
    expect(humanProperty("corner_radius")).toBe("Corner radius");
    expect(humanProperty("fills[0]")).toBe("Fill 1");
    expect(humanProperty("effects[2]")).toBe("Effect 3");
    expect(humanProperty("text.font_size")).toBe("Text font size");
    expect(humanProperty("meta.status")).toBe("Meta status");
    expect(humanProperty("width")).toBe("Width");
  });
});
