import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { StylesDialog } from "./StylesDialog";
import { useScene } from "../store/store";
import { emptyScene, type TextStyleDefLite } from "../store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
const STYLE = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const PARA: TextStyleDefLite = { id: "p", name: "Body", style: { ...STYLE, underline: true } };
const CHAR: TextStyleDefLite = { id: "c", name: "Emphasis", kind: "character", style: { ...STYLE, fontSize: 0 } };

beforeEach(() => {
  const scene = emptyScene("doc-1", "Untitled");
  scene.textStyles = { p: PARA, c: CHAR };
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ selection: [], gesture: null, editingNodeId: null, undoStack: [], redoStack: [] });
});
afterEach(cleanup);

const styles = () => useScene.getState().scene!.textStyles;
const open = () => render(<StylesDialog isOpen onOpenChange={() => {}} />);

describe("StylesDialog — type settings", () => {
  it("a paragraph style carries case, script, scale, features, list and indent", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Body" }));
    fireEvent.change(screen.getByLabelText("Text case"), { target: { value: "smallCaps" } });
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "super" } });
    fireEvent.change(screen.getByLabelText("List"), { target: { value: "numbered" } });
    const scale = screen.getByLabelText("Scale %");
    fireEvent.change(scale, { target: { value: "120" } });
    fireEvent.blur(scale);
    const indent = screen.getByLabelText("Indent");
    fireEvent.change(indent, { target: { value: "8" } });
    fireEvent.blur(indent);
    const features = screen.getByLabelText("OpenType features");
    fireEvent.change(features, { target: { value: '"tnum"' } });
    fireEvent.blur(features);
    expect(styles().p.style).toMatchObject({ textCase: "smallCaps", textScript: "super", listKind: "numbered", textScale: 120, indent: 8, fontFeatures: '"tnum"', underline: true });
    // No error banner: the document accepted every edit.
    expect(screen.queryByRole("alert")).toBeNull();
    // A malformed feature string is not written.
    fireEvent.change(features, { target: { value: "nope;" } });
    fireEvent.blur(features);
    expect(styles().p.style.fontFeatures).toBe('"tnum"');
  });

  it("a character style has case, script and scale but no list or indent", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Emphasis" }));
    expect(screen.queryByLabelText("List")).toBeNull();
    expect(screen.queryByLabelText("Indent")).toBeNull();
    fireEvent.change(screen.getByLabelText("Text case"), { target: { value: "upper" } });
    expect(styles().c.style.textCase).toBe("upper");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
