import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import { TypographyControls } from "./TypographyControls";
import { featureValue, withFeature } from "./fontFeatures";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const text = (id: string): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 20, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content: "Hello", style: { fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 0, align: "left" } },
});

const styleOf = (id: string) => useScene.getState().scene!.nodes.at(id).text!.style;

beforeEach(() => {
  const scene = emptyScene("doc-1", "Untitled");
  scene.nodes = scene.nodes.set("a", text("a"));
  useScene.getState().setScene(scene);
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["a"], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(new FakeSync());
});
afterEach(cleanup);

describe("font feature helpers", () => {
  it("reads and rewrites a feature string", () => {
    expect(featureValue('"liga" 0, "tnum"', "liga")).toBe(0);
    expect(featureValue('"liga" 0, "tnum"', "tnum")).toBe(1);
    expect(featureValue('"tnum"', "liga")).toBeNull();
    expect(withFeature(undefined, "tnum", 1)).toBe('"tnum"');
    expect(withFeature('"tnum", "liga" 0', "liga", null)).toBe('"tnum"');
    expect(withFeature('"tnum"', "liga", 0)).toBe('"tnum", "liga" 0');
    expect(withFeature('"liga" 0', "liga", null)).toBeUndefined();
  });
});

describe("TypographyControls — type extras", () => {
  it("sets and clears case, script, list and vertical alignment, one undo step each", () => {
    render(<TypographyControls />);
    const pick = (name: string, value: string) => fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
    pick("Text case", "smallCaps");
    pick("Script", "super");
    pick("List", "numbered");
    pick("Vertical align", "middle");
    expect(styleOf("a")).toMatchObject({ textCase: "smallCaps", textScript: "super", listKind: "numbered", verticalAlign: "middle" });
    expect(useScene.getState().undoStack).toHaveLength(4);
    pick("Text case", "");
    expect(styleOf("a").textCase).toBeUndefined();
    useScene.getState().undo();
    expect(styleOf("a").textCase).toBe("smallCaps");
  });

  it("toggles ligatures off and tabular figures on through the feature string", () => {
    render(<TypographyControls />);
    const lig = screen.getByRole("button", { name: "Ligatures" });
    expect(lig).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(lig);
    expect(styleOf("a").fontFeatures).toBe('"liga" 0');
    fireEvent.click(screen.getByRole("button", { name: "Tabular figures" }));
    expect(styleOf("a").fontFeatures).toBe('"liga" 0, "tnum"');
    fireEvent.click(screen.getByRole("button", { name: "Ligatures" }));
    expect(styleOf("a").fontFeatures).toBe('"tnum"');
  });

  it("accepts a well-formed feature string and refuses a malformed one", () => {
    render(<TypographyControls />);
    const input = screen.getByRole("textbox", { name: "OpenType features" });
    fireEvent.change(input, { target: { value: '"ss01", "cv05" 1' } });
    fireEvent.blur(input);
    expect(styleOf("a").fontFeatures).toBe('"ss01", "cv05" 1');
    fireEvent.change(input, { target: { value: "nope;" } });
    fireEvent.blur(input);
    expect(styleOf("a").fontFeatures).toBe('"ss01", "cv05" 1');
  });
});
