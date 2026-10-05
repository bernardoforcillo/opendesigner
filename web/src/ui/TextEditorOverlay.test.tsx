// jest-dom's matchers are already installed by the setupFiles (vite.config.ts);
// the import here serves TYPE-SCRIPT (tsc -b does not read the setupFiles).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { TextEditorOverlay } from "./TextEditorOverlay";
import { App } from "./App";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

// App talks to the network at bootstrap (createDocument + SyncClient): it is only needed
// in the undo/redo guard test, and there an inert transport is enough.
vi.mock("../rpc/client", () => ({
  docClient: { createDocument: vi.fn(async () => ({ id: "doc-1" })) },
}));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));
// jsdom here does not expose localStorage (Node disables it without
// --localstorage-file): with a docId in cache App's bootstrap does not fail.
vi.stubGlobal("localStorage", {
  getItem: () => "doc-1",
  setItem: () => {},
  removeItem: () => {},
});

// SyncClient double: records the ops that end up ON THE WIRE and models a
// server that accepts and ECHOES at once (applyPending + apply), as in the other
// store tests.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function textNode(id: string, content: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 10, y: 20, width: 200, height: 24, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
    kind: "text", cornerRadius: 0, clipsContent: false,
    text: {
      content,
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.5, align: "left" },
    },
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

function deleteOp(id: string): Op {
  return create(OpSchema, { opId: "del-" + id, docId: "doc-1", kind: { case: "deleteNode", value: { id } } });
}

let sync: FakeSync;

// The editing field, looked up by ACCESSIBLE NAME and not by role alone:
// since App also mounts the properties panel (ui/App.tsx, the three columns)
// any "textbox" could be the panel's X field. The name is the one
// the overlay declares (aria-label), so the query stays identical both for
// the overlay mounted alone and for the whole app.
const FIELD_NAME = "Text content";

function field(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: FIELD_NAME }) as HTMLTextAreaElement;
}

function content(id = "t1"): string | undefined {
  return useScene.getState().scene?.nodes.at(id)?.text?.content;
}

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    gesture: null,
    editingNodeId: null,
  });
  installScene(textNode("t1", "hello"));
  useScene.getState().setSync(sync);
  useScene.getState().setSelection(["t1"]);
  // The flag is turned on by whoever enters editing (textTool / selectTool's double click):
  // the overlay finds it already on and turns it off on exit.
  useScene.setState({ editingNodeId: "t1" });
});

afterEach(cleanup);

// --- Step 1: positioning -------------------------------------------------

