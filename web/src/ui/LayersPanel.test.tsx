// jest-dom's matchers are already installed by the setupFiles (vite.config.ts);
// the import here serves TYPE-SCRIPT (tsc -b does not read the setupFiles).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, cleanup, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { LayersPanel, layerDisplayName, reorderKey, visibleRows } from "./LayersPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import { layersInDrawOrder } from "../store/selectors";
import type { NodeLite, PageLite } from "../store/types";

// SyncClient double: records the ops that end up ON THE WIRE and models a
// server that accepts and ECHOES at once (applyPending + apply), as in the other
// store tests (see TextEditorOverlay.test.tsx).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function rectNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey, name: "", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function ellipseNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "ellipse", ...over };
}

function textNode(id: string, orderKey: string, content: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    ...rectNode(id, orderKey),
    kind: "text",
    text: { content, style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.5, align: "left" } },
    ...over,
  };
}

function installScene(...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  // setScene and not setState({scene}): installs a COHERENT scene (view and
  // confirmed aligned, queue empty) -- the reconciliation's invariant.
  useScene.getState().setScene(scene);
}

let sync: FakeSync;

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    gesture: null,
    editingNodeId: null,
  });
  useScene.getState().setSync(sync);
});

afterEach(cleanup);

function grid(): HTMLElement {
  return screen.getByRole("grid", { name: "Layers" });
}

function rows(): HTMLElement[] {
  return within(grid()).getAllByRole("row");
}

// Simulates the pointerdown -> mouseDown -> pointerup -> mouseUp ->
// click sequence of a real mouse click, WITH an explicit `pressure: 0.5` on the
// pointerdown.
//
// WHY userEvent.click() is not enough: react-aria-components (usePress)
// tells a REAL click from a screen-reader/"virtual" one by looking at
// width/height/pressure/detail of the PointerEvent (react-aria/dist/private/
// utils/isVirtualEvent.mjs::isVirtualPointerEvent) -- a pattern meant for
// TalkBack, not for jsdom. jsdom builds a PointerEvent with
// { width: 1, height: 1, pressure: 0 } when these fields are not
// specified, and THAT combination is exactly the heuristic for a TalkBack
// tap. Every click synthesized by user-event (which does not pass `pressure`)
// therefore ends up marked "virtual" under jsdom -- never under a real browser,
// where a pressed mouse's pressure is 0.5. From "virtual" follows a
// concrete effect, not just a cosmetic one: selectionBehavior="replace" behaves
// like "toggle" (every click ADDS instead of replacing, see
// react-aria/dist/private/selection/useSelectableItem.mjs::onSelect), so
// without this adjustment "a second simple click replaces" and
// "ctrl/shift-click extends" would be indistinguishable in this suite.
// fireEvent (unlike user-event) builds the PointerEvent with
// `new PointerEvent(type, init)`, so it accepts the override.
function press(el: Element, opts: Partial<PointerEventInit & MouseEventInit> = {}) {
  const base = { button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, detail: 1, ...opts };
  fireEvent.pointerDown(el, { ...base, pressure: 0.5 });
  fireEvent.mouseDown(el, base);
  fireEvent.pointerUp(el, { ...base, pressure: 0 });
  fireEvent.mouseUp(el, base);
  fireEvent.click(el, base);
}

// --- Step 1: list, selection, visibility, deletion -------------------------

describe("elenco", () => {
  it("shows the nodes from foreground to background", () => {
    installScene(
      rectNode("bg", "a0", { name: "Background" }),
      ellipseNode("mid", "a1", { name: "Center" }),
      textNode("fg", "a2", "hello", { name: "Foreground" }),
    );
    render(<LayersPanel />);
    const labels = rows().map((r) => r.textContent);
    // "fg" (highest orderKey, drawn last = foreground) on top,
    // "bg" (lowest orderKey) at the bottom -- the inverse of the draw order.
    expect(labels[0]).toContain("Foreground");
    expect(labels[1]).toContain("Center");
    expect(labels[2]).toContain("Background");
  });

  it("an empty scene shows the empty state, not ghost rows", () => {
    installScene();
    render(<LayersPanel />);
    expect(screen.getByText("No layers")).toBeInTheDocument();
  });
});

