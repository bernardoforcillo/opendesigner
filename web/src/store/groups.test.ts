import { describe, it, expect } from "vitest";
import { emptyScene, type NodeLite, type SceneState } from "./types";
import {
  contentWorldBounds,
  enterTargetOf,
  frameOriginOf,
  isGroup,
  selectionTargetOf,
  selectionTargetsOf,
  transformTargetsOf,
} from "./groups";

function node(id: string, parentId: string, x: number, y: number, extra: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: "a000000", name: id, visible: true, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...extra,
  };
}

// A group IS BORN at (0,0) and with no dimensions of its own: its bounds are
// the union of the children, and its x/y is the translation it contributes to them.
function group(id: string, parentId: string, extra: Partial<NodeLite> = {}): NodeLite {
  return node(id, parentId, 0, 0, { kind: "group", width: 0, height: 0, ...extra });
}

// A FRAME, instead, has its OWN geometry: its box (x/y/width/height) is its own,
// not the union of the children, and -- unlike the group -- it does NOT capture the click
// of the children (artboard convention). `clipsContent` defaults to true.
function frame(id: string, parentId: string, x: number, y: number, extra: Partial<NodeLite> = {}): NodeLite {
  return node(id, parentId, x, y, { kind: "frame", clipsContent: true, ...extra });
}