describe("positioning", () => {
  it("sits on the node: origin from worldToScreen, measures in SCREEN px", () => {
    useScene.setState({ camera: { x: 5, y: 7, zoom: 2 } });
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = field();

    expect(ta.style.left).toBe("25px"); // 10 * 2 + 5
    expect(ta.style.top).toBe("47px"); // 20 * 2 + 7
    expect(ta.style.width).toBe("400px"); // 200 * 2
    expect(ta.style.fontSize).toBe("32px"); // 16 * 2
    expect(ta.style.lineHeight).toBe("48px"); // 16 * 1.5 * 2
    // The field covers at least the node's box: it is what hides the text
    // drawn on the canvas (see the component's comment).
    expect(ta.style.minHeight).toBe("48px"); // 24 * 2
  });

  it("resolves the renderer's defaults when the style does not specify them", () => {
    installScene(textNode("t1", "hello", {
      text: { content: "hello", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
    }));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    // DEFAULT_FONT_SIZE = 16, DEFAULT_LINE_HEIGHT = 1.2 (renderer/text.ts)
    expect(field().style.fontSize).toBe("16px");
    expect(field().style.lineHeight).toBe("19.2px");
  });

  it("stays OPAQUE even on a semi-transparent node: it is what covers the canvas text", () => {
    installScene(textNode("t1", "hello", { opacity: 0.2 }));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    // With the node's opacity applied to the field, the background would become
    // semi-transparent and the text drawn underneath would show through: two overlapping,
    // offset texts, that is the flaw the coverage avoids.
    expect(field().style.opacity).toBe("");
  });

  // The field COVERS the glyphs drawn on the canvas: it is the invariant on which
  // the whole choice of the opaque field rests (see the component's comment). A
  // ROTATED node broke it: drawScene drew the text turned (it rotates the context
  // around the center of the box) and the field stayed straight on top -- the text
  // was seen TWICE, at two different angles.
  describe("on a ROTATED node", () => {
    it("rotates with the node, around the center of its box", () => {
      installScene(textNode("t1", "hello", { rotation: 30 }));
      useScene.setState({ editingNodeId: "t1" });
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      // same convention as the renderer: degrees, clockwise, around the CENTER of the
      // node's box (200x24 at zoom 1 -> 100px, 12px from the field's corner)
      expect(ta.style.transform).toBe("rotate(30deg)");
      expect(ta.style.transformOrigin).toBe("100px 12px");
      // the origin stays the model's: it is the field that rotates, not the point
      expect(ta.style.left).toBe("10px");
      expect(ta.style.top).toBe("20px");
    });

    it("keeps the pivot in SCREEN px even under zoom", () => {
      installScene(textNode("t1", "hello", { rotation: 90 }));
      useScene.setState({ editingNodeId: "t1", camera: { x: 0, y: 0, zoom: 2 } });
      render(<TextEditorOverlay nodeId="t1" />);

      expect(field().style.transform).toBe("rotate(90deg)");
      expect(field().style.transformOrigin).toBe("200px 24px"); // (200/2, 24/2) * 2
    });

    it("a NULL angle writes no transform", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      expect(field().style.transform).toBe("");
      expect(field().style.transformOrigin).toBe("");
    });
  });

  it("a NESTED node is positioned on its WORLD origin, not the local one", () => {
    // page1 > g(100,50) > t1(10,20): the field must cover the text where the
    // canvas draws it, that is at (110,70). With local coordinates it would end up at
    // (10,20) -- very far from the node being edited.
    const g: NodeLite = {
      id: "g", parentId: "page1", orderKey: "a0", name: "g", visible: true, opacity: 1,
      x: 100, y: 50, width: 400, height: 400, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    };
    installScene(g, textNode("t1", "hello", { parentId: "g" }));
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    expect(field().style.left).toBe("110px");
    expect(field().style.top).toBe("70px");
  });

  it("repositions at every camera change: pan and zoom do not detach it from the node", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    expect(field().style.left).toBe("10px");

    act(() => useScene.getState().setCamera({ x: 100, y: 40, zoom: 1 }));
    expect(field().style.left).toBe("110px");
    expect(field().style.top).toBe("60px");

    act(() => useScene.getState().setCamera({ x: 0, y: 0, zoom: 4 }));
    expect(field().style.left).toBe("40px");
    expect(field().style.width).toBe("800px");
    expect(field().style.fontSize).toBe("64px");
  });
});

// --- Step 5: focus and cursor ------------------------------------------------

describe("entering editing", () => {
  it("takes focus on its own and puts the cursor at the END of the text", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = field();

    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("hello");
    expect(ta.selectionStart).toBe(5);
    expect(ta.selectionEnd).toBe(5);
  });

  it("opens ONE gesture on mount (the whole session is a single gesture)", () => {
    expect(useScene.getState().gesture).toBeNull();
    render(<TextEditorOverlay nodeId="t1" />);
    expect(useScene.getState().gesture).not.toBeNull();
  });
});

// --- Step 2: gesture lifecycle ---------------------------------------

describe("preview while writing", () => {
  it("every change is an applyLocal: it shows on the canvas but does not go on the wire", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " world");

    expect(content()).toBe("hello world");
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).not.toBeNull();
  });

  it("a long session does not accumulate a preview per key", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "0123456789");

    expect(useScene.getState().gesture!.preview.size).toBe(1);
    expect(content()).toBe("hello0123456789");
  });
});