describe("selection: click on a row", () => {
  it("selects the node (the store reflects it)", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    press(screen.getByText("B"));

    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("a second SIMPLE click replaces the previous selection", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    press(screen.getByText("B"));
    press(screen.getByText("A"));

    expect(useScene.getState().selection).toEqual(["a"]);
  });

  it("ctrl-click extends the selection", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    press(screen.getByText("B"));
    press(screen.getByText("A"), { ctrlKey: true });

    expect(new Set(useScene.getState().selection)).toEqual(new Set(["a", "b"]));
  });

  it("shift-click extends the selection by range", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);

    // At the top of the list (foreground): C, B, A. Click on C then shift-click
    // on A covers the whole displayed range: all three.
    press(screen.getByText("C"));
    press(screen.getByText("A"), { shiftKey: true });

    expect(new Set(useScene.getState().selection)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("two-way sync", () => {
  it("selecting on the canvas (store.setSelection) highlights the matching row", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    // No interaction with the panel: it is the canvas (selectTool) that writes
    // here, with exactly the same store.setSelection. act(): a direct write
    // to the store, outside an event simulated by testing-library, must be
    // explicitly wrapped so React flushes the render before the assert.
    act(() => {
      useScene.getState().setSelection(["b"]);
    });

    const rowA = screen.getByText("A").closest('[role="row"]') as HTMLElement;
    const rowB = screen.getByText("B").closest('[role="row"]') as HTMLElement;
    expect(rowB).toHaveAttribute("data-selected", "true");
    expect(rowA).not.toHaveAttribute("data-selected");
  });
});

describe("visibility", () => {
  it("the toggle emits a SetProperties with the visible mask, without touching the selection", async () => {
    installScene(rectNode("a", "a0", { name: "A", visible: true }));
    useScene.getState().setSelection([]);
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Hide A" }));

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("a");
      expect(op.kind.value.mask?.paths).toEqual(["visible"]);
      expect(op.kind.value.patch?.visible).toBe(false);
    }
    expect(useScene.getState().scene?.nodes.at("a").visible).toBe(false);
    // Clicking the visibility button must not select the row.
    expect(useScene.getState().selection).toEqual([]);
  });

  it("the toggle is a gesture (one undo entry)", async () => {
    installScene(rectNode("a", "a0", { name: "A", visible: true }));
    render(<LayersPanel />);
    const user = userEvent.setup();
    const before = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Hide A" }));

    expect(useScene.getState().undoStack.length).toBe(before + 1);
    expect(useScene.getState().gesture).toBeNull();
  });
});

describe("deletion", () => {
  it("without a selection the deletion bar is not there (space for layers)", () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    expect(screen.queryByRole("button", { name: "Delete the selected layers" })).not.toBeInTheDocument();
  });

  it("emits deleteNode for EVERY selected node in a single gesture (a single undo entry)", async () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    useScene.getState().setSelection(["a", "b"]);
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Delete the selected layers" }));

    const deleteIds = sync.sent
      .filter((op) => op.kind.case === "deleteNode")
      .map((op) => (op.kind.case === "deleteNode" ? op.kind.value.id : ""));
    expect(new Set(deleteIds)).toEqual(new Set(["a", "b"]));
    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().scene?.nodes.at("a")).toBeUndefined();
    expect(useScene.getState().scene?.nodes.at("b")).toBeUndefined();
    expect(useScene.getState().scene?.nodes.at("c")).toBeDefined();
    // ONE undo entry for the whole multiple deletion, not one per
    // node: it is the brief's central point (Task 7, step 1).
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  // deleteNode deletes a SUBTREE (applyOp / core.applyDelete): a child
  // selected together with its group must not produce a second op --
  // it would be rejected (the node is already gone in the cascade) and would make the
  // undo entry of the WHOLE gesture fail.
  it("a group AND one of its descendants selected together emit ONE single deleteNode", async () => {
    installScene(
      rectNode("g1", "a0", { name: "G" }),
      rectNode("c1", "a0", { name: "C", parentId: "g1" }),
      rectNode("other", "a1", { name: "Other" }),
    );
    useScene.getState().setSelection(["g1", "c1"]);
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Delete the selected layers" }));

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case === "deleteNode" && sync.sent[0].kind.value.id).toBe("g1");
    expect(useScene.getState().scene?.nodes.at("c1")).toBeUndefined();
    expect(useScene.getState().scene?.nodes.at("other")).toBeDefined();
    // The entry is there and complete: g1 and c1 to recreate, in a single Ctrl+Z.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().undoStack[useScene.getState().undoStack.length - 1]).toHaveLength(2);
  });
});

