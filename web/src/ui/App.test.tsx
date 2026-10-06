// jest-dom's matchers are already installed by the setupFiles (vite.config.ts);
// the import here serves TYPE-SCRIPT (tsc -b does not read the setupFiles), otherwise
// toBeInTheDocument/toHaveAttribute do not exist for the compiler.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { App, TOOLS, TOOL_LABELS, toolsForMode } from "./App";
import { textTool } from "../tools/textTool";
import { penTool } from "../tools/penTool";
import { frameTool } from "../tools/frameTool";
import { selectTool } from "../tools/selectTool";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import * as overlayRenderer from "../renderer/overlayRenderer";

// App's bootstrap talks to the network (createDocument + SyncClient): here
// only the toolbar is needed, so the transport is an inert double. Without it, every
// test would open a fetch towards a server that does not exist.
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
// --localstorage-file): without a stub the bootstrap fails and dirties the output with
// an error that has nothing to do with the toolbar. With a docId already in cache the
// bootstrap reaches attachTools, that is the real path.
vi.stubGlobal("localStorage", {
  getItem: () => "doc-1",
  setItem: () => {},
  removeItem: () => {},
});

afterEach(cleanup);
// The doubles installed with spyOn (getContext, drawOverlay) must be removed even
// when an assertion fails mid-test: without it, one red would drag others
// behind it and the real cause would vanish in the noise.
afterEach(() => vi.restoreAllMocks());

// The tool registry is the only point where a ToolId becomes REACHABLE:
// the text tool was complete and tested but appeared neither in TOOLS nor in the
// toolbar (bug found in review), so it did not exist for the user. These
// tests close exactly that hole -- between the two lists and between list and
// real tool.
describe("tool registry", () => {
  it("every toolbar button has ITS tool (no silent fallback to selectTool)", () => {
    for (const { id, label } of TOOL_LABELS) {
      const tool = TOOLS[id];
      expect(tool, `${label} (${id}) is not registered in TOOLS`).toBeDefined();
      // attachTools does `TOOLS[toolRef.current] ?? selectTool`: a missing
      // entry does not blow up, it falls back to Select -- a button that lies.
      if (id !== "select") expect(tool).not.toBe(selectTool);
    }
  });

  it("every registered tool declares the id it is registered with", () => {
    for (const [id, tool] of Object.entries(TOOLS)) {
      expect(tool!.id).toBe(id);
    }
  });

  it("every registered tool has a button in the toolbar", () => {
    const labelled = new Set(TOOL_LABELS.map((t) => t.id));
    for (const id of Object.keys(TOOLS)) {
      expect(labelled.has(id as (typeof TOOL_LABELS)[number]["id"]), `${id} has no button`).toBe(true);
    }
  });

  it("the text tool is registered and is the real textTool", () => {
    expect(TOOLS.text).toBe(textTool);
    expect(TOOL_LABELS.map((t) => t.label)).toEqual([
      "Select",
      "Connect",
      "Sticky note",
      "Link",
      "Frame",
      "Rectangle",
      "Ellipse",
      "Text",
      "Pen",
      "Hand",
      "Comment",
    ]);
    // The two board tools exist only in the Board.
    expect(toolsForMode("design").map((t) => t.label)).not.toContain("Link");
    expect(toolsForMode("board").map((t) => t.label)).toEqual(["Select", "Sticky note", "Link", "Text", "Pen", "Hand", "Comment"]);
  });

  it("the frame tool is registered and is the real frameTool", () => {
    expect(TOOLS.frame).toBe(frameTool);
  });

  it("the pen tool is registered and is the real penTool", () => {
    expect(TOOLS.pen).toBe(penTool);
  });
});

