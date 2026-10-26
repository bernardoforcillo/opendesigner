import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema, VariableSchema, VariableType } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { invertOp } from "@/store/history";
import { emptyScene, type SceneState } from "@/store/types";
import { activeMode, bindingType, resolveNode, resolveScene } from "@/store/variables";

type Kind = MessageInitShape<typeof OpSchema>["kind"];
const op = (kind: Kind): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId: string, extra: Record<string, unknown> = {}) =>
  op({ case: "createNode", value: { node: create(NodeSchema, {
    id, parentId, orderKey: "a1", name: id, visible: true, opacity: 1, width: 10, height: 10,
    shape: { case: id === "r" ? "rect" : "frame", value: {} }, ...extra,
  }) } });
const col = (id: string, ...modes: string[]) =>
  op({ case: "setCollection", value: { collection: { id, name: id, modes: modes.map((m) => ({ id: m, name: m })) } } });
type Value = NonNullable<MessageInitShape<typeof VariableSchema>["values"]>[string];
const color = (r: number, g: number, b: number): Value => ({ kind: { case: "color", value: { r, g, b, a: 1 } } });
const num = (n: number): Value => ({ kind: { case: "number", value: n } });
const setVar = (id: string, collectionId: string, type: VariableType, values: Record<string, Value>) =>
  op({ case: "setVariable", value: { variable: { id, collectionId, name: id, type, values } } });
const setProps = (id: string, paths: string[], patch: Record<string, unknown>) =>
  op({ case: "setProps", value: { id, mask: { paths }, patch: create(NodeSchema, patch) } });

const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);

// frame f > frame inner > rect r (red fill), Theme(light, dark), bg color + dim number bound on r.
const themed = () => run([
  node("f", "page1"), node("inner", "f"),
  node("r", "inner", { fills: [{ kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 1 } } } }] }),
  col("theme", "light", "dark"),
  setVar("bg", "theme", VariableType.COLOR, { light: color(1, 1, 1), dark: color(0, 0, 0) }),
  setVar("dim", "theme", VariableType.NUMBER, { light: num(1), dark: num(0.4) }),
  setProps("r", ["bindings"], { bindings: { "fills.0": "bg", opacity: "dim" } }),
]);

const str = (v: string): Value => ({ kind: { case: "text", value: v } });
const alias = (id: string, collectionId: string, type: VariableType, aliasOf: string) =>
  op({ case: "setVariable", value: { variable: { id, collectionId, name: id, type, aliasOf } } });
const textNode = (id: string, parentId: string) =>
  node(id, parentId, { shape: { case: "text", value: { content: "hi", style: { fontSize: 12 } } } });

describe("bindingType", () => {
  it("follows the grammar of core.BindingType", () => {
    expect(["opacity", "rotation", "corner_radius", "strokes.0.weight"].map(bindingType)).toEqual(["number", "number", "number", "number"]);
    expect(["fills.0", "strokes.12"].map(bindingType)).toEqual(["color", "color"]);
    expect(bindingType("font_size")).toBe("number");
    expect(bindingType("text")).toBe("string");
    expect(bindingType("text.0")).toBeNull();
    for (const bad of ["", "x", "fills", "fills.", "fills.-1", "fills.01", "fills.a", "fills.0.weight", "strokes.0.color", "opacity.0"]) {
      expect(bindingType(bad), bad).toBeNull();
    }
  });
});