// --- Step 3: the displayed name -----------------------------------------------

describe("layerDisplayName", () => {
  it("uses name when it is set", () => {
    expect(layerDisplayName(rectNode("a", "a0", { name: "My rectangle" }))).toBe("My rectangle");
  });

  it("falls back to 'Rectangle' for an unnamed rectangle", () => {
    expect(layerDisplayName(rectNode("a", "a0", { name: "" }))).toBe("Rectangle");
  });

  it("falls back to 'Ellipse' for an unnamed ellipse", () => {
    expect(layerDisplayName(ellipseNode("a", "a0", { name: "" }))).toBe("Ellipse");
  });

  // A group is born with a name already (tools/grouping.ts::GROUP_NAME); this is
  // the fallback for a group renamed to an empty string. Without its branch it
  // would fall into the TEXT one and show "Text".
  it("falls back to 'Group' for an unnamed group", () => {
    expect(layerDisplayName(rectNode("a", "a0", { name: "", kind: "group" }))).toBe("Group");
  });

  it("falls back to the (truncated) content for an unnamed text node", () => {
    expect(layerDisplayName(textNode("a", "a0", "hello world", { name: "" }))).toBe("hello world");
    const long = "a".repeat(50);
    const shown = layerDisplayName(textNode("a", "a0", long, { name: "" }));
    expect(shown.length).toBeLessThan(50);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("falls back to 'Text' for an empty unnamed text node", () => {
    expect(layerDisplayName(textNode("a", "a0", "   ", { name: "" }))).toBe("Text");
  });

  it("shows the name in the row (kind fallback in the real list)", () => {
    installScene(rectNode("a", "a0", { name: "" }), ellipseNode("b", "a1", { name: "" }));
    render(<LayersPanel />);
    expect(screen.getByText("Rectangle")).toBeInTheDocument();
    expect(screen.getByText("Ellipse")).toBeInTheDocument();
  });
});

// --- Task 8, step 1: inline rename ----------------------------------------

function nameField(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Layer name" }) as HTMLInputElement;
}

describe("inline rename", () => {
  it("the double click on the name opens a field, seeded with the REAL name and with the displayed name as placeholder", async () => {
    installScene(rectNode("a", "a0", { name: "" }));
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.dblClick(screen.getByText("Rectangle"));

    const field = nameField();
    // Seeded with the real name (empty), not with the fallback: pressing Enter without
    // writing anything must not PERSIST "Rectangle" as an explicit name.
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "Rectangle");
    expect(field).toHaveFocus();
  });

  it("Enter commits with a SetProperties mask name, in a single gesture", async () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.dblClick(screen.getByText("A"));
    await user.clear(nameField());
    await user.type(nameField(), "Button{Enter}");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("a");
      expect(op.kind.value.mask?.paths).toEqual(["name"]);
      expect(op.kind.value.patch?.name).toBe("Button");
    }
    expect(useScene.getState().scene?.nodes.at("a").name).toBe("Button");
    // One gesture, one undo entry -- like every other panel change.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
    // The field closes and the row goes back to showing the name.
    expect(screen.queryByRole("textbox", { name: "Layer name" })).toBeNull();
    expect(screen.getByText("Button")).toBeInTheDocument();
  });

  it("Escape cancels: no op, no undo entry, name unchanged", async () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.dblClick(screen.getByText("A"));
    await user.clear(nameField());
    await user.type(nameField(), "Discarded{Escape}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("a").name).toBe("A");
    expect(useScene.getState().undoStack.length).toBe(undoBefore);
    expect(screen.queryByRole("textbox", { name: "Layer name" })).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("confirming without having changed anything sends no op", async () => {
    installScene(rectNode("a", "a0", { name: "A" }));
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.dblClick(screen.getByText("A"));
    await user.type(nameField(), "{Enter}");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("while the field has focus the global shortcuts stay inactive", async () => {
    installScene(rectNode("a", "a0", { name: "Alpha" }), rectNode("b", "a1", { name: "Beta" }));
    useScene.getState().setSelection(["a"]);
    render(<LayersPanel />);
    const user = userEvent.setup();

    await user.dblClick(screen.getByText("Alpha"));
    const selectionBefore = useScene.getState().selection;

    // The app's global shortcuts (undo/redo in ui/App.tsx, Escape/Delete in
    // tools/toolManager.ts) listen on the WINDOW: if a key typed in the
    // field gets that far, Delete deletes the node being renamed and
    // Ctrl+Z undoes the previous gesture instead of the typed text.
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      await user.type(nameField(), "Beta{Backspace}{Delete}");
      await user.keyboard("{Control>}z{/Control}");
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }

    // Nor the GridList's own shortcuts: typing "Beta" must not
    // trigger the typeahead on the row of the same name.
    expect(useScene.getState().selection).toEqual(selectionBefore);
    expect(useScene.getState().selection).not.toContain("b");
  });
});

// --- Task 8, step 2/3: reorder with drag ------------------------------------

// The order as the REST of the app sees it: layersInDrawOrder on the store's
// scene, not the DOM rows. It is the brief's point -- the reorder must change
// the draw order on the canvas, not just the panel's look.
function order(): string[] {
  const scene = useScene.getState().scene;
  return scene ? layersInDrawOrder(scene).map((n) => n.id) : [];
}

function rowOf(label: string): HTMLElement {
  return screen.getByText(label).closest('[role="row"]') as HTMLElement;
}

// Drags row `from` above row `onto` and releases. The release arrives
// on the WINDOW (not on the row): it is where the panel listens for it, because the
// pointer can very well be released outside the list.
function dragOnto(from: string, onto: string) {
  const handle = screen.getByRole("button", { name: `Reorder ${from}` });
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  fireEvent.pointerDown(handle, { ...base, button: 0, pressure: 0.5 });
  fireEvent.pointerMove(rowOf(onto), base);
  fireEvent.pointerUp(window, { ...base, pressure: 0 });
}

describe("reorder with drag", () => {
  it("dragging a row onto another changes the draw order", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);
    // List (foreground on top): C, B, A.
    expect(order()).toEqual(["c", "b", "a"]);

    // C from the foreground down to A's place (the bottom).
    dragOnto("C", "A");

    expect(order()).toEqual(["b", "a", "c"]);
  });

  it("emits ONE SINGLE SetProperties with the order_key mask, in a single gesture", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragOnto("C", "A");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("setProps");
    if (op.kind.case === "setProps") {
      expect(op.kind.value.id).toBe("c");
      expect(op.kind.value.mask?.paths).toEqual(["order_key"]);
      // The computed key is the one the node really has now, and it is
      // strictly below that of "a" (which stayed where it was).
      const key = op.kind.value.patch?.orderKey ?? "";
      expect(useScene.getState().scene?.nodes.at("c").orderKey).toBe(key);
      expect(key < "a0").toBe(true);
    }
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("dragging a row onto itself emits nothing", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    dragOnto("B", "B");

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("the ends are open: a row can be brought to the top and to the bottom", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);

    // From bottom to top: no neighbor above, the upper end is open.
    dragOnto("A", "C");
    expect(order()).toEqual(["a", "c", "b"]);

    // And back: from top to bottom, lower end open.
    dragOnto("A", "B");
    expect(order()).toEqual(["c", "b", "a"]);
  });

  it("reordering REPEATEDLY at the same spot keeps working", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);

    // Every round slips the bottom row BETWEEN the other two: it is exactly the case
    // the fractional index of Task 2 exists to support (the "a" + 6 digits
    // format of M0/M1a admitted no key between two close ones, and
    // from the second insertion at the same spot it would have been impossible).
    let expected = ["c", "b", "a"];
    const labels: Record<string, string> = { a: "A", b: "B", c: "C" };
    for (let i = 0; i < 20; i++) {
      dragOnto(labels[expected[2]], labels[expected[1]]);
      expected = [expected[0], expected[2], expected[1]];
      expect(order()).toEqual(expected);
    }
    // Twenty ops, twenty gestures: none was discarded because of an impossible key.
    expect(sync.sent).toHaveLength(20);
  });

  it("Alt+arrow on the handle reorders from the keyboard, with the same op and the same gesture", () => {
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
      rectNode("c", "a2", { name: "C" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    // Without a mouse the reorder would be the panel's only unreachable
    // function: the handle is a real <button> on purpose. ALT+arrow and
    // not the plain arrow: react-aria reserves ArrowUp/ArrowDown for
    // navigation between rows and stops them in capture before the row's children
    // (see the comment on the handle in LayersPanel.tsx).
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder A" }), {
      key: "ArrowUp",
      altKey: true,
    });

    expect(order()).toEqual(["c", "a", "b"]);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    if (sync.sent[0].kind.case === "setProps") {
      expect(sync.sent[0].kind.value.mask?.paths).toEqual(["order_key"]);
    }
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });

  it("the arrow that would leave the list does nothing", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    // B is already at the top (foreground): there is no place above.
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder B" }), {
      key: "ArrowUp",
      altKey: true,
    });

    expect(order()).toEqual(["b", "a"]);
    expect(sync.sent).toHaveLength(0);
  });

  it("the arrow WITHOUT Alt is left to react-aria (navigation between rows), it does not reorder", () => {
    installScene(rectNode("a", "a0", { name: "A" }), rectNode("b", "a1", { name: "B" }));
    render(<LayersPanel />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder A" }), { key: "ArrowUp" });

    expect(order()).toEqual(["b", "a"]);
    expect(sync.sent).toHaveLength(0);
  });
});

