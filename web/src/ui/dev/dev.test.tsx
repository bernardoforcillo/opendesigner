import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Op } from "../../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../../store/store";
import { useFlowUi } from "../../store/flowUi";
import { useAnalysis, setAnalysisFetcher } from "../../flow/analysis";
import { nodesWith } from "../../store/nodeMap";
import { emptyScene } from "../../store/types";
import { baseScene, flowOf, transition, withFlows } from "../../flow/testSupport";
import { resetCodegen, setCodeFetcher, type CodeFetcher, type CodeFile } from "../../dev/codegen";
import { ReadinessPanel } from "./ReadinessPanel";
import { ShipPanel } from "./ShipPanel";
import { CodeWorkbench } from "./CodeWorkbench";
import { PipelineStepper, goToStep } from "./PipelineStepper";
import { usePanels } from "../shell/panels";

// THE THREE DEVELOP PANELS with a fake RPC: the checklist and its one-click
// fixes (one gesture = one undo), Ship (the zip and the commands), the code view
// (loading/error states, file <-> screen, preview) and the stepper.

const downloads: { name: string; bytes: Uint8Array }[] = [];
vi.mock("../../dev/zip", async (orig) => ({
  ...(await orig<typeof import("../../dev/zip")>()),
  downloadBytes: (name: string, bytes: Uint8Array) => { downloads.push({ name, bytes }); return true; },
}));

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const f = (path: string, text: string): CodeFile => ({ path, bytes: enc(text) });
const reactFiles = (): CodeFile[] => [
  f("src/screens/A.tsx", '<div data-node-id="A" className="x">A</div>'),
  f("src/screens/B.tsx", '<div data-node-id="B" className="y">B</div>'),
  f("src/App.tsx", "export default function App() {}"),
  f("package.json", '{"name":"x"}'),
  f("tests/flows.spec.ts", "test('x', () => {})"),
];
const htmlFiles = (): CodeFile[] => [
  f("index.html", '<html><body><div data-node-id="A">Page A</div><a href="b.html">go</a></body></html>'),
  f("b.html", '<html><body><div data-node-id="B">Page B</div></body></html>'),
];
const ok: CodeFetcher = async (_d, target) => ({ files: target === "html" ? htmlFiles() : reactFiles(), warnings: [] });

let sync: FakeSync;
beforeEach(() => {
  downloads.length = 0;
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "dev", currentFlowId: null, presenting: false });
  useAnalysis.setState({ reports: {}, status: "idle", error: null, docId: null });
  setAnalysisFetcher(async () => []);
  setCodeFetcher(ok);
  resetCodegen();
  useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "A", "Purchase")], [transition("t1", "f1", "A", "B", { label: "Avanti" })]));
  useScene.getState().setSync(sync);
  try { localStorage.clear(); } catch { /* */ }
});
afterEach(() => {
  cleanup();
  setCodeFetcher();
  setAnalysisFetcher();
});

const withReport = (issues: { kind: string; nodeId?: string }[] = []) =>
  useAnalysis.setState({
    reports: { f1: { flowId: "f1", issues: issues.map((i) => ({ nodeId: "", transitionId: "", message: `msg ${i.kind}`, ...i })) } as never },
    docId: "doc",
  });

describe("ReadinessPanel", () => {
  it("shows the blockers and the fixes; 'Assign routes' writes ALL the routes in ONE gesture (a single Ctrl+Z)", () => {
    withReport();
    render(<ReadinessPanel />);
    expect(screen.getByText("3 blockers")).toBeInTheDocument();
    expect(screen.getByTestId("ready-routes")).toHaveAttribute("data-state", "fail");

    fireEvent.click(screen.getByRole("button", { name: "Assign routes" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setProps", "setProps", "setProps"]);
    const nodes = useScene.getState().scene!.nodes;
    expect(["A", "B", "C"].map((id) => nodes.at(id)!.meta?.["code.route"])).toEqual(["/a", "/b", "/c"]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // resolved: the badge becomes "Ready" and the row passes
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByTestId("ready-routes")).toHaveAttribute("data-state", "pass");

    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("A")!.meta?.["code.route"]).toBeUndefined();
  });

  it("'Set the start' sets the entry screen of flows that lack one", () => {
    useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "")], [transition("t1", "f1", "B", "C", { label: "x" })]));
    withReport();
    render(<ReadinessPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Set the start" }));
    expect(useScene.getState().scene!.flows.f1.startId).toBe("B");
    expect(screen.getByTestId("ready-start")).toHaveAttribute("data-state", "pass");
  });

  it("'Select the screen' leads to the problem's screen", () => {
    withReport([{ kind: "unreachable", nodeId: "C" }]);
    render(<ReadinessPanel />);
    const row = screen.getByTestId("ready-issue:unreachable");
    expect(row).toHaveAttribute("data-state", "fail");
    fireEvent.click(within(row).getByRole("button", { name: "Select the screen" }));
    expect(useScene.getState().selection).toEqual(["C"]);
  });

  it("without server analysis the dependent rows are 'pending' and do not count as blockers", () => {
    useScene.getState().setScene(withFlows(
      baseScene(), [flowOf("f1", "A")], [transition("t1", "f1", "A", "B", { label: "x" })],
    ));
    render(<ReadinessPanel />);
    expect(screen.getByTestId("ready-analysis")).toHaveAttribute("data-state", "pending");
    expect(screen.getByText("3 blockers")).toBeInTheDocument(); // only the three routes
  });

  it("the progress bar counts the states", () => {
    const s = baseScene();
    const tested = { ...s.nodes.at("A")!, meta: { status: "tested" } };
    useScene.getState().setScene({ ...s, nodes: nodesWith(s.nodes, { A: tested }) });
    withReport();
    render(<ReadinessPanel />);
    expect(screen.getByRole("img", { name: /1 tested, 0 implemented, 2 planned out of 3/ })).toBeInTheDocument();
  });
});

