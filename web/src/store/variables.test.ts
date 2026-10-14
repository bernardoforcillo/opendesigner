import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  NodeSchema, OpSchema, CreateNodeSchema, SetVariableSchema, DeleteVariableSchema, SetModesSchema, SetPropertiesSchema, VariableType, VariableSchema, ModeSchema, ColorSchema,
} from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, fromDocument, toPbNode, type SceneState } from "./types";
import { withActiveMode } from "./variables";
import { create as mk } from "@bufbuild/protobuf";
import { DocumentSchema } from "../gen/opendesigner/v1/opendesigner_pb";

// Parity with internal/core/variables_test.go: same ops, same accept/reject.

const op = (kind: Op["kind"]) => create(OpSchema, { opId: "o", docId: "d", kind });
const c = (r: number, g: number, b: number) => create(ColorSchema, { r, g, b, a: 1 });
const setModes = (...ids: string[]) =>
  op({ case: "setModes", value: create(SetModesSchema, { modes: ids.map((id) => create(ModeSchema, { id, name: id })) }) });
const setVar = (id: string, name: string, values: Record<string, ReturnType<typeof c>>) =>
  op({ case: "setVariable", value: create(SetVariableSchema, { variable: create(VariableSchema, { id, name, values }) }) });
const delVar = (id: string) => op({ case: "deleteVariable", value: create(DeleteVariableSchema, { id }) });

function boundRect(id: string, varId: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1, width: 10, height: 10,
    fills: [{ kind: { case: "variable", value: { variableId: varId } } }],
    strokes: [{ paint: { kind: { case: "variable", value: { variableId: varId } } }, weight: 2 }],
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return op({ case: "createNode", value: create(CreateNodeSchema, { node }) });
}

function scene(): SceneState {
  let s = emptyScene("d", "d");
  s = applyOp(s, setModes("light", "dark"));
  s = applyOp(s, setVar("v", "color/brand", { light: c(1, 0, 0), dark: c(0, 0, 1) }));
  return s;
}

const fill = (s: SceneState, id: string) => s.nodes.at(id).fills[0];

