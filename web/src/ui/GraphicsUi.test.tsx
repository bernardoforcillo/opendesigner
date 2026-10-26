import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { LayersDialog } from "@/ui/LayersDialog";
import { LinksDialog } from "@/ui/LinksDialog";
import { ObjectStylesDialog } from "@/ui/ObjectStylesDialog";
import { SwatchesDialog } from "@/ui/SwatchesDialog";
import { ImageLinkControls, LayerControls, ObjectStyleControls } from "@/ui/GraphicsControls";
import { AnchorControls } from "@/ui/TextLayoutControls";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
const STYLE = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a" + over.id, name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 1, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
function install(nodes: NodeLite[], extra: Partial<SceneState> = {}) {
  const scene = nodes.reduce((s, n) => ({ ...s, nodes: s.nodes.set(n.id, n) }), { ...emptyScene("d", "d"), ...extra });
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: "page1", selection: [], gesture: null, undoStack: [], redoStack: [], camera: { x: 0, y: 0, zoom: 1 } });
}
const scene = () => useScene.getState().scene!;
afterEach(cleanup);

describe("SwatchesDialog", () => {
  beforeEach(() => install([node({ id: "a" })]));
  const open = () => render(<SwatchesDialog isOpen onOpenChange={() => {}} />);

  it("makes a swatch, edits its CMYK, adds a tint, and uses it for the fill", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "New swatch" }));
    const v = () => Object.values(scene().variables).filter((x) => x.swatch);
    expect(v()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Defined in CMYK"));
    const m = screen.getByRole("textbox", { name: "M" });
    fireEvent.change(m, { target: { value: "100" } });
    fireEvent.blur(m);
    expect(v()[0].cmyk).toMatchObject({ m: 1 });
    fireEvent.click(screen.getByRole("button", { name: "New tint of this swatch" }));
    expect(v()).toHaveLength(2);
    expect(v().find((x) => x.tintOf)).toMatchObject({ tint: 50 });
    act(() => useScene.setState({ selection: ["a"] }));
    fireEvent.click(screen.getByRole("button", { name: "Use for fill" }));
    expect(scene().nodes.get("a")!.bindings).toEqual({ "fills.0": v().find((x) => x.tintOf)!.id }); // the tint was selected after it was made
  });

  it("switches the document to CMYK and records the output profile", () => {
    open();
    fireEvent.change(screen.getByLabelText("Colour mode"), { target: { value: "cmyk" } });
    expect(scene().settings?.colorMode).toBe("cmyk");
    const profile = screen.getByLabelText("Output profile");
    fireEvent.change(profile, { target: { value: "FOGRA39" } });
    fireEvent.blur(profile);
    expect(scene().settings).toMatchObject({ colorMode: "cmyk", iccProfile: "FOGRA39" });
    fireEvent.click(screen.getByRole("button", { name: "New swatch" }));
    expect(Object.values(scene().variables).find((x) => x.swatch)!.cmyk).toBeDefined(); // CMYK documents make CMYK swatches
  });
});

