import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useScene } from "../store/store";
import { emptyScene, type NodeLite } from "../store/types";
import {
  CLIPBOARD_FORMAT,
  CLIPBOARD_VERSION,
  PASTE_OFFSET,
  serializeNodes,
  parseClipboard,
  pasteOps,
  copySelection,
  pasteClipboard,
  duplicateSelection,
  attachClipboardShortcuts,
  clipboardMemory,
} from "./clipboard";

// --- fixtures ---------------------------------------------------------------

function rect(id: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id,
    parentId: "page1",
    orderKey: "a000001",
    name: "Rettangolo",
    visible: true,
    opacity: 1,
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    rotation: 0,
    fills: [{ r: 0.5, g: 0.25, b: 0.125, a: 1 }],
    strokes: [],
    kind: "rect",
    cornerRadius: 4,
    clipsContent: false,
    ...over,
  };
}

function text(id: string, over: Partial<NodeLite> = {}): NodeLite {
  return rect(id, {
    kind: "text",
    cornerRadius: 0,
    name: "Text",
    text: {
      content: "hello",
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "center" },
    },
    ...over,
  });
}

function installScene(nodes: NodeLite[]): void {
  const scene = emptyScene("doc-1", "Untitled");
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
}

// The system clipboard does not exist in jsdom: it is installed (or removed,
// for the "API not available" case) on navigator for every test.
interface ClipboardStub {
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
}

function setClipboard(stub: ClipboardStub | null): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: stub ?? undefined,
    configurable: true,
    writable: true,
  });
}

function clipboardStub(initial: string | null = null): ClipboardStub {
  let held = initial;
  return {
    writeText: vi.fn(async (t: string) => {
      held = t;
    }),
    readText: vi.fn(async () => held ?? ""),
  };
}

beforeEach(() => {
  useScene.setState({
    selection: [],
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    notice: null,
    lastError: null,
    sync: null,
    history: [],
    pending: [],
  });
  installScene([]);
  setClipboard(clipboardStub());
  // The fallback buffer is MODULE state: without resetting it, a copy made by
  // a previous test would remain pasteable in the next one.
  clipboardMemory.text = null;
  clipboardMemory.onSystem = false;
});

afterEach(() => {
  setClipboard(null);
});

// --- format -----------------------------------------------------------------

describe("the clipboard payload", () => {
  it("makes the full serialize -> parse round trip without losing anything", () => {
    const nodes = [rect("n1"), text("n2")];
    const parsed = parseClipboard(serializeNodes(nodes));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.nodes).toEqual(nodes);
  });

  it("keeps effects and gradients through the serialize -> parse round trip", () => {
    const n = rect("n1", {
      fills: [{
        r: 1, g: 0, b: 0, a: 1,
        gradient: {
          kind: "radial", x1: 0.5, y1: 0.5, x2: 1, y2: 0.5,
          stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 0.5 }, position: 1 }],
        },
      }],
      effects: [
        { kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.3 }, offsetX: 1, offsetY: 5, blur: 9 },
        { kind: "layerBlur", radius: 2 },
      ],
    });
    const parsed = parseClipboard(serializeNodes([n]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.nodes).toEqual([n]);
  });

  it("ignores an unknown or malformed effect instead of rejecting everything, and clamps negative values", () => {
    const payload = JSON.parse(serializeNodes([rect("n1")]));
    payload.nodes.at(0).effects = [{ kind: "glow" }, { kind: "layerBlur", radius: -4 }, null, { kind: "dropShadow", blur: -1 }];
    const parsed = parseClipboard(JSON.stringify(payload));
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.nodes[0].effects).toEqual([
      { kind: "layerBlur", radius: 0 },
      { kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 0, offsetY: 0, blur: 0 },
    ]);
  });

  it("is a labeled and versioned JSON (so another window recognizes it)", () => {
    const payload = JSON.parse(serializeNodes([rect("n1")]));
    expect(payload.format).toBe(CLIPBOARD_FORMAT);
    expect(payload.version).toBe(CLIPBOARD_VERSION);
    expect(payload.nodes).toHaveLength(1);
  });

  it("treats as FOREIGN anything that is not an opendesigner payload", () => {
    for (const t of ["", "   ", "hello world", "{ not json", JSON.stringify({ hello: "world" })]) {
      const parsed = parseClipboard(t);
      expect(parsed.ok, t).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason, t).toBe("foreign");
    }
  });

  // The central requirement: a payload that talks about a node type that this
  // build does not know (another window, a newer version) must be REJECTED
  // wholesale -- creating a "vector" node degraded to a rectangle would be a
  // silently corrupted document.
  it("REJECTS a payload with an unknown node type, instead of degrading it", () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [rect("n1"), { ...rect("n2"), kind: "vector" }],
    });
    const parsed = parseClipboard(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toBe("unsupported");
  });

  it("REJECTS a payload from a future version", () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION + 1,
      nodes: [rect("n1")],
    });
    const parsed = parseClipboard(payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toBe("unsupported");
  });

  it("fills in missing fields instead of producing a half node", () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ id: "n1", kind: "text" }],
    });
    const parsed = parseClipboard(payload);
    if (!parsed.ok) throw new Error("should have been accepted");
    const n = parsed.nodes[0];
    expect(n.kind).toBe("text");
    expect(n.text).toBeDefined();
    expect(n.text?.content).toBe("");
    expect(n.x).toBe(0);
    expect(n.fills).toEqual([]);
  });
});

