import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { TextEditorOverlay } from "./TextEditorOverlay";
import { StylesDialog } from "./StylesDialog";
import { TypographyControls } from "./TypographyControls";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite, type TextStyleDefLite } from "../store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
const STYLE = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const PARA: TextStyleDefLite = { id: "h1", name: "Heading", style: { ...STYLE, fontSize: 32, fontWeight: "700" }, spaceAfter: 8, nextStyleId: "body" };
const BODY: TextStyleDefLite = { id: "body", name: "Body", style: { ...STYLE, fontSize: 14 } };
const EM: TextStyleDefLite = { id: "em", name: "Emphasis", kind: "character", style: { ...STYLE, fontSize: 0, italic: true } };

function install(content: string, extra: Partial<NodeLite["text"] & object> = {}) {
  const scene = emptyScene("doc-1", "Untitled");
  scene.textStyles = { h1: PARA, body: BODY, em: EM };
  const n: NodeLite = {
    id: "t1", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1, x: 10, y: 20, width: 200, height: 24, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: STYLE, ...extra },
  };
  scene.nodes = scene.nodes.set("t1", n);
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null, undoStack: [], redoStack: [] });
}
const text = () => useScene.getState().scene!.nodes.at("t1")!.text!;
afterEach(cleanup);

describe("the text editor's style pickers", () => {
  beforeEach(() => {
    install("Title\nBody text");
    useScene.setState({ editingNodeId: "t1" });
  });

  it("applies a paragraph style to the paragraphs the selection touches and writes it on commit", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = screen.getByRole("textbox", { name: "Text content" }) as HTMLTextAreaElement;
    ta.setSelectionRange(2, 2);
    fireEvent.select(ta);
    fireEvent.change(screen.getByLabelText("Paragraph style"), { target: { value: "h1" } });
    // The first paragraph only (the caret is in it).
    fireEvent.blur(ta);
    expect(text().paragraphStyles).toEqual(["h1"]);
  });

  it("applies a character style to the selected characters, and not to a bare caret", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = screen.getByRole("textbox", { name: "Text content" }) as HTMLTextAreaElement;
    ta.setSelectionRange(2, 2);
    fireEvent.select(ta);
    expect(screen.getByLabelText("Character style")).toBeDisabled();
    ta.setSelectionRange(6, 10);
    fireEvent.select(ta);
    fireEvent.change(screen.getByLabelText("Character style"), { target: { value: "em" } });
    fireEvent.blur(ta);
    expect(text().runs).toEqual([{ start: 6, end: 10, styleId: "em" }]);
  });

  it("keeps the formatting attached to its characters while typing, and Enter at the end gives the next style", () => {
    install("Title", { paragraphStyles: ["h1"], runs: [{ start: 0, end: 5, styleId: "em" }] });
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = screen.getByRole("textbox", { name: "Text content" }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "Title\n" } });
    fireEvent.blur(ta);
    expect(text().content).toBe("Title\n");
    expect(text().paragraphStyles).toEqual(["h1", "body"]);
    expect(text().runs).toEqual([{ start: 0, end: 5, styleId: "em" }]);
  });

  it("is one undo step", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = screen.getByRole("textbox", { name: "Text content" }) as HTMLTextAreaElement;
    ta.setSelectionRange(0, 5);
    fireEvent.select(ta);
    fireEvent.change(screen.getByLabelText("Character style"), { target: { value: "em" } });
    fireEvent.blur(ta);
    expect(text().runs).toHaveLength(1);
    useScene.getState().undo();
    expect(text().runs).toBeUndefined();
  });

  it("shows no picker when the document has no styles", () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, textStyles: {} });
    render(<TextEditorOverlay nodeId="t1" />);
    expect(screen.queryByLabelText("Paragraph style")).toBeNull();
  });
});

describe("TypographyControls: whole-text formatting and decorations", () => {
  beforeEach(() => install("one\ntwo"));

  it("sets a paragraph style on every paragraph and a character style on the whole text", () => {
    useScene.getState().setSelection(["t1"]);
    render(<TypographyControls />);
    fireEvent.change(screen.getByLabelText("Paragraph style"), { target: { value: "h1" } });
    expect(text().paragraphStyles).toEqual(["h1", "h1"]);
    fireEvent.change(screen.getByLabelText("Character style"), { target: { value: "em" } });
    expect(text().runs).toEqual([{ start: 0, end: 7, styleId: "em" }]);
    fireEvent.change(screen.getByLabelText("Paragraph style"), { target: { value: "" } });
    expect(text().paragraphStyles).toBeUndefined();
  });

  it("toggles underline and strikethrough on the text's own style", () => {
    useScene.getState().setSelection(["t1"]);
    render(<TypographyControls />);
    fireEvent.click(screen.getByRole("button", { name: "Underline" }));
    expect(text().style.underline).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));
    expect(text().style.strikethrough).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Underline" }));
    expect(text().style.underline).toBeUndefined();
  });
});