function scene(nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc1", "Untitled");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

//   page1
//   ├── g  (group, no geometry of its own)
//   │   ├── r1 (10,10 50x50)   -> world (10,10)-(60,60)
//   │   └── r2 (100,0 20x20)   -> mondo (100,0)-(120,20)
//   └── solo (200,200 10x10)
function grouped(): SceneState {
  return scene([
    group("g", "page1", { orderKey: "a000001" }),
    node("r1", "g", 10, 10, { orderKey: "a000001" }),
    node("r2", "g", 100, 0, { orderKey: "a000002", width: 20, height: 20 }),
    node("alone", "page1", 200, 200, { orderKey: "a000002", width: 10, height: 10 }),
  ]);
}

describe("isGroup", () => {
  it("is true only for a node whose shape is a group", () => {
    const s = grouped();
    expect(isGroup(s.nodes.at("g"))).toBe(true);
    expect(isGroup(s.nodes.at("r1"))).toBe(false);
    expect(isGroup(undefined)).toBe(false);
  });
});

describe("contentWorldBounds", () => {
  it("is the node's own world box for anything that is not a group", () => {
    const s = grouped();
    expect(contentWorldBounds(s, s.nodes.at("alone"))).toEqual({ x: 200, y: 200, width: 10, height: 10 });
  });

  it("is the UNION of the children for a group, not its own (empty) box", () => {
    const s = grouped();
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 10, y: 0, width: 110, height: 60 });
  });

  it("follows the group when the group is moved: the children move with it", () => {
    const s = grouped();
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 5, y: 7 });
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 15, y: 7, width: 110, height: 60 });
  });

  it("descends through nested groups", () => {
    const s = scene([
      group("g1", "page1"),
      group("g2", "g1", { x: 100, y: 100 }),
      node("r", "g2", 5, 5, { width: 10, height: 10 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("g1"))).toEqual({ x: 105, y: 105, width: 10, height: 10 });
  });

  it("is null for an empty group: there is nothing to frame", () => {
    const s = scene([group("g", "page1")]);
    expect(contentWorldBounds(s, s.nodes.at("g"))).toBeNull();
  });

  // SEE-vs-SELECT, on the frame side. The renderer skips an invisible node
  // and with it its whole subtree (canvasRenderer.ts:
  // drawSiblings, pickIn, collectIn do `continue` on !visible BEFORE
  // descending). If the union of the children did not do the same, the frame of a
  // group -- and its 8 handles, and the panel's X -- would measure a
  // geometry that is not drawn: a rectangle on empty canvas.
  it("skips an INVISIBLE child: the frame measures only what is drawn", () => {
    const s = grouped();
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    // Only r2: (100,0)-(120,20). With r1 inside it would be {10,0,110,60}.
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 100, y: 0, width: 20, height: 20 });

    // And symmetrically from the other side.
    const s2 = grouped();
    s2.nodes = s2.nodes.set("r2", { ...s2.nodes.at("r2"), visible: false });
    expect(contentWorldBounds(s2, s2.nodes.at("g"))).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it("an invisible GROUP child takes its whole subtree with it, as the renderer's descent does", () => {
    const s = scene([
      group("g", "page1"),
      group("inner", "g", { orderKey: "a000001", visible: false }),
      node("hidden", "inner", 500, 500, { orderKey: "a000001" }),
      node("seen", "g", 10, 10, { orderKey: "a000002" }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it("is null for a group whose children are ALL invisible: it behaves like an empty one", () => {
    const s = grouped();
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    s.nodes = s.nodes.set("r2", { ...s.nodes.at("r2"), visible: false });
    expect(contentWorldBounds(s, s.nodes.at("g"))).toBeNull();
  });
});

// THE FRAME OF A FRAME is ITS box, not the union of the children: a frame is not
// a group, so contentWorldBounds returns its own box (as for a
// rect/ellipse), even if a child overflows well beyond it.
describe("contentWorldBounds for a frame", () => {
  it("is the frame's OWN box, not the union of its children", () => {
    const s = scene([
      frame("f", "page1", 10, 20, { width: 100, height: 80 }),
      // A child that overflows widely: if the frame were treated like a
      // group, the frame would widen until it contained it.
      node("child", "f", 5, 5, { width: 500, height: 500 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("f"))).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it("maps the frame box through an ancestor's translation", () => {
    const s = scene([
      group("g", "page1", { x: 1000, y: 100 }),
      frame("f", "g", 10, 20, { width: 100, height: 80 }),
    ]);
    // f.x/y are written in g's space (translated by 1000,100): the frame's world box
    // lands at (1010,120).
    expect(contentWorldBounds(s, s.nodes.at("f"))).toEqual({ x: 1010, y: 120, width: 100, height: 80 });
  });
});

// SEE-vs-SELECT, on the CLIP side. A frame with clipsContent hides the
// children outside its own box: the renderer does not draw them (drawSiblings), does not
// click them (pickIn) and the marquee does not take them (collectIn). The selection frame
// and its 8 handles read from contentWorldBounds (via
// selectionWorldBounds): if it did NOT clip, an overflowing child would have
// handles drawn -- and GRABBABLE (selectTool.ts::handleUnderPointer uses the
// same box) -- on empty canvas beyond the frame's edge. It is the same
// divergence contentIn already avoids for the invisible children of a group.
describe("contentWorldBounds clipped by an ancestor frame", () => {
  it("clips an overflowing child to the visible region inside the clipping frame", () => {
    const s = scene([
      frame("f", "page1", 10, 20, { width: 100, height: 80 }), // mondo (10,20)-(110,100)
      node("child", "f", 5, 5, { width: 500, height: 500 }), // mondo (15,25)-(515,525)
    ]);
    // Only the part inside the frame: (15,25)-(110,100).
    expect(contentWorldBounds(s, s.nodes.at("child"))).toEqual({ x: 15, y: 25, width: 95, height: 75 });
  });

  it("is null for a child ENTIRELY outside a clipping frame: no frame, no grabbable handles", () => {
    const s = scene([
      frame("f", "page1", 0, 0, { width: 100, height: 100 }),
      node("child", "f", 200, 200, { width: 50, height: 50 }), // world (200,200)-(250,250), outside
    ]);
    expect(contentWorldBounds(s, s.nodes.at("child"))).toBeNull();
  });

  it("does NOT clip when the ancestor frame has clipsContent=false: the child may overflow", () => {
    const s = scene([
      frame("f", "page1", 10, 20, { width: 100, height: 80, clipsContent: false }),
      node("child", "f", 5, 5, { width: 500, height: 500 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("child"))).toEqual({ x: 15, y: 25, width: 500, height: 500 });
  });

  it("composes NESTED clipping frames: each ancestor frame narrows further", () => {
    const s = scene([
      frame("outer", "page1", 0, 0, { width: 100, height: 100 }), // mondo (0,0)-(100,100)
      frame("inner", "outer", 50, 50, { width: 100, height: 100 }), // mondo (50,50)-(150,150)
      node("child", "inner", 10, 10, { width: 200, height: 200 }), // mondo (60,60)-(260,260)
    ]);
    // child ∩ inner = (60,60)-(150,150); then ∩ outer = (60,60)-(100,100).
    expect(contentWorldBounds(s, s.nodes.at("child"))).toEqual({ x: 60, y: 60, width: 40, height: 40 });
  });

  it("a group inside a clipping frame frames only the VISIBLE part of an overflowing child", () => {
    const s = scene([
      frame("f", "page1", 0, 0, { width: 100, height: 100 }),
      group("g", "f", { orderKey: "a000001" }),
      node("r", "g", 80, 80, { orderKey: "a000001", width: 500, height: 500 }), // mondo (80,80)-(580,580)
    ]);
    // r clipped to f (0,0)-(100,100) -> (80,80)-(100,100); the group unions only that.
    expect(contentWorldBounds(s, s.nodes.at("g"))).toEqual({ x: 80, y: 80, width: 20, height: 20 });
  });
});

// THE TOP-LEFT CORNER OF THE FRAME, in the PARENT's space: it is what the
// properties panel calls X/Y. For every node that is not a group it coincides with
// its coordinates; for a group it does NOT -- a group's x/y are the translation
// that contributes to the children, not the point where the frame is seen.
describe("frameOriginOf", () => {
  it("is the node's own x/y for anything that is not a group", () => {
    const s = grouped();
    expect(frameOriginOf(s, s.nodes.at("alone"))).toEqual({ x: 200, y: 200 });
    // Also for a child INSIDE a group: its x/y are already written in the
    // parent's space, which is the space in which this function answers.
    expect(frameOriginOf(s, s.nodes.at("r1"))).toEqual({ x: 10, y: 10 });
  });

  it("is the top-left of the CONTENT for a group, not its (0,0) translation", () => {
    const s = grouped();
    expect(s.nodes.at("g").x).toBe(0);
    expect(s.nodes.at("g").y).toBe(0);
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 10, y: 0 });
  });

  it("moves with the group", () => {
    const s = grouped();
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 5, y: 7 });
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 15, y: 7 });
  });

  it("is expressed in the PARENT's space for a nested group, not in world", () => {
    const s = scene([
      group("g1", "page1", { x: 1000, y: 0 }),
      group("g2", "g1", { x: 100, y: 100 }),
      node("r", "g2", 5, 5, { width: 10, height: 10 }),
    ]);
    expect(contentWorldBounds(s, s.nodes.at("g2"))).toEqual({ x: 1105, y: 105, width: 10, height: 10 });
    // g1's space is the one in which g2's x/y are written: 1105 - 1000.
    expect(frameOriginOf(s, s.nodes.at("g2"))).toEqual({ x: 105, y: 105 });
  });

  it("falls back to the group's own x/y when the group is empty: there is no frame", () => {
    const s = scene([group("g", "page1", { x: 3, y: 4 })]);
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 3, y: 4 });
  });

  // The number the properties panel shows as X (selectors.ts::
  // selectionSummary) and writes to (PropertiesPanel.tsx::positionValueFor).
  // If a hidden child counted, typing an X would bring the HIDDEN child's
  // edge to that number -- and the visible content would end up elsewhere.
  it("is the left edge of the VISIBLE content, not of a hidden child", () => {
    const s = grouped();
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 100, y: 0 });
  });

  it("falls back to the group's own x/y when EVERY child is hidden: same as empty", () => {
    const s = grouped();
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 3, y: 4 });
    s.nodes = s.nodes.set("r1", { ...s.nodes.at("r1"), visible: false });
    s.nodes = s.nodes.set("r2", { ...s.nodes.at("r2"), visible: false });
    expect(frameOriginOf(s, s.nodes.at("g"))).toEqual({ x: 3, y: 4 });
  });
});