// --- paste ops --------------------------------------------------------------

describe("pasteOps", () => {
  it("gives NEW ids to every pasted node", () => {
    installScene([rect("n1")]);
    const { ops, ids } = pasteOps(useScene.getState().scene!, [rect("n1")]);
    expect(ops).toHaveLength(1);
    expect(ids[0]).not.toBe("n1");
    expect(ids[0]).not.toBe("");
    const op = ops[0];
    if (op.kind.case !== "createNode") throw new Error("wrong kind");
    expect(op.kind.value.node?.id).toBe(ids[0]);
  });

  // A duplicate id or order key would corrupt the document: the first
  // because core.applyCreate rejects the op (ErrNodeExists) leaving the local
  // scene diverged, the second because the draw order would become
  // undefined between the two nodes.
  it("gives NEW order keys, at the top of the document and in the order of the copied nodes", () => {
    installScene([rect("a", { orderKey: "a000001" }), rect("b", { orderKey: "a000005" })]);
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("x", { orderKey: "a000009" }), rect("y", { orderKey: "a000002" })]);
    const keys = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.orderKey : ""));
    expect(keys).toHaveLength(2);
    // Above every key already in the document...
    for (const k of keys) expect(k > "a000005").toBe(true);
    // ...increasing among themselves, and in the RELATIVE order of the copied nodes (y before
    // x: its starting order key was lower).
    expect(keys[0] < keys[1]).toBe(true);
    const names = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.id : ""));
    expect(new Set(names).size).toBe(2);
  });

  it("offsets the pasted nodes", () => {
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("n1", { x: 10, y: 20 })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.x).toBe(10 + PASTE_OFFSET);
    expect(node?.y).toBe(20 + PASTE_OFFSET);
  });

  it("keeps the shape, style and text of the source node", () => {
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [text("t1", { opacity: 0.5, rotation: 30 })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.shape.case).toBe("text");
    expect(node?.shape.case === "text" && node.shape.value.content).toBe("hello");
    expect(node?.opacity).toBe(0.5);
    expect(node?.rotation).toBe(30);
    expect(node?.fills).toHaveLength(1);
  });

  // "The selected nodes and their parent", not "all the nodes of the document":
  // when nesting arrives (track 1) a payload may contain a
  // container together with its children, and the child must follow the COPY of the
  // container, not the original.
  it("remaps the parent when the parent is also in the payload", () => {
    const scene = useScene.getState().scene!;
    const parent = rect("p1", { orderKey: "a000001" });
    const child = rect("c1", { parentId: "p1", orderKey: "a000002", x: 5, y: 5 });
    const { ops, ids } = pasteOps(scene, [parent, child]);
    const nodes = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node! : null));
    expect(nodes.at(0)?.id).toBe(ids[0]);
    expect(nodes.at(1)?.parentId).toBe(ids[0]);
    // The child does NOT take the offset: the container takes it, and moving
    // both would move it twice the day coordinates
    // become relative to the parent.
    expect(nodes.at(1)?.x).toBe(5);
    expect(nodes.at(0)?.x).toBe(10 + PASTE_OFFSET);
  });

  it("keeps the parent when it exists in the destination document", () => {
    installScene([rect("host")]);
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("n1", { parentId: "host" })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.parentId).toBe("host");
  });

  it("falls back to the page when the parent does not exist (paste into ANOTHER document)", () => {
    const scene = useScene.getState().scene!;
    const { ops } = pasteOps(scene, [rect("n1", { parentId: "group-from-another-document" })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.parentId).toBe("page1");
  });

  // The payload ids are NOT guaranteed: parseClipboard tolerates a node without
  // `id` (it reads it as "") and a hand-written payload can repeat one. If the
  // new id were chosen by source id instead of by position, those
  // nodes would collapse onto a single uuid: two CreateNodes with the same id, which
  // locally applyOp discards (the scene gains ONE node while `ids` declares
  // two) and which the server rejects with ErrNodeExists mid-gesture.
  it("gives DISTINCT ids even to payload nodes without an id", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [rect("", { x: 1 }), rect("", { x: 2 })]);
    expect(ops).toHaveLength(2);
    expect(ids).toHaveLength(2);
    const created = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.id : ""));
    expect(new Set(created).size).toBe(2);
    expect(created).toEqual(ids);
    expect(created).not.toContain("");
  });

  it("gives DISTINCT ids even to payload nodes that repeat the same id", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [
      rect("same", { orderKey: "a000001" }),
      rect("same", { orderKey: "a000002" }),
    ]);
    const created = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node!.id : ""));
    expect(new Set(created).size).toBe(2);
    expect(ids).toEqual(created);
  });

  // The empty id is not an identity: without this distinction a node with
  // parentId "" would be "remapped" under the copy of the node without an id.
  it("does not attach a node without a parent to the copy of the node without an id", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [
      rect("", { orderKey: "a000001" }),
      rect("n2", { parentId: "", orderKey: "a000002" }),
    ]);
    const nodes = ops.map((op) => (op.kind.case === "createNode" ? op.kind.value.node! : null));
    expect(nodes.at(1)?.parentId).toBe("page1");
    expect(nodes.at(1)?.parentId).not.toBe(ids[0]);
    // And since it is a child of nothing, it stays a ROOT: it takes the offset.
    expect(nodes.at(1)?.x).toBe(10 + PASTE_OFFSET);
  });

  // An ambiguous parent (two nodes with the same id) is not drawn by lot: the node
  // falls back on the "exists in the document" / "lands on the page" cases.
  it("does not remap an ambiguous parent", () => {
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [
      rect("dup", { orderKey: "a000001" }),
      rect("dup", { orderKey: "a000002" }),
      rect("c1", { parentId: "dup", orderKey: "a000003" }),
    ]);
    const child = ops[2].kind.case === "createNode" ? ops[2].kind.value.node! : null;
    expect(child?.parentId).toBe("page1");
    expect(ids).not.toContain(child?.parentId);
  });

  it("does not create a node that is its own child", () => {
    installScene([]);
    const scene = useScene.getState().scene!;
    const { ops, ids } = pasteOps(scene, [rect("n1", { parentId: "n1" })]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.parentId).not.toBe(ids[0]);
    expect(node?.parentId).toBe("page1");
  });
});