describe("ObjectStylesDialog and controls", () => {
  beforeEach(() => install([node({ id: "a", opacity: 0.5, cornerRadius: 4 }), node({ id: "b" })]));

  it("makes a style from the selection, applies it to another shape and redefines it once", () => {
    useScene.setState({ selection: ["a"] });
    render(<ObjectStylesDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New from selection" }));
    const id = Object.keys(scene().objectStyles)[0];
    expect(scene().nodes.get("a")!.objectStyleId).toBe(id);
    act(() => useScene.setState({ selection: ["b"] }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to selection" }));
    expect(scene().nodes.get("b")!.objectStyleId).toBe(id);
    fireEvent.click(screen.getByLabelText("Corner radius"));
    expect(scene().objectStyles[id].sets).not.toContain("corner_radius");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(scene().objectStyles[id]).toBeUndefined();
    expect(scene().nodes.get("b")!.objectStyleId).toBeUndefined();
  });

  it("the panel's picker applies and detaches a style", () => {
    useScene.setState({ selection: ["a"] });
    const { unmount } = render(<ObjectStyleControls />);
    fireEvent.click(screen.getByRole("button", { name: "New style from this" }));
    unmount();
    useScene.setState({ selection: ["a", "b"] });
    render(<ObjectStyleControls />);
    expect(screen.getByLabelText("Object style")).toHaveValue("__mixed");
    const id = Object.keys(scene().objectStyles)[0];
    fireEvent.change(screen.getByLabelText("Object style"), { target: { value: id } });
    expect(scene().nodes.get("b")!.objectStyleId).toBe(id);
    fireEvent.change(screen.getByLabelText("Object style"), { target: { value: "" } });
    expect(scene().nodes.get("a")!.objectStyleId).toBeUndefined();
  });

  it("offers no object style for a group", () => {
    install([node({ id: "g", kind: "group" })]);
    useScene.setState({ selection: ["g"] });
    expect(render(<ObjectStyleControls />).container).toBeEmptyDOMElement();
  });
});

describe("LayersDialog and controls", () => {
  beforeEach(() => install([node({ id: "a" })], { pages: [{ id: "page1", name: "One" }] }));

  it("creates a layer, moves the selection onto it, hides and locks it", () => {
    useScene.setState({ selection: ["a"] });
    render(<LayersDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New layer" }));
    const [layer] = scene().layers;
    expect(layer.name).toBe("Layer 1");
    fireEvent.click(screen.getByRole("button", { name: "Move selection here" }));
    expect(scene().nodes.get("a")!.layerId).toBe(layer.id);
    fireEvent.click(screen.getByLabelText("Locked: Layer 1"));
    fireEvent.click(screen.getByLabelText("Hidden: Layer 1"));
    expect(scene().layers[0]).toMatchObject({ locked: true, hidden: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(scene().layers).toHaveLength(0);
    expect(scene().nodes.get("a")!.layerId).toBeUndefined();
  });

  it("the panel's picker puts the selection on a layer", () => {
    install([node({ id: "a" })], { layers: [{ id: "l", name: "Art" }] });
    useScene.setState({ selection: ["a"] });
    render(<LayerControls />);
    fireEvent.change(screen.getByLabelText("Layer"), { target: { value: "l" } });
    expect(scene().nodes.get("a")!.layerId).toBe("l");
  });
});

describe("links", () => {
  const img = node({ id: "img", kind: "image", fills: [], width: 144, height: 72, image: { assetHash: "a".repeat(64), originalName: "photo.jpg", pixelWidth: 288, pixelHeight: 144 } });
  it("shows the file, the size and a low-resolution warning, and fits the image", () => {
    install([img]);
    useScene.setState({ selection: ["img"] });
    render(<ImageLinkControls />);
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
    expect(screen.getByText(/288 × 144 px · 144 ppi/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/under 150 ppi/);
    fireEvent.click(screen.getByRole("button", { name: "Print size (300 ppi)" }));
    expect(scene().nodes.get("img")).toMatchObject({ width: 69.12, height: 34.56 });
  });
  it("lists every image and opens it on its page", () => {
    install([img, node({ id: "img2", kind: "image", fills: [], parentId: "page2", image: { assetHash: "b".repeat(64), originalName: "two.png" } })], { pages: [{ id: "page1", name: "One" }, { id: "page2", name: "Two" }] });
    render(<LinksDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(/1 image is under 150 ppi/);
    fireEvent.click(screen.getByRole("button", { name: "Show img2" }));
    expect(useScene.getState().currentPageId).toBe("page2");
    expect(useScene.getState().selection).toEqual(["img2"]);
  });
});

describe("AnchorControls", () => {
  it("anchors an object in a text and releases it", () => {
    install([node({ id: "t", kind: "text", fills: [], text: { content: "hello", style: STYLE } }), node({ id: "pic12345xyz" })]);
    useScene.setState({ selection: ["t", "pic12345xyz"] });
    const { unmount } = render(<AnchorControls />);
    fireEvent.click(screen.getByRole("button", { name: "Anchor the object in the text" }));
    expect(scene().nodes.get("t")!.text!.content).toBe("hello[@pic12345]");
    unmount();
    useScene.setState({ selection: ["t"] });
    render(<AnchorControls />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(scene().nodes.get("t")!.text!.content).toBe("hello");
  });
});