describe("variables", () => {
  it("resolves a bound fill and stroke at the default (first) mode on create", () => {
    const s = applyOp(scene(), boundRect("r", "v"));
    expect(fill(s, "r")).toMatchObject({ r: 1, g: 0, b: 0, varId: "v" });
    expect(s.nodes.at("r").strokes[0].color).toMatchObject({ r: 1, varId: "v" });
  });

  it("restyles every bound node when the variable changes", () => {
    let s = applyOp(scene(), boundRect("r", "v"));
    s = applyOp(s, boundRect("q", "v"));
    s = applyOp(s, setVar("v", "color/brand", { light: c(0, 1, 0), dark: c(0, 0, 1) }));
    expect(fill(s, "r").g).toBe(1);
    expect(fill(s, "q").g).toBe(1);
  });

  it("previews another mode without touching the document", () => {
    const s0 = applyOp(scene(), boundRect("r", "v"));
    const s = withActiveMode(s0, "dark");
    expect(fill(s, "r")).toMatchObject({ r: 0, b: 1 });
    expect(s.variables).toBe(s0.variables);
  });

  it("falls back to the default mode when a variable has no value for the active mode", () => {
    let s = applyOp(scene(), setVar("w", "color/only-light", { light: c(1, 1, 0) }));
    s = applyOp(s, boundRect("r", "w"));
    expect(fill(withActiveMode(s, "dark"), "r")).toMatchObject({ r: 1, g: 1, b: 0 });
  });

  it("draws black when the variable is deleted, and rejects deleting it twice", () => {
    let s = applyOp(scene(), boundRect("r", "v"));
    s = applyOp(s, delVar("v"));
    expect(fill(s, "r")).toMatchObject({ r: 0, g: 0, b: 0, a: 1, varId: "v" });
    expect(applyOp(s, delVar("v"))).toBe(s);
  });

  it("rejects the same invalid ops as Go and leaves the scene unchanged", () => {
    const s = scene();
    expect(applyOp(s, setVar("", "x", {}))).toBe(s);                       // no id
    expect(applyOp(s, setVar("v2", "", {}))).toBe(s);                      // no name
    expect(applyOp(s, setVar("v2", "x", { sepia: c(1, 1, 1) }))).toBe(s); // unknown mode once modes exist
    expect(applyOp(s, setModes("a", "a"))).toBe(s);                        // duplicate
    expect(applyOp(s, setModes(""))).toBe(s);                              // empty id
  });

  it("drops the values of a removed mode without mutating the previous scene", () => {
    const s0 = scene();
    const s = applyOp(s0, setModes("light"));
    expect(s.variables!.v.values.dark).toBeUndefined();
    expect(s0.variables!.v.values.dark).toBeDefined();
  });

  it("round-trips a binding through toPbNode (clipboard, undo)", () => {
    const s = applyOp(scene(), boundRect("r", "v"));
    const pb = toPbNode(s.nodes.at("r"));
    expect(pb.fills[0].kind.case).toBe("variable");
  });

  it("resolves bound fills when a snapshot is loaded", () => {
    const doc = mk(DocumentSchema, {
      id: "d", name: "d", pages: [{ id: "page1", name: "P" }],
      modes: [{ id: "light", name: "light" }, { id: "dark", name: "dark" }],
      variables: { v: { id: "v", name: "x", values: { light: c(0, 1, 0) } } },
      nodes: { r: create(NodeSchema, {
        id: "r", parentId: "page1", orderKey: "a", visible: true, opacity: 1, width: 5, height: 5,
        fills: [{ kind: { case: "variable", value: { variableId: "v" } } }],
        shape: { case: "rect", value: { cornerRadius: 0 } },
      }) },
    });
    expect(fromDocument(doc).nodes.at("r").fills[0]).toMatchObject({ g: 1, varId: "v" });
  });

  describe("undo", () => {
    // Applies `op`, then its inverse, and expects the document state back.
    function roundTrip(before: SceneState, op: Op): SceneState {
      const inv = invertOp(before, op);
      expect(inv).not.toBeNull();
      const after = applyOp(before, op);
      expect(after).not.toBe(before);
      return inv!.reduce(applyOp, after);
    }

    it("setVariable: creating is undone by deleting, changing by restoring", () => {
      const s0 = scene();
      const created = roundTrip(s0, setVar("w", "color/new", { light: c(0, 1, 0) }));
      expect(created.variables!.w).toBeUndefined();
      const changed = roundTrip(s0, setVar("v", "color/brand", { light: c(0, 1, 0) }));
      expect(changed.variables!.v.values.light.r).toBe(1);
    });

    it("deleteVariable: undo brings the variable and the bound colours back", () => {
      const s0 = applyOp(scene(), boundRect("r", "v"));
      const s = roundTrip(s0, delVar("v"));
      expect(s.variables!.v.values.light.r).toBe(1);
      expect(fill(s, "r")).toMatchObject({ r: 1, g: 0, b: 0, varId: "v" });
    });

    it("setModes: undo restores the modes AND the values the removal dropped", () => {
      const s0 = scene();
      const s = roundTrip(s0, setModes("light"));
      expect(s.modes!.map((m) => m.id)).toEqual(["light", "dark"]);
      expect(s.variables!.v.values.dark).toMatchObject({ b: 1 });
    });

    it("a rejected op has no inverse", () => {
      const s = scene();
      expect(invertOp(s, setVar("", "x", {}))).toBeNull();
      expect(invertOp(s, setModes("a", "a"))).toBeNull();
      expect(invertOp(s, delVar("nope"))).toBeNull();
    });
  });

  it("editing the colour of a bound fill from the panel unbinds it (literal wins)", () => {
    // fillOps in PropertiesPanel builds a fresh FillLite without varId.
    let s = applyOp(scene(), boundRect("r", "v"));
    const first = { r: 0, g: 1, b: 0, a: 1 };
    const patch = create(NodeSchema, { fills: [{ kind: { case: "solid", value: { color: first } } }] });
    s = applyOp(s, create(OpSchema, { opId: "o", docId: "d", kind: { case: "setProps", value: create(SetPropertiesSchema, { id: "r", patch, mask: { paths: ["fills"] } }) } }));
    expect(fill(s, "r").varId).toBeUndefined();
    expect(s.nodes.at("r").strokes[0].color.varId).toBe("v");
  });
});

describe("variables and component instances", () => {
  // A master rect, a component over it, and an instance whose fill override is bound.
  function withInstance(): SceneState {
    let s = applyOp(scene(), boundRect("m", "v"));
    s = applyOp(s, op({ case: "createComponent", value: { componentId: "c", rootNodeId: "m", name: "Box" } as never }));
    const inst = create(NodeSchema, {
      id: "i", parentId: "page1", orderKey: "b0", name: "i", visible: true, opacity: 1, width: 10, height: 10,
      shape: { case: "instance", value: { componentId: "c", overrides: [] } },
    });
    s = applyOp(s, op({ case: "createNode", value: create(CreateNodeSchema, { node: inst }) }));
    return applyOp(s, op({ case: "setInstanceOverride", value: {
      instanceId: "i",
      override: { masterNodeId: "m", fillsPresent: true, fills: [{ kind: { case: "variable", value: { variableId: "v" } } }] },
    } as never }));
  }

  it("resolves a bound fill override, and re-resolves it when the mode or variable changes", () => {
    const s = withInstance();
    const ov = (x: SceneState) => x.nodes.at("i").instance!.overrides[0].fills![0];
    expect(ov(s)).toMatchObject({ r: 1, g: 0, b: 0, varId: "v" });          // not the black placeholder
    expect(ov(withActiveMode(s, "dark"))).toMatchObject({ r: 0, b: 1 });
    const s2 = applyOp(s, setVar("v", "color/brand", { light: c(0, 1, 0), dark: c(0, 0, 1) }));
    expect(ov(s2)).toMatchObject({ g: 1 });
  });
});

