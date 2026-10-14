import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { PropertiesPanel } from "./PropertiesPanel";
import { VariablesPanel } from "./VariablesPanel";
import { useScene } from "../store/store";
import { makeSetPropsOp } from "../tools/ops";
import { emptyScene, type NodeLite, type SceneState } from "../store/types";

// Same double as PropertiesPanel.test.tsx: a server that accepts and echoes.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const node = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 30, height: 30, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

function install(patch: Partial<SceneState> = {}, ...nodes: NodeLite[]) {
  const scene: SceneState = { ...emptyScene("d", "d"), ...patch };
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
}

const withTokens: Partial<SceneState> = {
  modes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }],
  variables: { v: { id: "v", name: "color/brand", kind: "color", values: { light: { r: 1, g: 0, b: 0, a: 1 }, dark: { r: 0, g: 0, b: 1, a: 1 } } } },
};

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

const kinds = () => sync.sent.map((o) => o.kind.case);

describe("VariablesPanel", () => {
  it("starts empty and the first variable also creates the default mode, in one gesture", async () => {
    install();
    render(<VariablesPanel />);
    expect(screen.getByText("No variables yet")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "New colour variable" }));

    expect(kinds()).toEqual(["setModes", "setVariable"]);
    expect(useScene.getState().undoStack).toHaveLength(1);                  // ONE undo step
    expect(screen.getByRole("textbox", { name: /Name of color\/token-1/ })).toBeInTheDocument();
    expect(useScene.getState().scene!.modes).toEqual([{ id: "default", name: "Default" }]);
  });

  it("switching the previewed mode restyles bound nodes and sends nothing", async () => {
    install(withTokens, node("r", { fills: [{ r: 1, g: 0, b: 0, a: 1, varId: "v" }] }));
    render(<VariablesPanel />);

    await userEvent.setup().click(screen.getByRole("radio", { name: "Dark" }));

    expect(useScene.getState().scene!.nodes.at("r").fills[0]).toMatchObject({ r: 0, b: 1, varId: "v" });
    expect(sync.sent).toHaveLength(0);                                      // view state, not an op
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });

  it("the previewed mode survives the next incoming op", async () => {
    install(withTokens, node("r", { fills: [{ r: 1, g: 0, b: 0, a: 1, varId: "v" }] }));
    render(<VariablesPanel />);
    await userEvent.setup().click(screen.getByRole("radio", { name: "Dark" }));

    // An ordinary edit arriving (here our own, echoed by the server) rebuilds the view.
    useScene.getState().beginGesture();
    useScene.getState().endGesture([makeSetPropsOp("r", { name: "renamed" }, ["name"])]);
    expect(useScene.getState().scene!.activeMode).toBe("dark");
    expect(useScene.getState().scene!.nodes.at("r").fills[0]).toMatchObject({ b: 1 });
  });

  it("editing a colour in one mode leaves the other mode's value alone", async () => {
    install(withTokens);
    render(<VariablesPanel />);
    const user = userEvent.setup();

    const dark = screen.getByRole("textbox", { name: "color/brand in Dark" });
    await user.clear(dark);
    await user.type(dark, "#00FF00{Enter}");

    expect(kinds()).toEqual(["setVariable"]);
    const v = useScene.getState().scene!.variables!.v;
    expect(v.values.dark).toMatchObject({ r: 0, g: 1, b: 0 });
    expect(v.values.light).toMatchObject({ r: 1, g: 0, b: 0 });
  });

  it("deletes a variable with one op and shows how many paints use it", async () => {
    install(withTokens, node("r", { fills: [{ r: 1, g: 0, b: 0, a: 1, varId: "v" }] }));
    render(<VariablesPanel />);
    expect(screen.getByTitle("Fills, strokes and gradient stops bound to it")).toHaveTextContent("1");

    await userEvent.setup().click(screen.getByRole("button", { name: "Delete color/brand" }));

    expect(kinds()).toEqual(["deleteVariable"]);
    expect(useScene.getState().scene!.variables).toEqual({});
  });

  it("removing the last mode is not possible", () => {
    install({ modes: [{ id: "light", name: "Light" }] });
    render(<VariablesPanel />);
    expect(screen.getByRole("button", { name: "Remove current mode" })).toBeDisabled();
  });
});