// --- copy -------------------------------------------------------------------

describe("copySelection", () => {
  it("writes the selection to the SYSTEM clipboard as an opendesigner payload", async () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1"), rect("n2")]);
    useScene.getState().setSelection(["n1"]);

    expect(await copySelection()).toBe(true);
    expect(cb.writeText).toHaveBeenCalledTimes(1);
    const parsed = parseClipboard(cb.writeText.mock.calls[0][0] as string);
    if (!parsed.ok) throw new Error("should have been an opendesigner payload");
    expect(parsed.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("copies nothing (and does not touch the clipboard) without a selection", async () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1")]);
    expect(await copySelection()).toBe(false);
    expect(cb.writeText).not.toHaveBeenCalled();
  });
});

// --- paste ------------------------------------------------------------------

describe("pasteClipboard", () => {
  it("pastes the system clipboard payload with new ids", async () => {
    const cb = clipboardStub(serializeNodes([rect("n1"), rect("n2")]));
    setClipboard(cb);
    installScene([]);

    await pasteClipboard();

    const scene = useScene.getState().scene!;
    const ids = [...scene.nodes.ids()];
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("n1");
    expect(useScene.getState().selection).toEqual(ids.sort((a, b) =>
      scene.nodes.at(a).orderKey < scene.nodes.at(b).orderKey ? -1 : 1));
  });

  // The point of "a single gesture": one Ctrl+Z removes ALL the pasted stuff, not one
  // node at a time.
  it("is a SINGLE gesture: one Ctrl+Z removes all the pasted nodes together", async () => {
    setClipboard(clipboardStub(serializeNodes([rect("n1"), rect("n2"), rect("n3")])));
    installScene([rect("already-here")]);

    await pasteClipboard();
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(4);
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().undo();
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual(["already-here"]);
  });

  it("pastes from the in-memory buffer when the system clipboard is not available", async () => {
    setClipboard(null); // no navigator.clipboard: insecure environment, permission denied...
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();

    await pasteClipboard();
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2);
  });

  it("pastes from the in-memory buffer when the system clipboard REFUSES the read", async () => {
    const cb = clipboardStub();
    cb.readText.mockRejectedValue(new Error("permission denied"));
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();

    await pasteClipboard();
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2);
  });

  it("pastes nothing when there has never been a copy", async () => {
    setClipboard(clipboardStub("any text at all"));
    installScene([rect("n1")]);
    await pasteClipboard();
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual(["n1"]);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("cleanly rejects a payload with an unknown type: no node, a notice", async () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ ...rect("n1"), kind: "vector" }],
    });
    setClipboard(clipboardStub(payload));
    installScene([rect("already-here")]);

    await pasteClipboard();

    expect([...useScene.getState().scene!.nodes.ids()]).toEqual(["already-here"]);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().notice).toBeTruthy();
  });

  // Reading the clipboard is ASYNCHRONOUS and can stay hanging for a long time
  // (Chromium does not resolve readText until the document has focus).
  // Without a guard, the Ctrl+V pressed in the meantime queue up and land
  // ALL TOGETHER when the read unblocks: a burst of pastes that
  // nobody asked for, which moreover have to be undone one by one.
  it("a second Ctrl+V while the read is still hanging does not queue another paste", async () => {
    let release: (t: string) => void = () => {};
    const cb = clipboardStub();
    cb.readText.mockImplementation(() => new Promise<string>((res) => (release = res)));
    setClipboard(cb);
    installScene([]);

    const first = pasteClipboard();
    const second = pasteClipboard();
    release(serializeNodes([rect("n1")]));
    await Promise.all([first, second]);

    expect(cb.readText).toHaveBeenCalledTimes(1);
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(1);
  });

  // The end-to-end case of the badly written payload: two nodes without `id`. They must
  // become TWO nodes, and the selection (which is also what the undo entry
  // will remove) must match what is really in the scene.
  it("pastes two nodes even if the payload gives them no id", async () => {
    const payload = JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ kind: "rect" }, { kind: "rect" }],
    });
    setClipboard(clipboardStub(payload));
    installScene([]);

    const ids = await pasteClipboard();

    const nodes = [...useScene.getState().scene!.nodes.ids()];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(nodes.sort()).toEqual([...ids].sort());
    expect(useScene.getState().selection).toEqual(ids);

    useScene.getState().undo();
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual([]);
  });

  // The fallback on the in-memory buffer is NOT for "there is something else on the clipboard": a
  // successful read is the last copy the user really made (text
  // selected in the page and Ctrl+C, or a copy in another application).
  // Pasting a previously copied rectangle in its place would be pasting one
  // thing for another, without saying so.
  it("does NOT fall back on the previous copy when the clipboard reads fine and contains something else", async () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();
    // Someone else (the browser, another application) overwrites the clipboard.
    cb.readText.mockResolvedValue("some text copied elsewhere");

    expect(await pasteClipboard()).toEqual([]);
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual(["n1"]);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  // ...but if our copy never reached the system clipboard
  // (write denied, document unfocused), the in-memory buffer is the ONLY
  // copy that exists: there the fallback remains the only sensible thing.
  it("falls back anyway when the system WRITE had failed", async () => {
    const cb = clipboardStub();
    cb.writeText.mockRejectedValue(new Error("permission denied"));
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    await copySelection();
    cb.readText.mockResolvedValue("some text copied elsewhere");

    await pasteClipboard();
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2);
  });

  it("does not paste with an open gesture (a drag in progress): deferred, like undo/redo", async () => {
    setClipboard(clipboardStub(serializeNodes([rect("n1")])));
    installScene([]);
    useScene.getState().beginGesture();
    await pasteClipboard();
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(0);
  });
});