describe("resolution", () => {
  it("uses the first mode, then the nearest pinned ancestor", () => {
    let s = themed();
    expect(activeMode(s, "r", "theme")).toBe("light");
    s = applyOp(s, setProps("f", ["modes"], { modes: { theme: "dark" } }));
    expect(activeMode(s, "r", "theme")).toBe("dark");
    s = applyOp(s, setProps("inner", ["modes"], { modes: { theme: "light" } }));
    expect(activeMode(s, "r", "theme")).toBe("light");
  });

  it("substitutes bound properties and leaves the document untouched", () => {
    const s = applyOp(themed(), setProps("f", ["modes"], { modes: { theme: "dark" } }));
    const r = resolveNode(s, s.nodes.at("r"));
    expect(r.fills[0]).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(r.opacity).toBe(0.4);
    expect(s.nodes.at("r").fills[0].r).toBe(1);
    expect(s.nodes.at("r").opacity).toBe(1);
  });

  it("falls back to the default mode's value when the active mode has none", () => {
    let s = themed();
    s = applyOp(s, setVar("rot", "theme", VariableType.NUMBER, { light: num(15) }));
    s = applyOp(s, setProps("r", ["bindings"], { bindings: { rotation: "rot" } }));
    s = applyOp(s, setProps("f", ["modes"], { modes: { theme: "dark" } }));
    expect(resolveNode(s, s.nodes.at("r")).rotation).toBe(15);
  });

  it("does not replace gradients and ignores missing targets", () => {
    let s = run([
      node("r", "page1", { fills: [{ kind: { case: "linear", value: { stops: [{ color: { r: 1, a: 1 }, position: 0 }, { color: { b: 1, a: 1 }, position: 1 }] } } }] }),
      col("theme", "light"), setVar("bg", "theme", VariableType.COLOR, { light: color(0, 1, 0) }),
    ]);
    s = applyOp(s, setProps("r", ["bindings"], { bindings: { "fills.0": "bg", "fills.4": "bg" } }));
    expect(resolveNode(s, s.nodes.at("r"))).toBe(s.nodes.at("r"));
  });

  it("returns the same node without bindings, and the same scene without variables", () => {
    const s = themed();
    expect(resolveNode(s, s.nodes.at("f"))).toBe(s.nodes.at("f"));
    const plain = run([node("a", "page1")]);
    expect(resolveScene(plain)).toBe(plain);
  });

  it("resolveScene shows the resolved nodes, is memoized and never mutates the scene", () => {
    const s = applyOp(themed(), setProps("f", ["modes"], { modes: { theme: "dark" } }));
    const shown = resolveScene(s);
    expect(shown).not.toBe(s);
    expect(shown.nodes.at("r").opacity).toBe(0.4);
    expect(s.nodes.at("r").opacity).toBe(1);
    expect(resolveScene(s)).toBe(shown);
  });
});

describe("cascades and their undo", () => {
  // Applies `direct`, checks the cascade, applies the inverse computed BEFORE it
  // and expects the exact starting scene back.
  const roundTrip = (before: SceneState, direct: Op) => {
    const inverse = invertOp(before, direct);
    expect(inverse).not.toBeNull();
    const after = applyOp(before, direct);
    expect(after).not.toBe(before);
    const back = run(inverse!, after);
    for (const key of ["nodes", "collections", "variables"] as const) expect(back[key], key).toEqual(before[key]);
    return after;
  };

  it("deleteVariable removes the bindings to it", () => {
    const after = roundTrip(themed(), op({ case: "deleteVariable", value: { id: "dim" } }));
    expect(after.nodes.at("r").bindings).toEqual({ "fills.0": "bg" });
  });

  it("deleteCollection removes its variables, bindings and pins", () => {
    const pinned = applyOp(themed(), setProps("f", ["modes"], { modes: { theme: "dark" } }));
    const after = roundTrip(pinned, op({ case: "deleteCollection", value: { id: "theme" } }));
    expect(after.variables).toEqual({});
    expect(after.nodes.at("r").bindings).toBeUndefined();
    expect(after.nodes.at("f").modes).toBeUndefined();
  });

  it("removing a mode drops its values and pins", () => {
    const pinned = applyOp(themed(), setProps("f", ["modes"], { modes: { theme: "dark" } }));
    const after = roundTrip(pinned, col("theme", "light", "hc"));
    expect(Object.keys(after.variables.bg.values)).toEqual(["light"]);
    expect(after.nodes.at("f").modes).toBeUndefined();
  });

  it("an upsert of a variable is undone to the previous values, and a creation to a delete", () => {
    const s = themed();
    roundTrip(s, setVar("bg", "theme", VariableType.COLOR, { light: color(0.5, 0.5, 0.5) }));
    roundTrip(s, setVar("new", "theme", VariableType.NUMBER, { light: num(3) }));
  });

  it("rejected ops have no inverse", () => {
    const s = themed();
    expect(invertOp(s, op({ case: "deleteVariable", value: { id: "nope" } }))).toBeNull();
    expect(invertOp(s, setVar("bg", "theme", VariableType.NUMBER, { light: num(1) }))).toBeNull();
    expect(invertOp(s, col("c"))).toBeNull();
  });
});

