import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { ModeTabs } from "@/ui/shell/ModeTabs";
import { PagesList } from "@/ui/shell/PagesList";
import { useFlowUi } from "@/store/flowUi";
import { useScene } from "@/store/store";
import { emptyScene, type SceneState } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
const doc = (vertical?: "design"): SceneState => ({
  ...emptyScene("d", "D"),
  ...(vertical ? { settings: { vertical } } : {}),
  pages: [{ id: "page1", name: "Home" }, { id: "page2", name: "Settings" }, { id: "m", name: "A-Master", isMaster: true }],
});
beforeEach(() => {
  useScene.getState().setScene(doc());
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: "page1", gesture: null, undoStack: [], redoStack: [] });
  useFlowUi.getState().setMode("design");
});
afterEach(cleanup);

describe("ModeTabs", () => {
  it("offers the modes of the document and switches the mode", () => {
    render(<ModeTabs />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Board", "Design", "Flows", "Develop"]);
    fireEvent.click(screen.getByRole("radio", { name: /Flows/ }));
    expect(useFlowUi.getState().mode).toBe("flows");
  });

  it("a design document has the board and the design mode only", () => {
    useScene.getState().setScene(doc("design"));
    render(<ModeTabs />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Board", "Design"]);
  });
});

describe("PagesList", () => {
  it("lists the pages (not the masters), marks the open one and opens another on a click", () => {
    render(<PagesList />);
    const items = within(screen.getByRole("region", { name: "Pages" })).getAllByRole("button").filter((b) => b.textContent);
    expect(items.map((b) => b.textContent)).toEqual(["Home", "Settings"]);
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useScene.getState().currentPageId).toBe("page2");
  });

  it("adds a page and opens it", () => {
    render(<PagesList />);
    fireEvent.click(screen.getByRole("button", { name: "Add a page" }));
    const pages = useScene.getState().scene!.pages.filter((p) => !p.isMaster);
    expect(pages.map((p) => p.name)).toEqual(["Home", "Settings", "Page 3"]);
    expect(useScene.getState().currentPageId).toBe(pages[2].id);
  });

  it("renames on a double click, and sends nothing for an unchanged name", () => {
    render(<PagesList />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Settings" }));
    const field = screen.getByRole("textbox", { name: "Page name" });
    fireEvent.change(field, { target: { value: "Preferences" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(useScene.getState().scene!.pages.find((p) => p.id === "page2")!.name).toBe("Preferences");
    expect(useScene.getState().undoStack).toHaveLength(1);
  });
});