describe("ShipPanel", () => {
  it("downloads <doc>-react.zip with the generated files (regenerating at click time)", async () => {
    const spy = vi.fn(ok);
    setCodeFetcher(spy);
    withReport();
    render(<ShipPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^t-react\.zip$/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("t-react.zip");
    expect(spy).toHaveBeenCalledWith("doc", "react", expect.anything());
    expect(Array.from(downloads[0].bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);
  });

  it("a server error is reported, and nothing is downloaded", async () => {
    setCodeFetcher(async () => { throw new Error("down"); });
    render(<ShipPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^t-react\.zip$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("down");
    expect(downloads).toHaveLength(0);
  });

  it("shows the copyable commands and the tools for agents; 'Copy all' copies the script", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ShipPanel />);
    expect(screen.getByText("npx playwright test")).toBeInTheDocument();
    expect(screen.getByText("opendesigner flow check -doc t")).toBeInTheDocument();
    for (const tool of ["export_code", "get_flow_spec", "analyze_flows"]) expect(screen.getByText(tool)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const script = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain("npm i && npm run dev");
    expect(script).toContain("opendesigner flow coverage");
  });

  it("without screens the zip button is disabled", () => {
    useScene.getState().setScene(emptyScene("doc", "t"));
    render(<ShipPanel />);
    expect(screen.getByRole("button", { name: /^t-react\.zip$/ })).toBeDisabled();
  });
});

describe("CodeWorkbench", () => {
  it("generates the code, groups the files and shows the first screen file", async () => {
    render(<CodeWorkbench />);
    expect(await screen.findByTestId("code-text")).toHaveTextContent('data-node-id="A"');
    const nav = screen.getByRole("navigation", { name: "Generated files" });
    for (const name of ["Screens", "App", "Configuration", "Test"]) expect(within(nav).getByRole("region", { name })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "src/screens/A.tsx" })).toHaveAttribute("aria-current", "true");
  });

  it("the screen selected in the document selects its file, and vice versa", async () => {
    render(<CodeWorkbench />);
    await screen.findByTestId("code-text");
    act(() => useScene.getState().setSelection(["B"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "src/screens/B.tsx" })).toHaveAttribute("aria-current", "true"));
    // a child of the screen (btn is inside A) selects A's file
    act(() => useScene.getState().setSelection(["btn"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "src/screens/A.tsx" })).toHaveAttribute("aria-current", "true"));
    // clicking a screen file selects the screen in the document
    fireEvent.click(screen.getByRole("button", { name: "src/screens/B.tsx" }));
    expect(useScene.getState().selection).toEqual(["B"]);
    // a file that is not a screen opens without touching the selection
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    expect(screen.getByTestId("code-text")).toHaveTextContent('"name"');
    expect(useScene.getState().selection).toEqual(["B"]);
  });

  it("loading state, then error with 'Retry' that redoes the request", async () => {
    let fail = true;
    setCodeFetcher(async (d, t, s) => {
      if (fail) throw new Error("server down");
      return ok(d, t, s);
    });
    render(<CodeWorkbench />);
    expect(await screen.findByText("Cannot generate the code")).toBeInTheDocument();
    expect(screen.getByText("server down")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("code-text")).toBeInTheDocument();
  });

  it("while loading it says it is generating", async () => {
    setCodeFetcher(() => new Promise(() => {}));
    render(<CodeWorkbench />);
    expect((await screen.findAllByText("Generating the code…")).length).toBeGreaterThan(0);
  });

  it("the HTML target shows the HTML files; 'Preview' puts the generated screen in a sandboxed iframe", async () => {
    render(<CodeWorkbench />);
    await screen.findByTestId("code-text");
    fireEvent.click(screen.getByRole("radio", { name: "HTML" }));
    expect(await screen.findByRole("button", { name: "index.html" })).toBeInTheDocument();

    expect(screen.queryByTitle("Preview of the generated screen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const frame = (await screen.findByTitle("Preview of the generated screen")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); // no allow-same-origin
    expect(frame.getAttribute("srcdoc")).toContain("Page A");

    // selecting B shows B
    act(() => useScene.getState().setSelection(["B"]));
    await waitFor(() => expect((screen.getByTitle("Preview of the generated screen") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("Page B"));
  });

  it("a click on a link inside the preview (postMessage) changes the shown and selected screen", async () => {
    render(<CodeWorkbench />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const frame = (await screen.findByTitle("Preview of the generated screen")) as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("Page A"));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { odPreviewNav: "b.html" }, source: frame.contentWindow }));
    });
    await waitFor(() => expect(screen.getByTitle("Preview of the generated screen").getAttribute("srcdoc")).toContain("Page B"));
    expect(useScene.getState().selection).toEqual(["B"]);
    // a message from another window is ignored
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { odPreviewNav: "index.html" }, source: window }));
    });
    expect(screen.getByTitle("Preview of the generated screen").getAttribute("srcdoc")).toContain("Page B");
  });

  it("a very long file is mounted in pieces: 'Show all lines'", async () => {
    const long = Array.from({ length: 2000 }, (_, i) => `const a${i} = ${i};`).join("\n");
    setCodeFetcher(async () => ({ files: [f("src/screens/A.tsx", `<div data-node-id="A"/>\n${long}`)], warnings: [] }));
    render(<CodeWorkbench />);
    const more = await screen.findByRole("button", { name: /Show all 2001 lines/ });
    expect(screen.getByTestId("code-text").textContent).not.toContain("a1999");
    fireEvent.click(more);
    expect(screen.getByTestId("code-text").textContent).toContain("a1999");
  });

  it("the generator's approximations can be opened", async () => {
    setCodeFetcher(async () => ({ files: reactFiles(), warnings: ["missing asset"] }));
    render(<CodeWorkbench />);
    fireEvent.click(await screen.findByRole("button", { name: /1 approssimazione/ }));
    expect(screen.getByText("missing asset")).toBeInTheDocument();
  });

  it("outside Develop there is no work: unmounted, the in-flight request is cancelled", async () => {
    let signal!: AbortSignal;
    setCodeFetcher((_d, _t, s) => { signal = s; return new Promise(() => {}); });
    const { unmount } = render(<CodeWorkbench />);
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("PipelineStepper", () => {
  it("shows the four steps with the state derived from the document", async () => {
    withReport();
    render(<PipelineStepper />);
    const nav = screen.getByRole("navigation", { name: "Pipeline" });
    const step = (id: string) => nav.querySelector(`[data-step="${id}"]`)!;
    expect(step("draw")).toHaveAttribute("data-done", "true");
    expect(step("connect")).toHaveAttribute("data-done", "true");
    expect(step("try")).toHaveAttribute("data-done", "false");
    expect(step("ship")).toHaveAttribute("data-done", "false"); // 3 routes missing
    expect(step("ship")).toHaveAttribute("aria-current", "step"); // we are in Develop
  });

  it("clicks lead to where the work is", () => {
    withReport();
    render(<PipelineStepper />);
    const nav = screen.getByRole("navigation", { name: "Pipeline" });
    fireEvent.click(nav.querySelector('[data-step="draw"]')!);
    expect(useFlowUi.getState().mode).toBe("design");
    fireEvent.click(nav.querySelector('[data-step="connect"]')!);
    expect(useFlowUi.getState().mode).toBe("flows");
    expect(useFlowUi.getState().presenting).toBe(false);
    fireEvent.click(nav.querySelector('[data-step="try"]')!);
    expect(useFlowUi.getState()).toMatchObject({ mode: "flows", presenting: true });
    // having presented lights the step (per-document flag)
    expect(localStorage.getItem("od.presented.doc")).toBe("1");
  });

  it("Ship reopens the right panel if it was closed; Try without flows stops at Flows", () => {
    usePanels.setState({ left: true, right: false });
    goToStep("ship", true);
    expect(useFlowUi.getState().mode).toBe("dev");
    expect(usePanels.getState().right).toBe(true);
    goToStep("try", false);
    expect(useFlowUi.getState()).toMatchObject({ mode: "flows", presenting: false });
  });
});