describe("aliases", () => {
  // Theme(light, dark) with bg; surface aliases it in the same collection; Brand(base) holds card -> surface.
  const aliased = () => run([
    node("f", "page1"), node("r", "f", { fills: [{ kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 1 } } } }] }),
    col("theme", "light", "dark"), col("brand", "base"),
    setVar("bg", "theme", VariableType.COLOR, { light: color(1, 1, 1), dark: color(0, 0, 0) }),
    alias("surface", "theme", VariableType.COLOR, "bg"),
    alias("card", "brand", VariableType.COLOR, "surface"),
    setProps("r", ["bindings"], { bindings: { "fills.0": "surface" } }),
  ]);

  it("reads the target in the alias's node mode, or in the target's first mode when the ids do not match", () => {
    let s = aliased();
    expect(resolveNode(s, s.nodes.at("r")).fills[0].r).toBe(1);
    s = applyOp(s, setProps("f", ["modes"], { modes: { theme: "dark" } }));
    expect(resolveNode(s, s.nodes.at("r")).fills[0].r).toBe(0);
    s = applyOp(s, setProps("r", ["bindings"], { bindings: { "fills.0": "card" } }));
    expect(resolveNode(s, s.nodes.at("r")).fills[0].r).toBe(1); // "base" is not a mode of theme
  });

  it("refuses a missing target, another type, a cycle, a self alias and values on an alias", () => {
    const s = aliased();
    const C = VariableType.COLOR;
    for (const bad of [
      alias("x", "theme", C, "nope"), alias("x", "theme", VariableType.NUMBER, "bg"), alias("x", "theme", C, "x"),
      alias("bg", "theme", C, "card"),
      op({ case: "setVariable", value: { variable: { id: "x", collectionId: "theme", name: "x", type: C, aliasOf: "bg", values: { light: color(1, 0, 0) } } } }),
    ]) expect(applyOp(s, bad)).toBe(s);
  });

  it("deleting a target deletes its aliases (transitively) and their bindings, and undo restores them", () => {
    const s = aliased();
    const del = op({ case: "deleteVariable", value: { id: "bg" } });
    const inverse = invertOp(s, del)!;
    const after = applyOp(s, del);
    expect(after.variables).toEqual({});
    expect(after.nodes.at("r").bindings).toBeUndefined();
    const back = run(inverse, after);
    expect(back.variables).toEqual(s.variables);
    expect(back.nodes).toEqual(s.nodes);
    // The same through the collection holding the primitive.
    const delCol = op({ case: "deleteCollection", value: { id: "theme" } });
    const back2 = run(invertOp(s, delCol)!, applyOp(s, delCol));
    expect(back2.variables).toEqual(s.variables);
    expect(back2.nodes).toEqual(s.nodes);
  });
});

describe("string variables and text bindings", () => {
  const texty = () => run([
    node("f", "page1"), textNode("t", "f"), col("copy", "en", "it"),
    setVar("hello", "copy", VariableType.STRING, { en: str("Hello"), it: str("Ciao") }),
    alias("title", "copy", VariableType.STRING, "hello"),
    setVar("big", "copy", VariableType.NUMBER, { en: num(30) }),
    setProps("t", ["bindings"], { bindings: { text: "title", font_size: "big" } }),
  ]);

  it("writes the bound content and font size into the resolved node, not the document", () => {
    let s = texty();
    let t = resolveNode(s, s.nodes.at("t"));
    expect(t.text).toEqual({ content: "Hello", style: expect.objectContaining({ fontSize: 30 }) });
    expect(s.nodes.at("t").text?.content).toBe("hi");
    s = applyOp(s, setProps("f", ["modes"], { modes: { copy: "it" } }));
    t = resolveNode(s, s.nodes.at("t"));
    expect(t.text?.content).toBe("Ciao");
    expect(resolveScene(s).nodes.at("t").text?.content).toBe("Ciao");
  });

  it("refuses a number in a string variable and mismatched bindings", () => {
    const s = texty();
    expect(applyOp(s, setVar("bad", "copy", VariableType.STRING, { en: num(1) }))).toBe(s);
    for (const b of [{ text: "big" }, { font_size: "hello" }, { opacity: "hello" }, { "fills.0": "hello" }]) {
      expect(applyOp(s, setProps("t", ["bindings"], { bindings: b })), JSON.stringify(b)).toBe(s);
    }
  });

  it("ignores a text binding on a node that is not text", () => {
    const s = applyOp(texty(), setProps("f", ["bindings"], { bindings: { text: "hello" } }));
    expect(resolveNode(s, s.nodes.at("f"))).toBe(s.nodes.at("f"));
  });
});