describe("exit with commit", () => {
  it("sends ONE SINGLE setText and leaves ONE undo entry", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " world");
    fireEvent.blur(field());

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setText");
    expect(sync.sent[0].kind.case === "setText" && sync.sent[0].kind.value.content).toBe("hello world");
    expect(content()).toBe("hello world");
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("the WHOLE session is ONE undo entry: ten keys, a single Ctrl+Z", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "0123456789");
    fireEvent.blur(field());
    expect(content()).toBe("hello0123456789");

    act(() => useScene.getState().undo());

    // A single step back returns to the STARTING content, not to the
    // second-to-last character.
    expect(content()).toBe("hello");
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().canRedo).toBe(true);
  });

  it("Tab commits (focus leaves the field)", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "!");
    await userEvent.tab();

    expect(sync.sent).toHaveLength(1);
    expect(content()).toBe("hello!");
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("leaving without having changed anything sends nothing and does not dirty the history", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    fireEvent.blur(field());

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().editingNodeId).toBeNull();
    expect(content()).toBe("hello");
  });
});

// --- Step 3: exit ---------------------------------------------------------

describe("exit with Escape", () => {
  it("cancels: nothing on the wire, nothing in the history, starting content", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " discarded");
    expect(content()).toBe("hello discarded");

    fireEvent.keyDown(field(), { key: "Escape" });

    expect(sync.sent).toHaveLength(0);
    expect(content()).toBe("hello");
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("on a just-created (empty) node cancelling makes it disappear, in an undoable way", async () => {
    installScene(textNode("t1", ""));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "abc");

    fireEvent.keyDown(field(), { key: "Escape" });

    // The node had stayed empty: the store's policy (endTextEditing) deletes
    // it instead of leaving a ghost on the scene -- but going through a
    // gesture, so with its Ctrl+Z.
    expect(useScene.getState().scene!.nodes.at("t1")).toBeUndefined();
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deleteNode");
    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
  });
});

describe("Enter", () => {
  it("makes a newline and does NOT commit: it is a multiline editor", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), "{Enter}line2");

    expect(field().value).toBe("hello\nline2");
    expect(content()).toBe("hello\nline2");
    expect(useScene.getState().editingNodeId).toBe("t1");
    expect(useScene.getState().gesture).not.toBeNull();
    expect(sync.sent).toHaveLength(0);
  });
});

// --- Step 4: global shortcuts stay out ---------------------------

describe("global shortcuts while writing", () => {
  it("Ctrl+Z inside the field does not reach the app's undo (and outside it does)", () => {
    // The field here comes from the real App (which mounts it by itself when
    // editingNodeId is set): the guard is verified on the mounted app,
    // not on an overlay placed alongside by hand.
    render(<App />);

    // App.tsx's isTextField guard exits BEFORE preventDefault: if
    // the event was not cancelled, the shortcut did not even
    // consider it -- the field's native undo stays the browser's.
    const inField = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      field().dispatchEvent(inField);
    });
    expect(inField.defaultPrevented).toBe(false);

    const outside = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(outside);
    });
    expect(outside.defaultPrevented).toBe(true);
  });

  it("Backspace in the field does not delete the selected node", async () => {
    render(<App />);
    expect(useScene.getState().selection).toEqual(["t1"]);

    await userEvent.type(field(), "{Backspace}{Backspace}");

    expect(field().value).toBe("hel");
    expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
    expect(sync.sent).toHaveLength(0);
  });
});

// --- Step 5: accents and IME --------------------------------------------------