// --- Task 8, step 2: the computed key (pure function) ---------------------

describe("reorderKey", () => {
  // The rows as the panel shows them: foreground on top, orderKey
  // DESCENDING.
  const layers = [
    rectNode("c", "a2"),
    rectNode("b", "a1"),
    rectNode("a", "a0"),
  ];

  it("null when the row does not move", () => {
    expect(reorderKey(layers, 1, 1)).toBeNull();
  });

  it("null for indices outside the list", () => {
    expect(reorderKey(layers, -1, 1)).toBeNull();
    expect(reorderKey(layers, 0, 3)).toBeNull();
  });

  it("at the top: key above all (upper end open)", () => {
    const key = reorderKey(layers, 2, 0);
    expect(key).not.toBeNull();
    expect(key! > "a2").toBe(true);
  });

  it("at the bottom: key below all (lower end open)", () => {
    const key = reorderKey(layers, 0, 2);
    expect(key).not.toBeNull();
    expect(key! < "a0").toBe(true);
  });

  it("in the middle: key strictly between the two neighbors of the arrival position", () => {
    const key = reorderKey(layers, 0, 1);
    expect(key).not.toBeNull();
    expect(key! > "a0").toBe(true);
    expect(key! < "a1").toBe(true);
  });

  it("null (instead of throwing) when the two neighbors have the SAME key", () => {
    // Not reachable from the UI, but not impossible in the model (nothing
    // prevents two nodes from sharing an order key): orderKeyBetween
    // would throw, and throwing inside a pointerup handler would mean
    // breaking the app during a drag.
    const dup = [rectNode("x", "a1"), rectNode("y", "a1"), rectNode("z", "a1")];
    expect(reorderKey(dup, 0, 1)).toBeNull();
  });
});

