// jest-dom's matchers are already installed by the setupFiles (vite.config.ts);
// the import here serves TYPE-SCRIPT (tsc -b does not read the setupFiles), otherwise
// toBeDisabled/toHaveAttribute do not exist for the compiler.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PageBar } from "./PageBar";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// SyncClient double: records the ops on the wire and models a server that accepts
// and ECHOES at once (applyPending + apply), like in the tool tests. It serves to
// count "one op per action" and to advance the confirmed document.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function twoPageScene(): SceneState {
  return {
    ...emptyScene("doc1", "Untitled"),
    pages: [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }],
  };
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    selection: [],
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
  useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

describe("PageBar", () => {
  it("shows a button per page and marks the current one", () => {
    useScene.getState().setScene(twoPageScene());
    render(<PageBar />);
    // The pages are in a popover: the trigger (the current one's name) opens it.
    fireEvent.click(screen.getByRole("button", { name: "Page 1" }));
    const p1 = screen.getByRole("button", { name: "Page 1" });
    const p2 = screen.getByRole("button", { name: "Page 2" });
    expect(p1).toBeInTheDocument();
    expect(p2).toBeInTheDocument();
    // The current one (page1 by default) is marked with aria-current.
    expect(p1).toHaveAttribute("aria-current", "page");
    expect(p2).not.toHaveAttribute("aria-current");
  });

  it("clicking a tab changes the current page and the selection is cleared", () => {
    useScene.getState().setScene(twoPageScene());
    useScene.setState({ selection: ["z"] });
    render(<PageBar />);
    fireEvent.click(screen.getByRole("button", { name: "Page 1" })); // opens the list
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(useScene.getState().currentPageId).toBe("page2");
    expect(useScene.getState().selection).toEqual([]);
  });

  it("«+» creates ONE page (a single CreatePage) and we move onto it", () => {
    render(<PageBar />);
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("createPage");
    const pages = useScene.getState().scene!.pages;
    expect(pages).toHaveLength(2);
    expect(pages[1].name).toBe("Page 2");
    // We moved onto the newly created page.
    expect(useScene.getState().currentPageId).toBe(pages[1].id);
  });

  it("«Delete» is disabled with a single page (the core rejects the last one)", () => {
    render(<PageBar />);
    expect(screen.getByRole("button", { name: "Delete page" })).toBeDisabled();
  });

  it("«Delete» removes the current page when there is more than one (a single DeletePage)", () => {
    useScene.getState().setScene(twoPageScene());
    useScene.getState().setCurrentPage("page2");
    render(<PageBar />);
    const del = screen.getByRole("button", { name: "Delete page" });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deletePage");
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1"]);
    // The vanished current page falls back to the remaining one.
    expect(useScene.getState().currentPageId).toBe("page1");
  });

  it("double click on the name opens rename; Enter sends ONE RenamePage", () => {
    render(<PageBar />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 1" }));
    const field = screen.getByRole("textbox", { name: "Page name" });
    fireEvent.change(field, { target: { value: "Cover" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("renamePage");
    expect(useScene.getState().scene!.pages[0].name).toBe("Cover");
  });

  it("renaming with the same name sends no op", () => {
    render(<PageBar />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 1" }));
    const field = screen.getByRole("textbox", { name: "Page name" });
    fireEvent.keyDown(field, { key: "Enter" }); // unchanged value
    expect(sync.sent).toHaveLength(0);
  });
});