// --- duplicate --------------------------------------------------------------

describe("duplicateSelection", () => {
  it("duplicates the selection with the offset, and selects the copies", () => {
    installScene([rect("n1", { x: 100, y: 200 })]);
    useScene.getState().setSelection(["n1"]);

    const ids = duplicateSelection();

    const scene = useScene.getState().scene!;
    expect(ids).toHaveLength(1);
    expect([...scene.nodes.ids()]).toHaveLength(2);
    expect(scene.nodes.at(ids[0]).x).toBe(100 + PASTE_OFFSET);
    expect(scene.nodes.at(ids[0]).y).toBe(200 + PASTE_OFFSET);
    expect(useScene.getState().selection).toEqual(ids);
  });

  it("is a SINGLE gesture on several nodes too", () => {
    installScene([rect("n1"), rect("n2", { orderKey: "a000002" })]);
    useScene.getState().setSelection(["n1", "n2"]);

    duplicateSelection();
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(4);
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().undo();
    expect([...useScene.getState().scene!.nodes.ids()].sort()).toEqual(["n1", "n2"]);
  });

  it("does NOT touch the clipboard: duplicating is not copying", () => {
    const cb = clipboardStub();
    setClipboard(cb);
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    duplicateSelection();
    expect(cb.writeText).not.toHaveBeenCalled();
  });

  it("does nothing without a selection", () => {
    installScene([rect("n1")]);
    expect(duplicateSelection()).toEqual([]);
    expect([...useScene.getState().scene!.nodes.ids()]).toEqual(["n1"]);
  });
});