describe("the Variable picker of the properties panel", () => {
  it("is absent when the document has no variables", () => {
    install({}, node("r"));
    useScene.getState().setSelection(["r"]);
    render(<PropertiesPanel />);
    expect(screen.queryByRole("combobox", { name: "Fill variable" })).toBeNull();
  });

  it("binds the fill in one op and unbinds it keeping the colour shown", async () => {
    install(withTokens, node("r"));
    useScene.getState().setSelection(["r"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    const picker = screen.getByRole("combobox", { name: "Fill variable" });
    expect(within(picker).getByRole("option", { name: "Fixed colour" })).toBeInTheDocument();

    await user.selectOptions(picker, "v");
    expect(kinds()).toEqual(["setProps"]);
    expect(useScene.getState().scene!.nodes.at("r").fills[0]).toMatchObject({ r: 1, g: 0, b: 0, varId: "v" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Fill variable" }), "__none__");
    const f = useScene.getState().scene!.nodes.at("r").fills[0];
    expect(f.varId).toBeUndefined();
    expect(f).toMatchObject({ r: 1, g: 0, b: 0 });                           // the colour it showed stays
  });

  it("binds the stroke too, and only when the node has one", async () => {
    install(withTokens, node("r", { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] }), node("p"));
    useScene.getState().setSelection(["r", "p"]);
    render(<PropertiesPanel />);
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Stroke variable" }), "v");
    expect(sync.sent).toHaveLength(1);                                       // "p" has no stroke: nothing created
    expect(useScene.getState().scene!.nodes.at("r").strokes[0].color).toMatchObject({ r: 1, varId: "v" });
    expect(useScene.getState().scene!.nodes.at("p").strokes).toHaveLength(0);
  });

  it("flags a mixed selection instead of picking one", () => {
    install(withTokens, node("a", { fills: [{ r: 1, g: 0, b: 0, a: 1, varId: "v" }] }), node("b"));
    useScene.getState().setSelection(["a", "b"]);
    render(<PropertiesPanel />);
    expect(screen.getByRole("combobox", { name: "Fill variable" })).toHaveDisplayValue("Mixed");
  });
});

describe("number and text variables", () => {
  const num = (id: string, name: string, numbers: Record<string, number>): SceneState["variables"] => ({
    [id]: { id, name, kind: "number", values: {}, numbers },
  });

  it("creates a number variable and a text variable, each with a field per mode", async () => {
    install(withTokens);
    render(<VariablesPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New number variable" }));
    await user.click(screen.getByRole("button", { name: "New text variable" }));

    const vars = Object.values(useScene.getState().scene!.variables!);
    expect(vars.map((v) => v.kind).sort()).toEqual(["color", "number", "string"]);
    expect(screen.getByRole("textbox", { name: "number/token-1 in Light" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "text/token-1 in Dark" })).toBeInTheDocument();
  });

  it("editing a number or a text in one mode keeps the other mode", async () => {
    install({ ...withTokens, variables: { ...num("n", "space/pad", { light: 8, dark: 16 }) } });
    render(<VariablesPanel />);
    const user = userEvent.setup();
    const light = screen.getByRole("textbox", { name: "space/pad in Light" });
    await user.clear(light);
    await user.type(light, "12{Enter}");
    expect(useScene.getState().scene!.variables!.n.numbers).toEqual({ light: 12, dark: 16 });
  });
});

describe("aliases in the panel", () => {
  it("offers only same-kind targets, aliases, and turns back into own values keeping what it resolved to", async () => {
    install({
      ...withTokens,
      variables: {
        ...withTokens.variables,
        sem: { id: "sem", name: "color/semantic", kind: "color", values: { light: { r: 0, g: 1, b: 0, a: 1 } } },
        n: { id: "n", name: "space/pad", kind: "number", values: {}, numbers: { light: 8 } },
      },
    });
    render(<VariablesPanel />);
    const user = userEvent.setup();
    const select = screen.getByRole("combobox", { name: "Value of color/semantic" });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Own colour value", "Alias of color/brand"]);       // not the number variable, not itself

    await user.selectOptions(select, "v");
    expect(useScene.getState().scene!.variables!.sem).toMatchObject({ aliasOf: "v", values: {} });
    expect(screen.queryByRole("textbox", { name: "color/semantic in Light" })).toBeNull();   // an alias has no own values

    await user.selectOptions(screen.getByRole("combobox", { name: "Value of color/semantic" }), "__own__");
    const back = useScene.getState().scene!.variables!.sem;
    expect(back.aliasOf).toBeUndefined();
    expect(back.values.light).toMatchObject({ r: 1, g: 0, b: 0 });                // the target's colour is kept
  });

  it("never offers a target that would make a loop", () => {
    install({
      ...withTokens,
      variables: {
        ...withTokens.variables,
        a: { id: "a", name: "color/a", kind: "color", values: {}, aliasOf: "v" },
      },
    });
    render(<VariablesPanel />);
    // v may not alias a (a already points at v), and there is nothing else: no picker at all.
    expect(screen.queryByRole("combobox", { name: "Value of color/brand" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Value of color/a" })).toHaveDisplayValue("Alias of color/brand");
  });
});

describe("the Variables section of the properties panel", () => {
  const tokens: Partial<SceneState> = {
    ...withTokens,
    variables: {
      ...withTokens.variables,
      op: { id: "op", name: "alpha/card", kind: "number", values: {}, numbers: { light: 0.5, dark: 1 } },
      cr: { id: "cr", name: "radius/md", kind: "number", values: {}, numbers: { light: 8, dark: 16 } },
      tx: { id: "tx", name: "copy/title", kind: "string", values: {}, strings: { light: "Hello", dark: "Ciao" } },
    },
  };

  it("offers opacity and, for a rectangle, the corner radius; binds in one op", async () => {
    install(tokens, node("r"));
    useScene.getState().setSelection(["r"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();
    expect(screen.queryByRole("combobox", { name: "Font size variable" })).toBeNull();     // not a text node

    await user.selectOptions(screen.getByRole("combobox", { name: "Corner radius variable" }), "cr");
    await user.selectOptions(screen.getByRole("combobox", { name: "Opacity variable" }), "op");

    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setProps", "setProps"]);
    expect(useScene.getState().scene!.nodes.at("r")).toMatchObject({ cornerRadius: 8, opacity: 0.5, bindings: { corner_radius: "cr", opacity: "op" } });

    await user.selectOptions(screen.getByRole("combobox", { name: "Opacity variable" }), "__none__");
    const n = useScene.getState().scene!.nodes.at("r");
    expect(n.bindings).toEqual({ corner_radius: "cr" });
    expect(n.opacity).toBe(0.5);                                                           // keeps the last value
  });

  it("text nodes offer font size and text, with only variables of the right kind", () => {
    install(tokens, { ...node("t"), kind: "text", text: { content: "old", style: { fontFamily: "Inter", fontSize: 12, fontWeight: "400", lineHeight: 1.2, align: "left" } } });
    useScene.getState().setSelection(["t"]);
    render(<PropertiesPanel />);
    const textOptions = within(screen.getByRole("combobox", { name: "Text variable" })).getAllByRole("option").map((o) => o.textContent);
    expect(textOptions).toEqual(["Fixed value", "copy/title"]);
    const sizeOptions = within(screen.getByRole("combobox", { name: "Font size variable" })).getAllByRole("option").map((o) => o.textContent);
    expect(sizeOptions).toEqual(["Fixed value", "alpha/card", "radius/md"]);
  });

  it("is absent when the document has only colour variables", () => {
    install(withTokens, node("r"));
    useScene.getState().setSelection(["r"]);
    render(<PropertiesPanel />);
    expect(screen.queryByRole("combobox", { name: "Opacity variable" })).toBeNull();
  });
});

describe("gradient stop variables", () => {
  it("binds the From stop and unbinds it keeping the colour", async () => {
    install(withTokens, node("g", { fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: {
      kind: "linear", x1: 0.5, y1: 0, x2: 0.5, y2: 1,
      stops: [{ color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 }],
    } }] }));
    useScene.getState().setSelection(["g"]);
    render(<PropertiesPanel />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole("combobox", { name: "From variable" }), "v");
    const stop = () => useScene.getState().scene!.nodes.at("g").fills[0].gradient!.stops[0];
    expect(stop()).toMatchObject({ varId: "v", color: { r: 1, g: 0, b: 0 } });

    await user.selectOptions(screen.getByRole("combobox", { name: "From variable" }), "__none__");
    expect(stop().varId).toBeUndefined();
    expect(stop().color).toMatchObject({ r: 1, g: 0, b: 0 });
  });
});
