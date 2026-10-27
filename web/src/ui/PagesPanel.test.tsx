import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { PagesPanel } from "@/ui/PagesPanel";
import { useScene } from "@/store/store";
import { emptyScene, type SceneState } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function install(scene: SceneState) {
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: scene.pages[0].id, gesture: null, undoStack: [], redoStack: [] });
}
const sheet = { width: 400, height: 600 };
const book = (): SceneState => ({
  ...emptyScene("d", "Book"),
  settings: { vertical: "publishing" },
  pages: [
    { id: "page1", name: "Cover", ...sheet },
    { id: "m1", name: "A-Master", isMaster: true, ...sheet },
    { id: "p2", name: "Chapter", masterId: "m1", ...sheet, marginLeft: 40 },
    { id: "p3", name: "Next", masterId: "m1", ...sheet },
  ],
});
afterEach(cleanup);

describe("PagesPanel", () => {
  beforeEach(() => install(book()));

  it("lists the pages numbered without counting masters, and the masters apart", () => {
    render(<PagesPanel />);
    const pages = within(screen.getByRole("list", { name: "Pages" })).getAllByRole("button");
    expect(pages.map((b) => b.textContent)).toEqual(["1Cover", "2ChapterA", "3NextA"]);
    expect(within(screen.getByRole("list", { name: "Masters" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["AA-Master"]);
  });

  it("marks the page on screen and opens another on a click", () => {
    render(<PagesPanel />);
    expect(screen.getByRole("button", { name: "Open Cover" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Open Chapter" }));
    expect(useScene.getState().currentPageId).toBe("p2");
    expect(screen.getByRole("button", { name: "Open Chapter" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Open A-Master" }));
    expect(useScene.getState().currentPageId).toBe("m1");
  });

  it("adds a page like the one on screen (same sheet and master) and opens it", () => {
    useScene.setState({ currentPageId: "p2" });
    render(<PagesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Page" }));
    const pages = useScene.getState().scene!.pages;
    const added = pages[pages.length - 1];
    expect(added).toMatchObject({ name: "Page 4", masterId: "m1", width: 400, height: 600, marginLeft: 40 });
    expect(useScene.getState().currentPageId).toBe(added.id);
    useScene.getState().undo();
    expect(useScene.getState().scene!.pages).toHaveLength(4);
  });

  it("adds a master named by letter and opens page setup", () => {
    render(<PagesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Master" }));
    const added = useScene.getState().scene!.pages.at(-1)!;
    expect(added).toMatchObject({ name: "B-Master", isMaster: true, width: 400 });
    fireEvent.click(screen.getByRole("button", { name: "Setup…" }));
    expect(screen.getByRole("dialog", { name: "Page setup" })).toBeInTheDocument();
  });

  it("renders a thumbnail with the master's content on the pages that apply it", () => {
    const s = book();
    s.nodes = s.nodes.set("band", { id: "band", parentId: "m1", orderKey: "a0", name: "band", visible: true, opacity: 1, x: 0, y: 0, width: 400, height: 20, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false });
    install(s);
    const { container } = render(<PagesPanel />);
    // The master's own thumbnail and each page that applies it show the red band; the cover does not.
    const red = (btn: string) => screen.getByRole("button", { name: btn }).querySelectorAll('rect[fill="rgb(255 0 0)"]').length;
    expect(red("Open A-Master")).toBe(1);
    expect(red("Open Chapter")).toBe(1);
    expect(red("Open Cover")).toBe(0);
    expect(container.querySelectorAll('svg[viewBox="0 0 400 600"]').length).toBe(4);
  });

  it("renders nothing without a document", () => {
    useScene.getState().setScene(null);
    const { container } = render(<PagesPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("duplicates the page on screen right after it and opens the copy", () => {
    render(<PagesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const pages = useScene.getState().scene!.pages;
    expect(pages.map((p) => p.name)).toEqual(["Cover", "Cover copy", "A-Master", "Chapter", "Next"]);
    expect(useScene.getState().currentPageId).toBe(pages[1].id);
  });

  it("moves the page on screen later and earlier", () => {
    render(<PagesPanel />);
    expect(screen.getByRole("button", { name: "Move page earlier" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move page later" }));
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["m1", "page1", "p2", "p3"]);
    fireEvent.click(screen.getByRole("button", { name: "Move page earlier" }));
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1", "m1", "p2", "p3"]);
  });

  it("lays the pages out as spreads with facing pages, numbered by section", () => {
    cleanup();
    install({ ...book(), settings: { vertical: "publishing", facingPages: true } });
    render(<PagesPanel />);
    const spreads = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-label")?.startsWith("Spread"));
    expect(spreads.map((li) => li.getAttribute("aria-label"))).toEqual(["Spread 1", "Spread 2–3"]);
  });
});