// THE SELECTION CONVENTION, the one the user notices first:
// a click selects the OUTERMOST group, a double click enters and selects
// the child.
describe("selectionTargetOf", () => {
  it("a click on a child of a group selects the group", () => {
    const s = grouped();
    expect(selectionTargetOf(s, "r1", [])).toBe("g");
  });

  it("a click on a node outside any group selects that node", () => {
    const s = grouped();
    expect(selectionTargetOf(s, "alone", [])).toBe("alone");
  });

  it("selects the OUTERMOST group when groups are nested", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g1");
  });

  // "Being inside" a group is not a separate state: the current SELECTION
  // tells it. If a child of the group is selected, we are inside that group.
  it("once inside a group, a click on a sibling selects the sibling, not the group again", () => {
    const s = grouped();
    expect(selectionTargetOf(s, "r2", ["r1"])).toBe("r2");
  });

  it("inside a nested group, the click stops at the level of the entered group", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    // Selected g2 => we are inside g1 (but not inside g2).
    expect(selectionTargetOf(s, "r", ["g2"])).toBe("g2");
    // Selected r => we are inside g2 too.
    expect(selectionTargetOf(s, "r", ["r"])).toBe("r");
  });

  it("clicking outside the entered group leaves it: the outermost group wins again", () => {
    const s = scene([
      group("g1", "page1"),
      node("inside", "g1", 0, 0),
      group("g2", "page1"),
      node("other", "g2", 0, 0),
    ]);
    expect(selectionTargetOf(s, "other", ["inside"])).toBe("g2");
  });

  // A container that is NOT a group (a rectangle with children, and tomorrow a
  // frame) does not capture the click: its children are selected directly.
  it("a non-group container does not capture the click", () => {
    const s = scene([node("box", "page1", 0, 0), node("child", "box", 0, 0)]);
    expect(selectionTargetOf(s, "child", [])).toBe("child");
  });

  it("still finds the group when it is nested under a non-group container", () => {
    const s = scene([node("box", "page1", 0, 0), group("g", "box"), node("r", "g", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g");
  });

  it("returns the id untouched when it is not in the scene", () => {
    expect(selectionTargetOf(grouped(), "vanished", [])).toBe("vanished");
  });

  // A FRAME DOES NOT CAPTURE THE CLICK (unlike the group): only GROUPS do
  // (isGroup in the selection prefix). Clicking a child of a frame
  // selects the CHILD, not the frame -- it is the artboard convention.
  it("a frame does NOT capture the click: a child of a frame selects the child", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 100, height: 100 }), node("child", "f", 10, 10)]);
    expect(selectionTargetOf(s, "child", [])).toBe("child");
  });

  it("clicking the frame's own body selects the frame itself", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 100, height: 100 })]);
    expect(selectionTargetOf(s, "f", [])).toBe("f");
  });

  // A frame NESTED inside a group does not intercept the climb: the outer
  // group captures, the frame stays transparent to the click like any
  // non-group container.
  it("still finds the outer group when a frame sits between it and the child", () => {
    const s = scene([group("g", "page1"), frame("f", "g", 0, 0, { width: 100, height: 100 }), node("r", "f", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g");
  });

  // Conversely, a GROUP nested inside a frame captures: only the group
  // does, the frame lets it through.
  it("finds a group nested inside a frame: only the group captures", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 200, height: 200 }), group("g", "f"), node("r", "g", 0, 0)]);
    expect(selectionTargetOf(s, "r", [])).toBe("g");
  });
});