// The ToggleButtons of a single-selection ToggleButtonGroup expose
// role="radio" inside a role="radiogroup" (react-aria-components): it is the
// right semantics for "one tool at a time", and the tests query it
// as a screen reader would.
describe("toolbar", () => {
  it("shows a button for every tool, Text included", () => {
    render(<App />);
    // The shapes sit in a single button (the last used, by default
    // Rectangle) with the others behind "More shapes".
    for (const { id, label } of toolsForMode("design")) {
      if (id === "ellipse") continue;
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "More shapes" })).toBeInTheDocument();
    // "Connect" exists only in flows.
    expect(screen.queryByRole("radio", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("Ellipse is chosen from the shapes menu and takes the button's place", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "More shapes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ellipse/ }));
    const ellipse = screen.getByRole("radio", { name: "Ellipse" });
    expect(ellipse).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "Rectangle" })).not.toBeInTheDocument();
  });

  it("pressing Text really activates the text tool (the canvas cursor proves it)", () => {
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    expect(canvas.style.cursor).toBe(selectTool.cursor); // initial state: Select

    const textBtn = screen.getByRole("radio", { name: "Text" });
    fireEvent.click(textBtn);

    expect(textBtn).toHaveAttribute("aria-checked", "true");
    // The cursor comes from TOOLS[toolId]: "text" only if the key "text"
    // resolves to textTool. With the entry missing it would fall back to selectTool
    // ("default") without telling anyone.
    expect(canvas.style.cursor).toBe(textTool.cursor);
    expect(textTool.cursor).toBe("text");
  });

  it("pressing Pen really activates the pen tool", () => {
    render(<App />);
    const penBtn = screen.getByRole("radio", { name: "Pen" });
    fireEvent.click(penBtn);
    expect(penBtn).toHaveAttribute("aria-checked", "true");
    // The cursor alone would not be enough to tell it apart (rect and ellipse use
    // the same "crosshair"): it is TOOLS.pen === penTool, verified above, that
    // says the button really routes to the pen tool.
    expect(TOOLS.pen!.cursor).toBe("crosshair");
  });
});

// The pen tool's preview exists only if someone DRAWS it: App is the only
// place where the store channel (penPreview) meets the overlay. Without
// this line the pen tool would work -- right ops, right gesture -- and
// the user would draw blind until the last click. It is the same hole as the
// tool not registered in TOOLS, one floor down.
describe("drawing loop", () => {
  it("passes the pen tool's preview to the overlay", async () => {
    // jsdom does not implement getContext: without a double, drawOverlay would never
    // be called (App skips drawing when the context is missing). The double is
    // a Proxy that answers ANY method with a no-op: the loop draws
    // the scene first and then the overlay, and a missing method in the middle
    // would switch off the loop (the exception dies inside the requestAnimationFrame)
    // before reaching what we are measuring.
    const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
    const fakeCtx = new Proxy(target, {
      get: (t, p) => (p in t ? t[p] : () => {}),
    }) as unknown as CanvasRenderingContext2D;
    // `as never`: canvaskit-wasm's types add the WebGPU overload to getContext, and
    // mockReturnValue takes the type of the LAST overload.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
    const drawOverlay = vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);

    const pen = {
      anchors: [{ x: 1, y: 2, inX: 0, inY: 0, outX: 0, outY: 0 }],
      next: { x: 9, y: 9 },
      active: null,
      closed: false,
    };
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    useScene.getState().setPenPreview(pen);

    render(<App />);

    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    // Seventh argument: the pen tool's preview, exactly the store's one
    // (the sixth is now `snapGuides`, added by the rotation track).
    expect(drawOverlay.mock.calls.at(-1)![6]).toBe(pen);

    useScene.getState().setPenPreview(null);
  });
});

// The same toolbar tests, for the same reason, applied to the PANELS:
// LayersPanel and PropertiesPanel are complete and tested components, but as long as
// nobody mounts them they do not exist for whoever uses the app. App.tsx is the only place
// where they become reachable.
describe("three-column layout", () => {
  it("mounts the layers panel to the LEFT of the canvas and the properties one to the RIGHT", () => {
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    const layers = screen.getByRole("grid", { name: "Layers" });
    const props = screen.getByText("Properties");

    expect(layers).toBeInTheDocument();
    expect(props).toBeInTheDocument();

    // The ORDER in the document is the order of the columns: layers, canvas,
    // properties. compareDocumentPosition is the direct way to ask the DOM
    // without depending on Tailwind classes.
    const before = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(layers.compareDocumentPosition(canvas) & before).toBeTruthy();
    expect(canvas.compareDocumentPosition(props) & before).toBeTruthy();
  });

  it("the panels do not sit ON TOP of the canvas: they are its siblings, they do not cover it", () => {
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    const layers = screen.getByRole("grid", { name: "Layers" });
    // If a panel contained the canvas (or vice versa) the layout would be an
    // overlay: its events would reach the canvas below and its
    // width would not be taken out of resizeCanvasToDisplaySize's calculation.
    expect(layers.contains(canvas)).toBe(false);
    expect(canvas.contains(layers)).toBe(false);
  });
});


