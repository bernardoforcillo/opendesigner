import { describe, it, expect } from "vitest";
import { connectSource, isPageRoot, isScreenNode, screenName, screenOf, topLevelScreens } from "./screens";
import { baseScene, child, frame } from "./testSupport";
import { nodesOf } from "../store/nodeMap";

describe("screenOf", () => {
  const s = baseScene();

  it("a top-level frame is its own screen", () => {
    expect(screenOf(s, "A")?.id).toBe("A");
  });

  it("an element inside the frame climbs up to its screen", () => {
    expect(screenOf(s, "btn")?.id).toBe("A");
  });

  it("deep nesting: climbs up to the page's child", () => {
    const deep = {
      ...s,
      nodes: nodesOf({
        A: frame("A", 0),
        inner: frame("inner", 0, 0, { parentId: "A" }),
        leaf: child("leaf", "inner", 0, 0),
      }),
    };
    expect(screenOf(deep, "leaf")?.id).toBe("A");
  });

  it("nonexistent id or malformed cycle: null (no infinite loop)", () => {
    expect(screenOf(s, "ghost")).toBeNull();
    const cyc = { ...s, nodes: nodesOf({ a: child("a", "b", 0, 0), b: child("b", "a", 0, 0) }) };
    expect(screenOf(cyc, "a")).toBeNull();
  });

  it("isPageRoot: only the direct children of a page", () => {
    expect(isPageRoot(s, s.nodes.at("A"))).toBe(true);
    expect(isPageRoot(s, s.nodes.at("btn"))).toBe(false);
  });
});

describe("topLevelScreens", () => {
  it("lists the top-level frames of the page, not the loose rectangles nor the children", () => {
    const ids = topLevelScreens(baseScene(), "page1").map((n) => n.id);
    expect(ids.sort()).toEqual(["A", "B", "C"]);
  });

  it("without a current page it falls back to the first", () => {
    expect(topLevelScreens(baseScene(), null)).toHaveLength(3);
  });

  it("isScreenNode: only frames", () => {
    expect(isScreenNode(baseScene().nodes.at("A"))).toBe(true);
    expect(isScreenNode(baseScene().nodes.at("loose"))).toBe(false);
    expect(isScreenNode(null)).toBe(false);
  });
});

describe("connectSource", () => {
  const s = baseScene();

  it("starting from a frame: no hotspot", () => {
    expect(connectSource(s, "A")).toEqual({ screenId: "A", elementId: "" });
  });

  it("starting from an element: it becomes the hotspot, fromId is its screen", () => {
    expect(connectSource(s, "btn")).toEqual({ screenId: "A", elementId: "btn" });
  });

  it("a loose rectangle (not inside a screen) is not a starting point", () => {
    expect(connectSource(s, "loose")).toBeNull();
    expect(connectSource(s, "ghost")).toBeNull();
  });
});

describe("screenName", () => {
  it("name, fallback for empty, fallback for the deleted one", () => {
    const s = baseScene();
    expect(screenName(s, "A")).toBe("A");
    expect(screenName({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), name: "  " }) }, "A")).toBe("Untitled");
    expect(screenName(s, "ghost")).toBe("(screen deleted)");
  });
});