// --- shortcuts --------------------------------------------------------------

describe("attachClipboardShortcuts", () => {
  let detach: () => void = () => {};

  afterEach(() => {
    detach();
    detach = () => {};
    document.body.replaceChildren();
  });

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
    const e = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
  }

  it("Ctrl+D duplicates the selection", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    press("d");
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2);
  });

  it("Ctrl+C then Ctrl+V copy and paste", async () => {
    setClipboard(clipboardStub());
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    press("c");
    await vi.waitFor(() => expect(useScene.getState().selection).toEqual(["n1"]));
    press("v");
    await vi.waitFor(() => expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2));
  });

  it("ignores the shortcuts inside a text field (there copy belongs to the field)", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    const input = document.createElement("input");
    document.body.appendChild(input);

    press("d", {}, input);
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(1);
  });

  it("ignores a key without the modifier, and Ctrl+Shift+D (which is another shortcut)", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    press("d", { ctrlKey: false });
    press("d", { shiftKey: true });
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(1);
  });

  it("the cleanup really detaches the listener", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);
    detach();
    detach = () => {};

    press("d");
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(1);
  });

  it("prevents the default ONLY when it handles the key", () => {
    detach = attachClipboardShortcuts();
    installScene([rect("n1")]);
    useScene.getState().setSelection(["n1"]);

    const handled = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);

    const other = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});

// --- images (track 3) -------------------------------------------------------

function imageNode(id: string, hash: string, over: Partial<NodeLite> = {}): NodeLite {
  return rect(id, { kind: "image", cornerRadius: 0, name: "logo.png", image: { assetHash: hash }, ...over });
}

describe("clipboard: images", () => {
  it("copies and re-reads an image node keeping its hash", () => {
    // `image` is in KNOWN_KINDS: without it, this payload would have been rejected
    // as "unsupported" -- which is the guarantee that a NEW type is never pasted
    // degraded to a rectangle.
    const parsed = parseClipboard(serializeNodes([imageNode("n1", "abc123")]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.nodes[0].kind).toBe("image");
    expect(parsed.nodes[0].image?.assetHash).toBe("abc123");
  });

  it("an image without a readable hash pastes as a placeholder, it does not fail the paste", () => {
    const parsed = parseClipboard(JSON.stringify({
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      nodes: [{ id: "n1", kind: "image" }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.nodes[0].image?.assetHash).toBe("");
  });

  it("the paste gives a NEW id but the SAME hash: the bytes are not duplicated", () => {
    // It is content addressing that makes this correct: two nodes
    // pointing at the same sha256 are a single file on disk.
    const scene = emptyScene("doc-1", "Untitled");
    const { ops } = pasteOps(scene, [imageNode("n1", "abc123")]);
    const node = ops[0].kind.case === "createNode" ? ops[0].kind.value.node! : null;
    expect(node?.id).not.toBe("n1");
    expect(node?.shape.case).toBe("image");
    expect(node?.shape.case === "image" ? node.shape.value.assetHash : "").toBe("abc123");
  });
});
