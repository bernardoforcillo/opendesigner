import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useScene } from "../store/store";
import { useCommentsUi } from "../store/commentsUi";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { CommentsPanel } from "./CommentsPanel";
import { createCommentTool } from "../tools/commentTool";
import type { ToolContext } from "../tools/types";

const sync = {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  },
};

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null });
  useScene.getState().setScene({
    ...emptyScene("d", "t"),
    nodes: nodesOf({
      f: {
        id: "f", parentId: "page1", orderKey: "a0", name: "Card", visible: true, opacity: 1, x: 100, y: 50, width: 200, height: 100, rotation: 0,
        fills: [{ r: 1, g: 1, b: 1, a: 1 }], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: false,
      },
    }),
  });
  useScene.setState({ sync: sync as never, currentPageId: "page1" });
  useCommentsUi.setState({ draft: null, activeId: null, showResolved: false });
});
afterEach(cleanup);

describe("CommentsPanel", () => {
  it("a placed pin asks for its text; sending creates the thread and opens it", () => {
    useCommentsUi.getState().setDraft({ nodeId: "f", pageId: "", x: 10, y: 20 });
    render(<CommentsPanel />);
    fireEvent.change(screen.getByLabelText("New comment"), { target: { value: "Radius is off" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const comments = Object.values(useScene.getState().scene!.comments);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ nodeId: "f", x: 10, y: 20, text: "Radius is off", resolved: false, parentId: "" });
    expect(useCommentsUi.getState().draft).toBeNull();
    expect(useCommentsUi.getState().activeId).toBe(comments[0].id);
  });

  it("an empty text is not sent", () => {
    useCommentsUi.getState().setDraft({ nodeId: "", pageId: "page1", x: 0, y: 0 });
    render(<CommentsPanel />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("reply, resolve (hides the thread), show resolved, reopen and delete", () => {
    useCommentsUi.getState().setDraft({ nodeId: "", pageId: "page1", x: 5, y: 5 });
    const { rerender } = render(<CommentsPanel />);
    fireEvent.change(screen.getByLabelText("New comment"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    rerender(<CommentsPanel />);
    fireEvent.change(screen.getByLabelText(/Reply to/), { target: { value: "Answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(Object.values(useScene.getState().scene!.comments)).toHaveLength(2);
    expect(screen.getByText("Answer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(Object.values(useScene.getState().scene!.comments).filter((c) => c.resolved)).toHaveLength(1);
    useCommentsUi.getState().setActive(null);
    rerender(<CommentsPanel />);
    expect(screen.queryByText("First")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show resolved"));
    expect(screen.getByText("First")).toBeInTheDocument();

    fireEvent.click(screen.getByText("First"));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(Object.values(useScene.getState().scene!.comments).some((c) => c.resolved)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete thread" }));
    expect(Object.keys(useScene.getState().scene!.comments)).toHaveLength(0);
  });
});

describe("comment tool", () => {
  const ctx = (): ToolContext => ({
    getScene: () => useScene.getState().scene,
    getCamera: () => ({ x: 0, y: 0, zoom: 1 }),
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext);
  const click = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;

  it("a click on a node starts a draft attached to it, in the node's own coordinates", () => {
    createCommentTool().onPointerDown!(click(150, 80), ctx());
    expect(useCommentsUi.getState().draft).toEqual({ nodeId: "f", pageId: "", x: 50, y: 30 });
    expect(useCommentsUi.getState().revealRequested).toBeGreaterThan(0);
  });

  it("a click on empty canvas starts a free draft on the page; Escape drops it", () => {
    const tool = createCommentTool();
    tool.onPointerDown!(click(900, 900), ctx());
    expect(useCommentsUi.getState().draft).toEqual({ nodeId: "", pageId: "page1", x: 900, y: 900 });
    tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx());
    expect(useCommentsUi.getState().draft).toBeNull();
  });

  it("a click on an existing pin opens its thread instead of starting a new one", () => {
    useScene.getState().apply({
      kind: { case: "setComment", value: { comment: { id: "c1", parentId: "", nodeId: "", pageId: "page1", x: 500, y: 500, author: "A", text: "hi", createdAt: 1n, resolved: false } } },
    } as unknown as Op);
    createCommentTool().onPointerDown!(click(500, 490), ctx());
    expect(useCommentsUi.getState().activeId).toBe("c1");
    expect(useCommentsUi.getState().draft).toBeNull();
  });
});
