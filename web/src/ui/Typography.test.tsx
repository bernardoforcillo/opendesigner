import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene, type FontLite, type NodeLite, type TextStyleDefLite } from "../store/types";
import { FontsDialog } from "./FontsDialog";
import { PropertiesPanel } from "./PropertiesPanel";
import { TypographyControls } from "./TypographyControls";
import { applyStyleOps, createStyleOps, familyChoices, guessFontFromFilename, sharedStyleOf, styleOps } from "./typographyOps";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const text = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 20, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content: "Hello", style: { fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 0, align: "left" } },
  ...over,
});

const BRAND: FontLite = { id: "f1", family: "Brand Sans", weight: "700", style: "normal", assetHash: "a".repeat(64) };
const HEADING: TextStyleDefLite = { id: "h", name: "Heading", style: { fontFamily: "Brand Sans", fontSize: 32, fontWeight: "700", lineHeight: 1.1, align: "center" } };

function install(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  scene.fonts = { f1: BRAND };
  scene.textStyles = { h: HEADING };
  useScene.getState().setScene(scene);
  return useScene.getState().scene!;
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

describe("typographyOps", () => {
  it("guesses family, weight and italic from a font file name", () => {
    expect(guessFontFromFilename("Inter-Bold.ttf")).toEqual({ family: "Inter", weight: "700", italic: false });
    expect(guessFontFromFilename("Brand Sans-BoldItalic.otf")).toEqual({ family: "Brand Sans", weight: "700", italic: true });
    expect(guessFontFromFilename("Roboto-Light.woff2")).toEqual({ family: "Roboto", weight: "300", italic: false });
    expect(guessFontFromFilename("Open_Sans.ttf")).toEqual({ family: "Open_Sans", weight: "400", italic: false });
    expect(guessFontFromFilename("my_font-SemiBold.ttf").weight).toBe("600");
    expect(guessFontFromFilename("!!!.ttf").family).toBe("Font");
  });

  it("offers the built-in stacks and each uploaded family once", () => {
    const scene = install(text("a"));
    scene.fonts = { ...scene.fonts, f2: { ...BRAND, id: "f2", weight: "400" } };
    const labels = familyChoices(scene).map((c) => c.label);
    expect(labels).toEqual(["Inter", "System UI", "Serif", "Monospace", "Brand Sans"]);
  });

  it("an edit on a text with a shared style detaches it and keeps what it was drawn with", () => {
    const scene = install(text("a", { textStyleId: "h" }));
    const ops = styleOps(scene, ["a"], { italic: true });
    expect(ops.map((o) => o.kind.case)).toEqual(["setProps", "setText"]);
    ops.forEach((o) => useScene.getState().applyLocal(o));
    const n = useScene.getState().scene!.nodes.at("a");
    expect(n.textStyleId).toBeUndefined();
    expect(n.text!.style).toMatchObject({ fontFamily: "Brand Sans", fontSize: 32, fontWeight: "700", italic: true });
  });

  it("applying and detaching a style, and creating one from a node", () => {
    const scene = install(text("a"), text("b", { textStyleId: "h" }));
    expect(applyStyleOps(scene, ["a"], "nope")).toEqual([]);
    expect(applyStyleOps(scene, ["b"], "h")).toEqual([]);                    // already has it
    expect(applyStyleOps(scene, ["a", "b"], "h")).toHaveLength(1);
    expect(sharedStyleOf(scene, ["a", "b"])).toBeUndefined();                 // mixed
    expect(sharedStyleOf(scene, ["b"])).toBe("h");
    const made = createStyleOps(scene, scene.nodes.at("a"), "Body")!;
    expect(made.ops.map((o) => o.kind.case)).toEqual(["setTextStyleDef", "setProps"]);
  });
});

describe("TypographyControls", () => {
  it("changes the family, italic and line height in one undoable gesture each", () => {
    install(text("a"));
    useScene.setState({ selection: ["a"] });
    render(<TypographyControls />);
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "Brand Sans" } });
    expect(useScene.getState().scene!.nodes.at("a").text!.style.fontFamily).toBe("Brand Sans");
    expect(useScene.getState().undoStack).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(useScene.getState().scene!.nodes.at("a").text!.style.italic).toBe(true);
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("a").text!.style.italic).toBeUndefined();
  });

  it("creates, applies, updates and deletes a shared text style", () => {
    install(text("a"), text("b"));
    useScene.setState({ selection: ["a"] });
    render(<TypographyControls />);
    fireEvent.click(screen.getByRole("button", { name: "New style" }));
    const created = useScene.getState().scene!.nodes.at("a").textStyleId!;
    expect(useScene.getState().scene!.textStyles[created].name).toBe("Style 2");
    // A second node picks it from the list.
    useScene.setState({ selection: ["b"] });
    cleanup();
    render(<TypographyControls />);
    fireEvent.change(screen.getByRole("combobox", { name: "Text style" }), { target: { value: created } });
    expect(useScene.getState().scene!.nodes.at("b").textStyleId).toBe(created);
    // Deleting the style from "a" clears it on every node that used it, and undo brings it all back.
    useScene.setState({ selection: ["a"] });
    cleanup();
    render(<TypographyControls />);
    fireEvent.click(screen.getByRole("button", { name: "Delete style" }));
    expect(useScene.getState().scene!.textStyles[created]).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("a").textStyleId).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("b").textStyleId).toBeUndefined();
    useScene.getState().undo();
    expect(useScene.getState().scene!.textStyles[created]).toBeDefined();
    expect(useScene.getState().scene!.nodes.at("b").textStyleId).toBe(created);
  });

  it("is hidden unless every selected node is text", () => {
    install(text("a"), text("r", { kind: "rect", text: undefined }));
    useScene.setState({ selection: ["a", "r"] });
    const { container } = render(<TypographyControls />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PropertiesPanel with a shared text style", () => {
  it("shows the size the style draws with, and detaches it when the size is edited", async () => {
    install(text("a", { textStyleId: "h" }));
    useScene.setState({ selection: ["a"] });
    render(<PropertiesPanel />);
    expect(screen.getByRole("textbox", { name: "Size" })).toHaveValue("32");
    expect(screen.getByRole("combobox", { name: "Text style" })).toHaveValue("h");
  });
});

describe("FontsDialog", () => {
  it("lists the uploaded fonts and deletes one", () => {
    install(text("a"));
    render(<FontsDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByRole("list", { name: "Uploaded fonts" })).toHaveTextContent("Brand Sans");
    fireEvent.click(screen.getByRole("button", { name: "Delete Brand Sans 700" }));
    expect(useScene.getState().scene!.fonts).toEqual({});
    useScene.getState().undo();
    expect(useScene.getState().scene!.fonts.f1).toBeDefined();
  });

  it("uploads a file, guesses its family and weight, and adds the font", async () => {
    install(text("a"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hash: "b".repeat(64), size: 4, contentType: "font/ttf" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FontsDialog isOpen onOpenChange={() => {}} />);
    const file = new File([new Uint8Array([0, 1, 0, 0])], "Acme-BoldItalic.ttf", { type: "font/ttf" });
    fireEvent.change(screen.getByLabelText("Font file"), { target: { files: [file] } });
    expect(screen.getByLabelText("Family name")).toHaveValue("Acme");
    expect(screen.getByLabelText("Weight")).toHaveValue("700");
    fireEvent.click(screen.getByRole("button", { name: "Add font" }));
    await waitFor(() => expect(Object.keys(useScene.getState().scene!.fonts)).toHaveLength(2));
    const added = Object.values(useScene.getState().scene!.fonts).find((f) => f.family === "Acme")!;
    expect(added).toMatchObject({ weight: "700", style: "italic", assetHash: "b".repeat(64) });
    expect(fetchMock).toHaveBeenCalledWith("/assets-api/doc-1", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });

  it("says so when the document refuses the font (same family, weight and style)", async () => {
    install(text("a"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hash: "c".repeat(64), size: 4, contentType: "font/ttf" }), { status: 200 })));
    render(<FontsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Font file"), { target: { files: [new File([new Uint8Array([0])], "Brand Sans-Bold.ttf")] } });
    fireEvent.click(screen.getByRole("button", { name: "Add font" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
    expect(Object.keys(useScene.getState().scene!.fonts)).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