// --- kinds, aliases, bindings, gradient stops (parity with core/variables_test.go) ---

const numVar = (id: string, numbers: Record<string, number>) =>
  op({ case: "setVariable", value: create(SetVariableSchema, { variable: create(VariableSchema, { id, name: `n/${id}`, type: VariableType.NUMBER, numbers }) }) });
const strVar = (id: string, strings: Record<string, string>) =>
  op({ case: "setVariable", value: create(SetVariableSchema, { variable: create(VariableSchema, { id, name: `s/${id}`, type: VariableType.STRING, strings }) }) });
const aliasVar = (id: string, aliasOf: string, type = VariableType.COLOR) =>
  op({ case: "setVariable", value: create(SetVariableSchema, { variable: create(VariableSchema, { id, name: `a/${id}`, type, aliasOf }) }) });
const bindOp = (id: string, bindings: Record<string, string>) =>
  op({ case: "setProps", value: create(SetPropertiesSchema, { id, patch: create(NodeSchema, { bindings }), mask: { paths: ["bindings"] } }) });

function textNode(id: string) {
  return op({ case: "createNode", value: create(CreateNodeSchema, { node: create(NodeSchema, {
    id, parentId: "page1", orderKey: "b0", name: id, visible: true, opacity: 1, width: 20, height: 20,
    shape: { case: "text", value: { content: "old", style: { fontSize: 12 } } },
  }) }) });
}

describe("variable kinds", () => {
  it("keeps values of each kind in their own map and rejects mixing", () => {
    const s = scene();
    const bad = op({ case: "setVariable", value: create(SetVariableSchema, { variable: create(VariableSchema, {
      id: "x", name: "x", type: VariableType.NUMBER, values: { light: c(1, 1, 1) } }) }) });
    expect(applyOp(s, bad)).toBe(s);
    expect(applyOp(s, numVar("x", { sepia: 1 }))).toBe(s);                         // unknown mode
    expect(applyOp(s, numVar("x", { light: 1, dark: 2 })).variables!.x.numbers).toEqual({ light: 1, dark: 2 });
  });

  it("drops numbers and strings of a removed mode and keeps the kind", () => {
    let s = applyOp(scene(), numVar("n", { light: 1, dark: 2 }));
    s = applyOp(s, setModes("light"));
    expect(s.variables!.n.numbers).toEqual({ light: 1 });
    expect(s.variables!.n.kind).toBe("number");
  });
});