describe("StylesDialog", () => {
  beforeEach(() => install("x"));
  const styles = () => useScene.getState().scene!.textStyles;
  const open = () => render(<StylesDialog isOpen onOpenChange={() => {}} />);

  it("lists paragraph and character styles apart and creates new ones", () => {
    open();
    expect(screen.getByRole("list", { name: "Paragraph styles" })).toHaveTextContent("Heading");
    expect(screen.getByRole("list", { name: "Character styles" })).toHaveTextContent("Emphasis");
    fireEvent.click(screen.getByRole("button", { name: "New character style" }));
    const created = Object.values(styles()).find((d) => d.name === "Character style 2")!;
    expect(created.kind).toBe("character");
    fireEvent.click(screen.getByRole("button", { name: "New paragraph style" }));
    expect(Object.values(styles()).some((d) => d.name === "Paragraph style 3" && d.kind === undefined)).toBe(true);
  });

  it("edits a style: a checkbox, a select, the based-on link", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Heading" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Underline" }));
    expect(styles().h1.style.underline).toBe(true);
    fireEvent.change(screen.getByLabelText("Alignment"), { target: { value: "center" } });
    expect(styles().h1.style.align).toBe("center");
    fireEvent.change(screen.getByLabelText("Based on"), { target: { value: "body" } });
    expect(styles().h1.basedOn).toBe("body");
    // body based on h1 would close a loop: refused, said so, left as it was.
    fireEvent.click(screen.getByRole("button", { name: "Body" }));
    fireEvent.change(screen.getByLabelText("Based on"), { target: { value: "h1" } });
    expect(styles().body.basedOn).toBeUndefined();
    expect(screen.getByRole("alert")).toHaveTextContent(/did not accept/);
  });

  it("offers only styles of the same kind as base and only paragraph styles as next style", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Emphasis" }));
    const based = screen.getByLabelText("Based on") as HTMLSelectElement;
    expect(Array.from(based.options).map((o) => o.textContent)).toEqual(["Not based on another style"]);
    expect(screen.queryByLabelText("Next style")).toBeNull();
    expect(screen.queryByLabelText("Alignment")).toBeNull();
  });

  it("deletes a style in one step, and the text keeps pointing at the id (ignored while it is gone)", () => {
    install("x", { paragraphStyles: ["h1"] });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Heading" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete style" }));
    expect(styles().h1).toBeUndefined();
    expect(text().paragraphStyles).toEqual(["h1"]);
    useScene.getState().undo();
    expect(styles().h1).toBeDefined();
  });
});

describe("tracking and the baseline grid in the UI", () => {
  beforeEach(() => install("one\ntwo"));

  it("sets and clears tracking on the text's own style", () => {
    useScene.getState().setSelection(["t1"]);
    render(<TypographyControls />);
    const field = screen.getByRole("textbox", { name: "Tracking" });
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.blur(field);
    expect(text().style.letterSpacing).toBe(2);
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(text().style.letterSpacing).toBeUndefined();
  });

  it("the Styles dialog edits a style's tracking and its grid alignment", () => {
    render(<StylesDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Heading" }));
    const tracking = screen.getByRole("textbox", { name: "Tracking" });
    fireEvent.change(tracking, { target: { value: "-1" } });
    fireEvent.blur(tracking);
    fireEvent.click(screen.getByRole("checkbox", { name: "Align to baseline grid" }));
    const stored = useScene.getState().scene!.textStyles.h1;
    expect(stored.style.letterSpacing).toBe(-1);
    expect(stored.alignToGrid).toBe(true);
    // A character style has no grid option.
    fireEvent.click(screen.getByRole("button", { name: "Emphasis" }));
    expect(screen.queryByRole("checkbox", { name: "Align to baseline grid" })).toBeNull();
  });
});

describe("typesetting controls", () => {
  beforeEach(() => install("one\ntwo"));
  const styles = () => useScene.getState().scene!.textStyles;

  it("toggles small caps, superscript and the width of a text", () => {
    useScene.getState().setSelection(["t1"]);
    render(<TypographyControls />);
    fireEvent.click(screen.getByRole("button", { name: "Small caps" }));
    expect(text().style.smallCaps).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Superscript" }));
    expect(text().style.script).toBe("super");
    fireEvent.click(screen.getByRole("button", { name: "Subscript" }));
    expect(text().style.script).toBe("sub");
    fireEvent.click(screen.getByRole("button", { name: "Subscript" }));
    expect(text().style.script).toBeUndefined();
    const width = screen.getByRole("textbox", { name: "Width" });
    fireEvent.change(width, { target: { value: "120" } });
    fireEvent.blur(width);
    expect(text().style.horizontalScale).toBeCloseTo(1.2);
    fireEvent.click(screen.getByRole("button", { name: "Small caps" }));
    expect(text().style.smallCaps).toBeUndefined();
  });

  it("the Styles dialog edits lists, tabs, drop caps, hyphenation and nested styles", () => {
    render(<StylesDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Heading" }));
    fireEvent.change(screen.getByLabelText("Alignment"), { target: { value: "justify" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hyphenate" }));
    fireEvent.change(screen.getByLabelText("List"), { target: { value: "number" } });
    fireEvent.change(screen.getByLabelText("Number style"), { target: { value: "i" } });
    const tabs = screen.getByLabelText("Tab stops");
    fireEvent.change(tabs, { target: { value: "300 right ., 40" } });
    fireEvent.blur(tabs);
    const lines = screen.getByRole("textbox", { name: "Drop cap lines" });
    fireEvent.change(lines, { target: { value: "3" } });
    fireEvent.blur(lines);
    fireEvent.click(screen.getByRole("button", { name: "Add a nested style" }));
    const h1 = styles().h1;
    expect(h1).toMatchObject({ listKind: "number", listNumberStyle: "i", hyphenate: true, dropCapLines: 3 });
    expect(h1.style.align).toBe("justify");
    expect(h1.tabStops).toEqual([{ position: 40 }, { position: 300, align: "right", leader: "." }]);
    expect(h1.nestedStyles).toEqual([{ styleId: "em", delimiter: ":", count: 1, inclusive: true }]);
    // A character style gets the glyph fields but no paragraph features.
    fireEvent.click(screen.getByRole("button", { name: "Emphasis" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Small caps" }));
    expect(styles().em.style.smallCaps).toBe(true);
    expect(screen.queryByLabelText("List")).toBeNull();
  });
});