describe("accents and IME", () => {
  it("accents arrive intact up to the final op", async () => {
    installScene(textNode("t1", ""));
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    await userEvent.type(field(), "café{Enter}naïve");
    fireEvent.blur(field());

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case === "setText" && sync.sent[0].kind.value.content).toBe("café\nnaïve");
  });

  it("an IME composition is not lost: the field's value counts, not the keys", () => {
    render(<TextEditorOverlay nodeId="t1" />);
    const ta = field();

    // Typical IME sequence: no useful keydown, only composition +
    // input. The overlay reads the field's VALUE, so it sees all of it.
    fireEvent.compositionStart(ta);
    fireEvent.change(ta, { target: { value: "hello に" } });
    fireEvent.compositionEnd(ta, { data: "に" });

    expect(content()).toBe("hello に");
    fireEvent.blur(ta);
    expect(sync.sent[0].kind.case === "setText" && sync.sent[0].kind.value.content).toBe("hello に");
  });

  // Bug found in review: Escape was handled UNCONDITIONALLY. With an IME
  // open that key is the standard way to reject a conversion (it closes
  // the candidates window), and treating it as "cancel everything" threw away
  // the whole editing session -- precisely with the languages the DOM
  // overlay exists for.
  describe("Escape while the IME is composing", () => {
    it("does not close the session: that key belongs to the IME", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      fireEvent.compositionStart(ta);
      fireEvent.change(ta, { target: { value: "hello に" } });
      // The user rejects the candidate: the IME closes, the editing does NOT.
      fireEvent.keyDown(ta, { key: "Escape" });

      expect(screen.queryByRole("textbox", { name: FIELD_NAME })).not.toBeNull();
      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().gesture).not.toBeNull();
      expect(content()).toBe("hello に");
      expect(sync.sent).toHaveLength(0);
    });

    it("becomes ours again as soon as the composition ends", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      fireEvent.compositionStart(ta);
      fireEvent.change(ta, { target: { value: "hello に" } });
      fireEvent.compositionEnd(ta, { data: "に" });

      fireEvent.keyDown(ta, { key: "Escape" });

      // Now Escape cancels as always: starting content, nothing on the
      // wire, nothing in the history.
      expect(useScene.getState().editingNodeId).toBeNull();
      expect(useScene.getState().gesture).toBeNull();
      expect(content()).toBe("hello");
      expect(sync.sent).toHaveLength(0);
    });

    it("also honors isComposing and keyCode 229, which some browsers send on their own", () => {
      render(<TextEditorOverlay nodeId="t1" />);
      const ta = field();

      // No compositionstart seen by us (the order of events varies from
      // browser to browser): the standard flag on the event remains...
      fireEvent.keyDown(ta, { key: "Escape", isComposing: true });
      expect(useScene.getState().editingNodeId).toBe("t1");

      // ...and the old "key being processed by the IME".
      fireEvent.keyDown(ta, { key: "Escape", keyCode: 229 });
      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().gesture).not.toBeNull();

      // A normal Escape, instead, exits.
      fireEvent.keyDown(ta, { key: "Escape" });
      expect(useScene.getState().editingNodeId).toBeNull();
    });
  });
});

// --- the wiring in the app -----------------------------------------------------
//
// A component nobody mounts is dead code: the text could be created
// but not written. These tests close that hole -- it is the same shape
// as the "the text tool was not in the toolbar" bug (see App.test.tsx).
describe("App mounts the overlay", () => {
  it("when there is a node being edited the field exists and is LIVE", async () => {
    render(<App />);

    const ta = field();
    expect(ta.value).toBe("hello");
    expect(document.activeElement).toBe(ta);

    await userEvent.type(ta, " world");
    fireEvent.blur(ta);

    // It is not enough for the field to appear: it must be connected to the real store.
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setText");
    expect(content()).toBe("hello world");
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("without editing there is no field (and no open gesture)", () => {
    useScene.setState({ editingNodeId: null });
    render(<App />);

    expect(screen.queryByRole("textbox", { name: FIELD_NAME })).toBeNull();
    expect(useScene.getState().gesture).toBeNull();
  });

  it("changing the node being edited moves the field to the other node", () => {
    installScene(textNode("t1", "first"), textNode("t2", "second", { x: 300 }));
    useScene.setState({ editingNodeId: "t1" });
    render(<App />);
    expect(field().value).toBe("first");

    act(() => useScene.getState().beginTextEditing("t2"));

    expect(field().value).toBe("second");
    expect(field().style.left).toBe("300px");
  });
});

// --- robustness -------------------------------------------------------------

describe("the node disappears while it is being edited", () => {
  it("a remote delete closes the session without leaving a gesture open", async () => {
    render(<TextEditorOverlay nodeId="t1" />);
    await userEvent.type(field(), " world");

    act(() => useScene.getState().apply(deleteOp("t1")));

    expect(screen.queryByRole("textbox", { name: FIELD_NAME })).toBeNull();
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();
    expect(sync.sent).toHaveLength(0);
  });

  it("a node that is not text opens no field", () => {
    installScene({ ...textNode("t1", "hello"), kind: "rect", text: undefined });
    useScene.setState({ editingNodeId: "t1" });
    render(<TextEditorOverlay nodeId="t1" />);

    expect(screen.queryByRole("textbox", { name: FIELD_NAME })).toBeNull();
  });
});