// Same principle as the tool registry: tools/clipboard.ts is complete and
// tested, but as long as App does not mount it Ctrl+C/V/D do not exist for whoever uses
// the app. Here only the MOUNTING is verified (the behavior is in
// tools/clipboard.test.ts) and the fact that unmounting detaches the listeners.
describe("clipboard shortcuts", () => {
  function installScene() {
    const scene = emptyScene("doc-1", "Untitled");
    scene.nodes = scene.nodes.set("n1", {
      id: "n1", parentId: "page1", orderKey: "a000001", name: "Rectangle",
      visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    });
    useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], sync: null });
    useScene.getState().setScene(scene);
    useScene.getState().setSelection(["n1"]);
  }

  it("Ctrl+D duplicates: the app really mounts the shortcuts", () => {
    render(<App />);
    installScene();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2);
  });

  it("unmounting the app detaches them", () => {
    const { unmount } = render(<App />);
    installScene();
    unmount();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(1);
  });
});


// Same principle as the tool registry and the shortcuts: export/ is
// complete and tested, but as long as the properties panel does not mount it export
// does not exist for whoever uses the app. Here only the mounting is verified (the
// behavior is in ui/ExportSection.test.tsx). Export is no longer in the
// toolbar: it lives in the properties panel, and appears only with a selection.
describe("export", () => {
  it("without a selection, Export is nowhere", () => {
    // Explicit reset: other tests in this file leave a selection in the
    // global store (e.g. "clipboard shortcuts" above), and here we need
    // REALLY no selection.
    useScene.setState({ selection: [] });
    render(<App />);
    const toolbar = screen.getByRole("toolbar", { name: "Tools" });
    expect(within(toolbar).queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });

  it("with a selection, the properties panel mounts the Export section", () => {
    const scene = emptyScene("doc-1", "Untitled");
    scene.nodes = scene.nodes.set("n1", {
      id: "n1", parentId: "page1", orderKey: "a000001", name: "Rectangle",
      visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    });
    useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], sync: null });
    useScene.getState().setScene(scene);
    useScene.getState().setSelection(["n1"]);
    // The state is set BEFORE the render (not after, as in the clipboard
    // tests above): there App must be mounted empty and then the state changed
    // to verify the listeners stay attached; here it is only needed that the
    // panel is born already with the selection, without the round trip of a fireEvent that
    // forces react to absorb an update outside a gesture.
    render(<App />);
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });
});

import { docIdFromHash } from "./App";

describe("docIdFromHash", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  it("reads the id from the invite link", () => {
    expect(docIdFromHash(`#doc=${id}`)).toBe(id);
    expect(docIdFromHash(`#doc=${id.toUpperCase()}`)).toBe(id);
  });
  it("ignores everything that is not a well-formed id", () => {
    expect(docIdFromHash("")).toBeNull();
    expect(docIdFromHash("#doc=")).toBeNull();
    expect(docIdFromHash("#doc=../../etc/passwd")).toBeNull();
    expect(docIdFromHash(`#altro=${id}`)).toBeNull();
    expect(docIdFromHash(`#doc=${id}x`)).toBeNull();
  });
});

// The drawing loop is ON INVALIDATION: an idle editor does not redraw. It used to
// run at 60 fps always, even without any change.
describe("on-invalidation drawing loop", () => {
  function setupCtx() {
    const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
    const fakeCtx = new Proxy(target, {
      get: (t, p) => (p in t ? t[p] : () => {}),
    }) as unknown as CanvasRenderingContext2D;
    // `as never`: canvaskit-wasm's types add the WebGPU overload to getContext, and
    // mockReturnValue takes the type of the LAST overload.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
    return vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("when idle it does not redraw; every visible change produces one", async () => {
    const drawOverlay = setupCtx();
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);

    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    await sleep(80); // let the settling frames run out
    const idle = drawOverlay.mock.calls.length;
    await sleep(250);
    expect(drawOverlay.mock.calls.length).toBe(idle); // no rAF around

    useScene.getState().setSelection(["x"]);
    await waitFor(() => expect(drawOverlay.mock.calls.length).toBeGreaterThan(idle));
    const afterSelection = drawOverlay.mock.calls.length;
    await sleep(120);
    expect(drawOverlay.mock.calls.length).toBe(afterSelection);

    useScene.getState().setCamera({ x: 5, y: 5, zoom: 2 });
    await waitFor(() => expect(drawOverlay.mock.calls.length).toBeGreaterThan(afterSelection));
  });

  it("many invalidations in the same frame produce ONE drawing", async () => {
    const drawOverlay = setupCtx();
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    await sleep(80);
    const before = drawOverlay.mock.calls.length;
    for (let i = 0; i < 25; i++) useScene.getState().setCamera({ x: i, y: 0, zoom: 1 });
    await sleep(120);
    expect(drawOverlay.mock.calls.length - before).toBeLessThanOrEqual(2);
    expect(drawOverlay.mock.calls.length - before).toBeGreaterThanOrEqual(1);
  });
});
