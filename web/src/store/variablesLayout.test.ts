import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema, VariableType } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "@/store/applyOp";
import { invertOp } from "@/store/history";
import { bindingType, resolveNode } from "@/store/variables";
import { emptyScene, type SceneState } from "@/store/types";

// Boolean variables (bound to "visible") and number variables bound to the spacing and padding
// of an auto layout frame: the layout reads them in the frame's active mode. The TypeScript
// half of internal/core/variables_layout_test.go (testdata/golden/variables_layout.json runs both).

type Init = MessageInitShape<typeof NodeSchema>;
const op = (kind: MessageInitShape<typeof OpSchema>["kind"]): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const node = (id: string, parentId: string, shape: Init["shape"], over: Init = {}) =>
  op({ case: "createNode", value: { node: create(NodeSchema, { id, parentId, orderKey: id, name: id, visible: true, opacity: 1, width: 20, height: 10, shape, ...over }) } });
const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);
const rect = { case: "rect", value: {} } as const;
const num = (n: number) => ({ kind: { case: "number", value: n } }) as const;
const bool = (b: boolean) => ({ kind: { case: "boolean", value: b } }) as const;
const variable = (id: string, type: VariableType, values: Record<string, ReturnType<typeof num> | ReturnType<typeof bool>>, aliasOf = "") =>
  op({ case: "setVariable", value: { variable: { id, collectionId: "density", name: id, type, values, aliasOf } } });
const bind = (id: string, bindings: Record<string, string>) =>
  op({ case: "setProps", value: { id, mask: { paths: ["bindings"] }, patch: create(NodeSchema, { bindings }) } });
const pin = (id: string, mode: string) =>
  op({ case: "setProps", value: { id, mask: { paths: ["modes"] }, patch: create(NodeSchema, { modes: { density: mode } }) } });

const row = () => run([
  node("f", "page1", { case: "frame", value: { autoLayout: {} } }, { width: 200, height: 100 }),
  node("a", "f", rect), node("b", "f", rect), node("c", "f", rect),
  op({ case: "setCollection", value: { collection: { id: "density", name: "Density", modes: [{ id: "cozy", name: "Cozy" }, { id: "tight", name: "Tight" }] } } }),
]);

describe("spacing and padding bound to number variables", () => {
  it("are read in the frame's active mode, and follow the variable", () => {
    let s = run([
      variable("gap", VariableType.NUMBER, { cozy: num(16), tight: num(4) }),
      variable("pad", VariableType.NUMBER, { cozy: num(12), tight: num(2) }),
      bind("f", { spacing: "gap", padding_left: "pad", padding_top: "pad" }),
    ], row());
    expect(s.nodes.at("b")).toMatchObject({ x: 48, y: 12 });
    s = applyOp(s, pin("f", "tight"));
    expect(s.nodes.at("b")).toMatchObject({ x: 26, y: 2 });
    s = applyOp(s, variable("gap", VariableType.NUMBER, { cozy: num(16), tight: num(10) }));
    expect(s.nodes.at("c").x).toBe(62);
    expect(s.nodes.at("f").autoLayout!.spacing).toBe(0);            // the literal is untouched
    // An alias of the variable carries the binding along.
    s = run([variable("gap-sem", VariableType.NUMBER, {}, "gap"), bind("f", { spacing: "gap-sem" })], s);
    expect(s.nodes.at("b")).toMatchObject({ x: 30, y: 0 });
    // Deleting the variable unbinds it: the literal is back.
    s = applyOp(s, op({ case: "deleteVariable", value: { id: "gap" } }));
    expect(s.nodes.at("b")).toMatchObject({ x: 20, y: 0 });
  });

  it("resolveNode gives the bound auto layout, clamped at zero", () => {
    const s = run([variable("gap", VariableType.NUMBER, { cozy: num(-5), tight: num(3) }), bind("f", { spacing: "gap" })], row());
    expect(resolveNode(s, s.nodes.at("f")).autoLayout!.spacing).toBe(0);
    expect(resolveNode(applyOp(s, pin("f", "tight")), applyOp(s, pin("f", "tight")).nodes.at("f")).autoLayout!.spacing).toBe(3);
  });
});

describe("visibility bound to a boolean variable", () => {
  it("hides the node in the active mode and takes it out of the flow", () => {
    let s = run([variable("show", VariableType.BOOLEAN, { cozy: bool(true), tight: bool(false) }), bind("b", { visible: "show" })], row());
    expect(s.nodes.at("c").x).toBe(40);
    s = applyOp(s, pin("f", "tight"));
    expect(s.nodes.at("c").x).toBe(20);
    expect(s.nodes.at("b").visible).toBe(true);                   // the literal is untouched
    expect(resolveNode(s, s.nodes.at("b")).visible).toBe(false);
    s = applyOp(s, variable("show", VariableType.BOOLEAN, { cozy: bool(true), tight: bool(true) }));
    expect(s.nodes.at("c").x).toBe(40);
  });

  it("is validated: booleans only, bound to visible only", () => {
    const s = run([variable("show", VariableType.BOOLEAN, { cozy: bool(true) })], row());
    expect(applyOp(s, variable("x", VariableType.BOOLEAN, { cozy: num(1) }))).toBe(s);
    expect(applyOp(s, bind("a", { opacity: "show" }))).toBe(s);
    expect(applyOp(s, bind("a", { visible: "nope" }))).toBe(s);
    expect(bindingType("visible")).toBe("boolean");
    expect(bindingType("padding_left")).toBe("number");
    expect(bindingType("padding")).toBeNull();
  });

  it("undoes a variable edit that moved the layout", () => {
    const s = run([variable("show", VariableType.BOOLEAN, { cozy: bool(true), tight: bool(false) }), bind("b", { visible: "show" }), pin("f", "tight")], row());
    const edit = variable("show", VariableType.BOOLEAN, { cozy: bool(true), tight: bool(true) });
    const after = applyOp(s, edit);
    expect(after.nodes.at("c").x).toBe(40);
    const back = invertOp(s, edit)!.reduce(applyOp, after);
    expect(back.nodes.at("c").x).toBe(20);
  });
});