// --- Nesting track: tree + drag-to-reparent --------------------------------

function groupNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "group", name: "", ...over };
}

function frameNode(id: string, orderKey: string, over: Partial<NodeLite> = {}): NodeLite {
  return { ...rectNode(id, orderKey), kind: "frame", clipsContent: true, ...over };
}

// Like installScene, but with an explicit list of pages (for tests that
// change page). currentPageId is recomputed by setScene against the
// passed pages.
function installScenePages(pages: PageLite[], ...nodes: NodeLite[]) {
  const scene = emptyScene("doc-1", "Untitled");
  scene.pages = pages;
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
}

// Starts a drag of `from` (grabbing the handle) and brings it over row
// `onto`, WITHOUT releasing: it serves to inspect the panel's state
// mid-drag (invalid targets).
function dragHover(from: string, onto: string) {
  const handle = screen.getByRole("button", { name: `Reorder ${from}` });
  const base = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  fireEvent.pointerDown(handle, { ...base, button: 0, pressure: 0.5 });
  fireEvent.pointerMove(rowOf(onto), base);
}

describe("tree: hierarchy of the current page", () => {
  it("shows the children under the container, indented by depth", () => {
    installScene(
      groupNode("g", "a1", { name: "Group" }),
      rectNode("c1", "a0", { name: "Child1", parentId: "g" }),
      rectNode("c2", "a1", { name: "Child2", parentId: "g" }),
      rectNode("r", "a0", { name: "Root" }),
    );
    render(<LayersPanel />);

    const labels = rows().map((row) => row.textContent ?? "");
    const idxG = labels.findIndex((l) => l.includes("Group"));
    const idxC1 = labels.findIndex((l) => l.includes("Child1"));
    const idxC2 = labels.findIndex((l) => l.includes("Child2"));
    const idxR = labels.findIndex((l) => l.includes("Root"));

    // The container before its children, the children before the background sibling.
    expect(idxG).toBeLessThan(idxC2);
    expect(idxC2).toBeLessThan(idxC1); // among the children, foreground (c2, a1) on top
    expect(idxC1).toBeLessThan(idxR);

    // Depth: the children are one level deeper than the container.
    expect(rowOf("Group")).toHaveAttribute("data-depth", "0");
    expect(rowOf("Root")).toHaveAttribute("data-depth", "0");
    expect(rowOf("Child1")).toHaveAttribute("data-depth", "1");
    expect(rowOf("Child2")).toHaveAttribute("data-depth", "1");
  });

  it("expand/collapse is view state: it hides the children with no op or undo", async () => {
    installScene(
      groupNode("g", "a1", { name: "Group" }),
      rectNode("c", "a0", { name: "Child", parentId: "g" }),
    );
    render(<LayersPanel />);
    const user = userEvent.setup();
    expect(screen.getByText("Child")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse Group" }));
    expect(screen.queryByText("Child")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand Group" }));
    expect(screen.getByText("Child")).toBeInTheDocument();

    // No op on the wire, no undo entry: it is view state like the camera.
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("changing page changes the tree", () => {
    installScenePages(
      [{ id: "page1", name: "P1" }, { id: "page2", name: "P2" }],
      rectNode("a", "a0", { name: "OnOne", parentId: "page1" }),
      rectNode("b", "a0", { name: "OnTwo", parentId: "page2" }),
    );
    useScene.getState().setCurrentPage("page1");
    render(<LayersPanel />);

    expect(screen.getByText("OnOne")).toBeInTheDocument();
    expect(screen.queryByText("OnTwo")).toBeNull();

    act(() => {
      useScene.getState().setCurrentPage("page2");
    });

    expect(screen.queryByText("OnOne")).toBeNull();
    expect(screen.getByText("OnTwo")).toBeInTheDocument();
  });
});

describe("albero: drag per riparentare", () => {
  it("dragging INTO a group emits ONE ReparentNode to the new parent, one undo entry", () => {
    installScene(
      groupNode("g", "a1", { name: "Group" }),
      rectNode("r", "a0", { name: "Rect" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    dragOnto("Rect", "Group");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("reparentNode");
    if (op.kind.case === "reparentNode") {
      expect(op.kind.value.id).toBe("r");
      expect(op.kind.value.newParentId).toBe("g");
    }
    expect(useScene.getState().scene?.nodes.at("r").parentId).toBe("g");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("dragging INTO a frame reparents to the frame", () => {
    installScene(
      frameNode("f", "a1", { name: "Frame" }),
      rectNode("r", "a0", { name: "Rect" }),
    );
    render(<LayersPanel />);

    dragOnto("Rect", "Frame");

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("reparentNode");
    if (sync.sent[0].kind.case === "reparentNode") {
      expect(sync.sent[0].kind.value.newParentId).toBe("f");
    }
    expect(useScene.getState().scene?.nodes.at("r").parentId).toBe("f");
  });

  it("dragging out, onto a page root, reparents to the page with an orderKey between the neighbors", () => {
    installScene(
      groupNode("g", "a1", { name: "Group" }),
      rectNode("c", "a0", { name: "Child", parentId: "g" }),
      rectNode("r", "a0", { name: "Root" }),
    );
    render(<LayersPanel />);
    const undoBefore = useScene.getState().undoStack.length;

    // The child, dragged onto a page root, leaves the group and becomes
    // a root beside it.
    dragOnto("Child", "Root");

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("reparentNode");
    if (op.kind.case === "reparentNode") {
      expect(op.kind.value.id).toBe("c");
      expect(op.kind.value.newParentId).toBe("page1");
      // between the neighbors: above "r" (a0) and below "g" (a1).
      const key = op.kind.value.orderKey;
      expect(key > "a0").toBe(true);
      expect(key < "a1").toBe(true);
    }
    expect(useScene.getState().scene?.nodes.at("c").parentId).toBe("page1");
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
  });

  it("a drop that would make a cycle is NOT offered and produces NOTHING", () => {
    installScene(
      groupNode("g", "a1", { name: "Group" }),
      rectNode("c", "a0", { name: "Child", parentId: "g" }),
    );
    render(<LayersPanel />);

    // Mid-drag the descendant is marked as an invalid target.
    dragHover("Group", "Child");
    expect(rowOf("Child")).toHaveAttribute("data-drop-invalid", "true");

    const base = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    fireEvent.pointerUp(window, { ...base, pressure: 0 });

    // Dropping a group inside its own child is rejected: no op, no
    // undo, the group stays a root.
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().scene?.nodes.at("g").parentId).toBe("page1");
  });

  it("dragging onto a sibling (same parent) stays a reorder: SetProperties order_key", () => {
    // Two non-container page roots: dropping one on the other is a pure
    // reorder, as in the flat list -- the reorder-only path already exists
    // and must be used instead of a ReparentNode.
    installScene(
      rectNode("a", "a0", { name: "A" }),
      rectNode("b", "a1", { name: "B" }),
    );
    render(<LayersPanel />);

    dragOnto("B", "A");

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    if (sync.sent[0].kind.case === "setProps") {
      expect(sync.sent[0].kind.value.mask?.paths).toEqual(["order_key"]);
    }
  });
});

describe("visibleRows", () => {
  it("descends only into expanded containers, foreground on top", () => {
    const scene = emptyScene("doc-1", "Untitled");
    scene.nodes = scene.nodes.set("g", groupNode("g", "a1", { name: "G" }));
    scene.nodes = scene.nodes.set("c1", rectNode("c1", "a0", { name: "C1", parentId: "g" }));
    scene.nodes = scene.nodes.set("c2", rectNode("c2", "a1", { name: "C2", parentId: "g" }));
    scene.nodes = scene.nodes.set("r", rectNode("r", "a0", { name: "R" }));

    const expanded = visibleRows(scene, "page1", new Set());
    expect(expanded.map((row) => row.id)).toEqual(["g", "c2", "c1", "r"]);
    expect(expanded.find((row) => row.id === "c1")?.depth).toBe(1);

    // Collapsed: the children do not appear.
    const collapsed = visibleRows(scene, "page1", new Set(["g"]));
    expect(collapsed.map((row) => row.id)).toEqual(["g", "r"]);
  });
});
