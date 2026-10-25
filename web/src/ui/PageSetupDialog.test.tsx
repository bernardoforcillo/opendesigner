import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { PageSetupDialog } from "./PageSetupDialog";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

beforeEach(() => {
  const scene = { ...emptyScene("doc-1", "Book"), pages: [{ id: "page1", name: "Page 1", marginLeft: 10 }, { id: "p2", name: "Page 2" }, { id: "m1", name: "A-Master", isMaster: true }] };
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: "page1", gesture: null, undoStack: [], redoStack: [] });
});
afterEach(cleanup);
const pages = () => useScene.getState().scene!.pages;

describe("PageSetupDialog", () => {
  it("picks a preset size for the page and applies it, one undo step", () => {
    render(<PageSetupDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "a5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(pages()[0]).toMatchObject({ id: "page1", width: 420, height: 595, marginLeft: 10 });
    expect(pages()[1].width).toBeUndefined();
    useScene.getState().undo();
    expect(pages()[0].width).toBeUndefined();
  });

  it("swaps to landscape, and keeps the preset recognised", () => {
    render(<PageSetupDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "a4" } });
    fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
    expect((screen.getByLabelText("Page size") as HTMLSelectElement).value).toBe("a4");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(pages()[0]).toMatchObject({ width: 842, height: 595 });
  });

  it("applies to all pages, masters included", () => {
    render(<PageSetupDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "letter" } });
    fireEvent.click(screen.getByRole("radio", { name: /All 3 pages/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(pages().every((p) => p.width === 612 && p.height === 792)).toBe(true);
    // The shared parts of the pages are kept.
    expect(pages()[2]).toMatchObject({ id: "m1", isMaster: true });
    // A page's own margins are replaced by the dialog's (the dialog showed page 1's).
    expect(pages()[0].marginLeft).toBe(10);
  });

  it("sets the baseline grid of the document", () => {
    render(<PageSetupDialog isOpen onOpenChange={() => {}} />);
    const every = screen.getByRole("textbox", { name: "Every" });
    fireEvent.change(every, { target: { value: "14" } });
    fireEvent.blur(every);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(useScene.getState().scene!.settings).toEqual({ baselineIncrement: 14 });
  });

  it("will not apply a setup that does not fit", () => {
    render(<PageSetupDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "a6" } });
    const right = screen.getByRole("textbox", { name: "Right" });
    fireEvent.change(right, { target: { value: "400" } });
    fireEvent.blur(right);
    expect(screen.getByRole("alert")).toHaveTextContent(/do not fit/);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<PageSetupDialog isOpen={false} onOpenChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