// The same policy on a LIST (a frame's children taken by a marquee):
// no one is replaced by the frame, because the frame does not capture.
describe("selectionTargetsOf with a frame", () => {
  it("leaves a frame's children as themselves: no frame is captured", () => {
    const s = scene([
      frame("f", "page1", 0, 0, { width: 100, height: 100 }),
      node("a", "f", 10, 10),
      node("b", "f", 20, 20),
    ]);
    expect(selectionTargetsOf(s, ["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("enterTargetOf", () => {
  it("a double click on a child of a group selects the child", () => {
    const s = grouped();
    expect(enterTargetOf(s, "r1", [])).toBe("r1");
  });

  it("enters ONE level at a time when groups are nested", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    expect(enterTargetOf(s, "r", [])).toBe("g2");
    expect(enterTargetOf(s, "r", ["g2"])).toBe("r");
  });

  // Nothing to enter = the double click stays free for its other
  // meaning (editing a text node, see selectTool).
  it("is null when the click already resolves to the node itself", () => {
    const s = grouped();
    expect(enterTargetOf(s, "r1", ["r1"])).toBeNull();
    expect(enterTargetOf(s, "alone", [])).toBeNull();
  });
});

describe("transformTargetsOf", () => {
  it("expands a group into its children: a group has no box of its own to rewrite", () => {
    expect(transformTargetsOf(grouped(), ["g"])).toEqual(["r1", "r2"]);
  });

  it("descends through nested groups down to the leaves", () => {
    const s = scene([group("g1", "page1"), group("g2", "g1"), node("r", "g2", 0, 0)]);
    expect(transformTargetsOf(s, ["g1"])).toEqual(["r"]);
  });

  it("leaves anything that is not a group alone, container or not", () => {
    const s = scene([node("box", "page1", 0, 0), node("child", "box", 0, 0)]);
    expect(transformTargetsOf(s, ["box"])).toEqual(["box"]);
  });

  // A FRAME has its OWN box to resize: it does not expand into children like
  // a group, it stays itself.
  it("keeps a frame: it has a box of its own to resize", () => {
    const s = scene([frame("f", "page1", 0, 0, { width: 100, height: 100 }), node("c", "f", 0, 0)]);
    expect(transformTargetsOf(s, ["f"])).toEqual(["f"]);
  });

  it("drops an empty group: there is nothing to transform", () => {
    const s = scene([group("g", "page1"), node("alone", "page1", 0, 0)]);
    expect(transformTargetsOf(s, ["g", "alone"])).toEqual(["alone"]);
  });

  it("keeps an unknown id (it is not this function's job to validate)", () => {
    expect(transformTargetsOf(grouped(), ["vanished"])).toEqual(["vanished"]);
  });
});

// INSTANCES (M4), BOUNDS side and SELECTION POLICY. An instance is, here, a
// GROUP whose content is the master's subtree moved to the instance's
// origin: DERIVED bounds, no box of its own, selected as a unit.
// Masters live under parentId "components" (not a page), as a real
// component sits on a separate page.
function instance(id: string, parentId: string, x: number, y: number, componentId: string, overrides: import("./types").InstanceOverrideLite[] = []): NodeLite {
  return node(id, parentId, x, y, { kind: "instance", instance: { componentId, overrides }, fills: [] });
}

describe("contentWorldBounds for an instance", () => {
  it("is the master root's box, shifted so the root origin lands at the instance origin", () => {
    const s = scene([
      node("mr", "components", 10, 10), // master rect 50x50 a (10,10)
      instance("i", "page1", 100, 100, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 100, y: 100, width: 50, height: 50 });
  });

  it("unions a group master's children, shifted to the instance origin", () => {
    const s = scene([
      group("gm", "components"),
      node("r1", "gm", 0, 0),
      node("r2", "gm", 100, 0, { width: 20, height: 20 }),
      instance("i", "page1", 200, 200, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    // Local union of the master: (0,0,50,50) ∪ (100,0,20,20) = (0,0,120,50).
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 200, y: 200, width: 120, height: 50 });
  });

  it("maps the content through an ancestor's translation, like any other node", () => {
    const s = scene([
      group("wrap", "page1", { x: 1000, y: 0 }),
      node("mr", "components", 0, 0),
      instance("i", "wrap", 100, 100, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    // i.x/y are in wrap's space (translated by 1000,0): world (1100,100).
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 1100, y: 100, width: 50, height: 50 });
  });

  it("is null when the component is missing (nothing to frame)", () => {
    const s = scene([instance("i", "page1", 0, 0, "nope")]);
    expect(contentWorldBounds(s, s.nodes.at("i"))).toBeNull();
  });

  it("is null when the master root node is missing", () => {
    const s = scene([instance("i", "page1", 0, 0, "comp")]);
    s.components["comp"] = { rootNodeId: "gone", name: "Comp" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toBeNull();
  });

  it("ignores fill/text overrides: an override changes paint, not geometry", () => {
    const s = scene([
      node("mr", "components", 10, 10),
      instance("i", "page1", 100, 100, "comp", [{ masterNodeId: "mr", fills: [{ r: 1, g: 0, b: 0, a: 1 }] }]),
    ]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toEqual({ x: 100, y: 100, width: 50, height: 50 });
  });

  it("does not infinite-loop on a self-referential component: null, and it returns", () => {
    const s = scene([
      group("gs", "components"),
      instance("ci", "gs", 0, 0, "self"),
      instance("i", "page1", 0, 0, "self"),
    ]);
    s.components["self"] = { rootNodeId: "gs", name: "Self" };
    expect(contentWorldBounds(s, s.nodes.at("i"))).toBeNull();
  });
});

describe("instance selection policy", () => {
  function withInstance(): SceneState {
    const s = scene([node("mr", "components", 0, 0), instance("i", "page1", 100, 100, "comp")]);
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    return s;
  }

  it("selects the instance as a unit: a click resolves to the instance, not a master node", () => {
    expect(selectionTargetOf(withInstance(), "i", [])).toBe("i");
  });

  it("is NOT expanded by transformTargetsOf: it has a box of its own to resize, unlike a group", () => {
    expect(transformTargetsOf(withInstance(), ["i"])).toEqual(["i"]);
  });

  it("frameOriginOf is the content's top-left in parent space, not the instance's own x/y", () => {
    const s = scene([
      group("gm", "components"),
      node("r", "gm", -5, -5, { width: 10, height: 10 }), // the content overflows at the top-left of the root
      instance("i", "page1", 100, 100, "comp"),
    ]);
    s.components["comp"] = { rootNodeId: "gm", name: "Comp" };
    // The master's root lands at (100,100); the child at (-5,-5) brings the edge
    // of the content to (95,95) -- different from the instance's own x/y (100).
    expect(s.nodes.at("i").x).toBe(100);
    expect(frameOriginOf(s, s.nodes.at("i"))).toEqual({ x: 95, y: 95 });
  });
});
