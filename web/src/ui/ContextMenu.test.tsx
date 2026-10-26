import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite } from "@/store/types";
import { ContextMenuHost } from "@/ui/ContextMenu";
import { contextMenuEntries, openContextMenu } from "@/ui/contextMenuItems";
import { useContextMenu, type MenuEntry } from "@/ui/contextMenuStore";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const base = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id.replace(/\d$/, ""), visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

function install() {
  const scene = emptyScene("doc-1", "Untitled");
  scene.pages = [{ id: "page1", name: "One" }, { id: "page2", name: "Two" }];
  const put = (n: NodeLite) => { scene.nodes = scene.nodes.set(n.id, n); };
  put(base("m1", { kind: "frame", orderKey: "m1" }));
  put(base("m2", { kind: "frame", parentId: "page2", width: 200, height: 120 }));
  put(base("i", { kind: "instance", fills: [], orderKey: "i", instance: { componentId: "c1", overrides: [{ masterNodeId: "label", text: "Pay" }] } }));
  put(base("r1", { orderKey: "r1" })); put(base("r2", { orderKey: "r2" })); put(base("r3", { orderKey: "r3" }));
  scene.components = { c1: { rootNodeId: "m1", name: "Button" }, c2: { rootNodeId: "m2", name: "Card" } };
  useScene.getState().setScene(scene);
}

const ids = (entries: readonly MenuEntry[]) => entries.flatMap((e) => (e.type === "separator" ? [] : [e.id]));
const item = (entries: readonly MenuEntry[], id: string) => entries.find((e): e is Extract<MenuEntry, { id: string }> => e.type !== "separator" && e.id === id)!;

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
  useContextMenu.getState().hide();
  install();
});
afterEach(cleanup);

describe("contextMenuEntries", () => {
  it("is empty without a selection", () => {
    expect(contextMenuEntries(useScene.getState().scene!, [])).toEqual([]);
  });

  it("offers the instance actions for instances and only the common ones otherwise", () => {
    const scene = useScene.getState().scene!;
    const forInstance = contextMenuEntries(scene, ["i"]);
    expect(ids(forInstance)).toEqual(expect.arrayContaining(["swap", "reset-overrides", "detach", "go-to-main", "group", "duplicate", "delete"]));
    expect(item(forInstance, "swap").children?.map((c) => (c.type === "separator" ? "" : c.label))).toEqual(["Button", "Card"]);
    expect(item(forInstance, "reset-overrides").disabled).toBe(false);
    const forRects = contextMenuEntries(scene, ["r1", "r2"]);
    expect(ids(forRects)).not.toContain("detach");
    // A mixed selection is not an instance selection.
    expect(ids(contextMenuEntries(scene, ["i", "r1"]))).not.toContain("swap");
    // Ungroup needs a group; group needs something to group; the arrange entries know their limits.
    expect(item(forRects, "ungroup").disabled).toBe(true);
    expect(item(forRects, "group").disabled).toBe(false);
    expect(item(contextMenuEntries(scene, ["r3"]), "front").disabled).toBe(true);
    expect(item(contextMenuEntries(scene, ["i"]), "back").disabled).toBe(true);
    expect(item(contextMenuEntries(scene, ["r1"]), "forward").disabled).toBe(false);
  });

  it("runs the commands as one undoable gesture each", () => {
    const scene = useScene.getState().scene!;
    useScene.setState({ selection: ["r1", "r2"] });
    act(() => item(contextMenuEntries(scene, ["r1", "r2"]), "group").onSelect!());
    expect(useScene.getState().scene!.nodes.at("r1").parentId).not.toBe("page1");
    expect(useScene.getState().undoStack).toHaveLength(1);
    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("r1").parentId).toBe("page1");

    useScene.setState({ selection: ["r3"] });
    act(() => item(contextMenuEntries(useScene.getState().scene!, ["r3"]), "delete").onSelect!());
    expect(useScene.getState().scene!.nodes.at("r3")).toBeUndefined();
    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("r3")).toBeDefined();

    useScene.setState({ selection: ["r1"] });
    act(() => item(contextMenuEntries(useScene.getState().scene!, ["r1"]), "front").onSelect!());
    expect(useScene.getState().scene!.nodes.at("r1").orderKey > "r3").toBe(true);
  });
});

describe("the menu", () => {
  it("opens at the pointer for the node it is on, selecting it unless it is already selected", () => {
    useScene.setState({ selection: ["r1", "r2"] });
    expect(openContextMenu(10, 20, "r2")).toBe(true);
    expect(useScene.getState().selection).toEqual(["r1", "r2"]);
    expect(useContextMenu.getState().open).toMatchObject({ x: 10, y: 20 });
    expect(openContextMenu(10, 20, "r3")).toBe(true);
    expect(useScene.getState().selection).toEqual(["r3"]);
    useContextMenu.getState().hide();
    useScene.setState({ selection: [] });
    expect(openContextMenu(0, 0)).toBe(false);
    expect(useContextMenu.getState().open).toBeNull();
  });

  it("renders, runs an entry and closes; Escape and a click elsewhere close it too", async () => {
    const user = userEvent.setup();
    render(<ContextMenuHost />);
    useScene.setState({ selection: ["i"] });
    act(() => { openContextMenu(5, 5); });
    const menu = screen.getByRole("menu", { name: "Context menu" });
    expect(within(menu).getByRole("menuitem", { name: /Go to main component/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /Detach instance/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useScene.getState().scene!.nodes.at("i").kind).toBe("frame");

    useScene.setState({ selection: ["r1"] });
    act(() => { openContextMenu(5, 5); });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => { openContextMenu(5, 5); });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the swap submenu and swaps; disabled entries do nothing; arrows move the focus", async () => {
    const user = userEvent.setup();
    render(<ContextMenuHost />);
    useScene.setState({ selection: ["i"] });
    act(() => { openContextMenu(5, 5); });
    const menu = screen.getByRole("menu", { name: "Context menu" });
    const swap = within(menu).getByRole("menuitem", { name: "Swap instance" });
    expect(swap).toHaveFocus();
    fireEvent.keyDown(swap, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Reset all changes" })).toHaveFocus();
    await user.click(swap);
    const sub = screen.getAllByRole("menu").at(-1)!;
    expect(within(sub).getByRole("menuitem", { name: "Button" })).toBeDisabled(); // the current component
    await user.click(within(sub).getByRole("menuitem", { name: "Card" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useScene.getState().scene!.nodes.at("i").instance!.componentId).toBe("c2");
  });
});