describe("aliases", () => {
  it("follow the target at the active mode, and the target's changes", () => {
    let s = applyOp(scene(), aliasVar("sem", "v"));
    s = applyOp(s, boundRect("r", "sem"));
    expect(fill(s, "r")).toMatchObject({ r: 1, varId: "sem" });
    expect(fill(withActiveMode(s, "dark"), "r")).toMatchObject({ b: 1 });
    s = applyOp(s, setVar("v", "color/brand", { light: c(0, 1, 0), dark: c(0, 0, 1) }));
    expect(fill(s, "r")).toMatchObject({ g: 1 });
  });

  it("rejects the same bad aliases as Go", () => {
    const s = applyOp(scene(), aliasVar("sem", "v"));
    expect(applyOp(s, aliasVar("x", "ghost"))).toBe(s);                             // unknown target
    expect(applyOp(s, aliasVar("x", "x"))).toBe(s);                                 // itself
    expect(applyOp(s, aliasVar("x", "v", VariableType.NUMBER))).toBe(s);            // other kind
    expect(applyOp(s, aliasVar("v", "sem"))).toBe(s);                               // cycle through another
    const withValues = op({ case: "setVariable", value: create(SetVariableSchema, { variable: create(VariableSchema, {
      id: "x", name: "x", aliasOf: "v", values: { light: c(1, 1, 1) } }) }) });
    expect(applyOp(s, withValues)).toBe(s);                                         // alias carrying values
  });

  it("a dangling alias reads as black", () => {
    let s = applyOp(scene(), aliasVar("sem", "v"));
    s = applyOp(s, boundRect("r", "sem"));
    s = applyOp(s, delVar("v"));
    expect(fill(s, "r")).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});

describe("bindings of numbers and text", () => {
  function bound() {
    let s = applyOp(scene(), boundRect("r", "v"));
    s = applyOp(s, textNode("t"));
    s = applyOp(s, numVar("radius", { light: 8, dark: 16 }));
    s = applyOp(s, numVar("size", { light: 20 }));
    s = applyOp(s, numVar("op", { light: 0.5, dark: 1 }));
    s = applyOp(s, strVar("copy", { light: "Hello", dark: "Ciao" }));
    s = applyOp(s, bindOp("r", { corner_radius: "radius", opacity: "op" }));
    return applyOp(s, bindOp("t", { font_size: "size", text: "copy" }));
  }

  it("drive the node's properties and follow the variable", () => {
    let s = bound();
    expect(s.nodes.at("r")).toMatchObject({ cornerRadius: 8, opacity: 0.5 });
    expect(s.nodes.at("t").text).toMatchObject({ content: "Hello", style: { fontSize: 20 } });
    s = applyOp(s, numVar("radius", { light: 12, dark: 16 }));
    expect(s.nodes.at("r").cornerRadius).toBe(12);
  });

  it("follow the previewed mode, falling back to the default when a mode has no value", () => {
    const s = withActiveMode(bound(), "dark");
    expect(s.nodes.at("r")).toMatchObject({ cornerRadius: 16, opacity: 1 });
    expect(s.nodes.at("t").text).toMatchObject({ content: "Ciao", style: { fontSize: 20 } });  // size has no dark value
  });

  it("a text edit on a bound text loses to the binding; deleting the variable keeps the last value", () => {
    let s = bound();
    s = applyOp(s, op({ case: "setText", value: { id: "t", content: "typed", style: undefined, stylePresent: false } as never }));
    expect(s.nodes.at("t").text!.content).toBe("Hello");
    s = applyOp(s, delVar("radius"));
    expect(s.nodes.at("r").cornerRadius).toBe(8);
  });

  it("are validated: property, node nature, variable existence and kind", () => {
    const s = bound();
    expect(applyOp(s, bindOp("r", { width: "radius" }))).toBe(s);                   // not bindable
    expect(applyOp(s, bindOp("r", { opacity: "ghost" }))).toBe(s);                  // unknown variable
    expect(applyOp(s, bindOp("r", { opacity: "v" }))).toBe(s);                      // colour for a number
    expect(applyOp(s, bindOp("r", { opacity: "copy" }))).toBe(s);                   // string for a number
    expect(applyOp(s, bindOp("r", { font_size: "size" }))).toBe(s);                 // font size on a rect
    expect(applyOp(s, bindOp("t", { corner_radius: "radius" }))).toBe(s);           // radius on a text
  });

  it("are undone: the inverse restores the previous bindings", () => {
    const s0 = bound();
    const unbind = bindOp("r", {});
    const inv = invertOp(s0, unbind)!;
    const s1 = applyOp(s0, unbind);
    expect(s1.nodes.at("r").bindings).toBeUndefined();
    expect(inv.reduce(applyOp, s1).nodes.at("r").bindings).toEqual({ corner_radius: "radius", opacity: "op" });
  });
});

describe("gradient stops", () => {
  const gradientNode = () => op({ case: "createNode", value: create(CreateNodeSchema, { node: create(NodeSchema, {
    id: "g", parentId: "page1", orderKey: "c0", name: "g", visible: true, opacity: 1, width: 10, height: 10,
    fills: [{ kind: { case: "linear", value: { x2: 1, stops: [
      { color: { r: 0, g: 0, b: 0, a: 1 }, position: 0, variableId: "v" },
      { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 },
    ] } } }],
    shape: { case: "rect", value: { cornerRadius: 0 } },
  }) }) });

  it("a bound stop takes the variable's colour, and so does the fill's flat colour", () => {
    let s = applyOp(scene(), gradientNode());
    const f = () => s.nodes.at("g").fills[0];
    expect(f().gradient!.stops[0].color).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(f()).toMatchObject({ r: 1, g: 0, b: 0 });                                // the gradient's fallback is its first stop
    expect(f().gradient!.stops[1].color).toMatchObject({ r: 1, g: 1, b: 1 });       // unbound stop untouched
    s = withActiveMode(s, "dark");
    expect(f().gradient!.stops[0].color).toMatchObject({ b: 1 });
  });
});
