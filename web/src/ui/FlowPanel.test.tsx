import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FlowReportSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FlowReport, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { FlowPanel } from "./FlowPanel";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { setAnalysisFetcher, useAnalysis } from "../flow/analysis";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { SceneState } from "../store/types";

// SyncClient double: records the ops on the wire and ECHOES them (like a server that
// accepts), to count "one op per action".
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function report(flowId: string, extra: { issues?: MessageInitShape<typeof FlowReportSchema>["issues"]; paths?: MessageInitShape<typeof FlowReportSchema>["paths"] } = {}): FlowReport {
  return create(FlowReportSchema, { flowId, screens: 3, transitions: 2, ...extra });
}

let sync: FakeSync;
function install(scene: SceneState) {
  useScene.getState().setScene(scene);
}
const populated = () =>
  withFlows(baseScene(), [flowOf("f1", "A", "Purchase"), flowOf("f2", "", "Return")], [
    transition("t1", "f1", "A", "B", { label: "Next", elementId: "btn" }),
    transition("t2", "f1", "B", "C", { guard: "cart=full", effect: "paid=true" }),
    transition("t3", "f2", "C", "A"),
  ]);

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "flows", currentFlowId: null, selectedTransitionId: null, showAllFlows: false });
  useAnalysis.setState({ reports: {}, status: "idle", error: null, docId: null });
  setAnalysisFetcher(async () => []);
  install(baseScene());
  useScene.getState().setSync(sync);
});
afterEach(() => {
  cleanup();
  setAnalysisFetcher();
});

describe("FlowPanel: flows", () => {
  it("without flows it explains how to create one", () => {
    render(<FlowPanel />);
    expect(screen.getByText(/No flows/)).toBeInTheDocument();
    expect(screen.queryByText("Current flow")).not.toBeInTheDocument();
  });

  it("«+ New» creates «Flow 1» (ONE op) and makes it the current one", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New flow" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setFlow"]);
    const flows = Object.values(useScene.getState().scene!.flows);
    expect(flows[0].name).toBe("Flow 1");
    expect(useFlowUi.getState().currentFlowId).toBe(flows[0].id);
    // and it appears in the list, marked as current
    expect(within(screen.getByRole("list", { name: "Flows" })).getByRole("button", { name: /Flow 1/ })).toHaveAttribute("aria-current", "true");
  });

  it("lists the flows with the number of transitions; by default the first by name is current", () => {
    install(populated());
    render(<FlowPanel />);
    const list = screen.getByRole("list", { name: "Flows" });
    const acquisto = within(list).getByRole("button", { name: /Purchase/ });
    expect(acquisto).toHaveAttribute("aria-current", "true");
    expect(acquisto).toHaveTextContent("2");
    expect(within(list).getByRole("button", { name: /Return/ })).not.toHaveAttribute("aria-current");
  });

  it("clicking another flow makes it current and changes the shown transitions", () => {
    install(populated());
    render(<FlowPanel />);
    expect(screen.getAllByRole("button", { name: /^Transition \w+ to / })).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("list", { name: "Flows" })).getByRole("button", { name: /Return/ }));
    expect(useFlowUi.getState().currentFlowId).toBe("f2");
    expect(screen.getAllByRole("button", { name: /^Transition \w+ to / })).toHaveLength(1);
  });

  it("rename: Enter commits with ONE op, an empty or unchanged name sends nothing", () => {
    install(populated());
    render(<FlowPanel />);
    const field = screen.getByRole("textbox", { name: "Flow name" });
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sync.sent).toHaveLength(0);
    fireEvent.change(field, { target: { value: "Checkout" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setFlow"]);
    expect(useScene.getState().scene!.flows.f1).toMatchObject({ name: "Checkout", startId: "A" });
  });

  it("Enter and blur do not commit twice", () => {
    install(populated());
    render(<FlowPanel />);
    const field = screen.getByRole("textbox", { name: "Flow name" });
    fireEvent.change(field, { target: { value: "Checkout" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(sync.sent).toHaveLength(1);
  });

  it("«Set as start» uses the selected node's screen (even an element inside it)", () => {
    install(populated());
    useFlowUi.setState({ currentFlowId: "f2" }); // f2 has no start
    render(<FlowPanel />);
    const btn = screen.getByRole("button", { name: "Set as start" });
    expect(btn).toBeDisabled(); // no selection
    expect(screen.getByTestId("flow-start")).toHaveTextContent("not set");

    // an element inside A: the start becomes A
    act(() => useScene.getState().setSelection(["btn"]));
    expect(screen.getByRole("button", { name: "Set as start" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Set as start" }));
    expect(useScene.getState().scene!.flows.f2.startId).toBe("A");
    expect(screen.getByTestId("flow-start")).toHaveTextContent("A");
    // already the entry: disabled (no empty op)
    expect(screen.getByRole("button", { name: "Set as start" })).toBeDisabled();
  });

  it("a loose rectangle (not a screen) cannot be the start", () => {
    install(populated());
    render(<FlowPanel />);
    act(() => useScene.getState().setSelection(["loose"]));
    expect(screen.getByRole("button", { name: "Set as start" })).toBeDisabled();
  });

  it("«Delete flow» deletes the flow (one op) and its transitions", () => {
    install(populated());
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete flow" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["deleteFlow"]);
    const s = useScene.getState().scene!;
    expect(s.flows.f1).toBeUndefined();
    expect(Object.keys(s.transitions)).toEqual(["t3"]);
    // and Ctrl+Z brings everything back in ONE step
    useScene.getState().undo();
    expect(Object.keys(useScene.getState().scene!.transitions).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("«Also show the other flows» writes to the view state", () => {
    install(populated());
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("checkbox", { name: /other flows/ }));
    expect(useFlowUi.getState().showAllFlows).toBe(true);
  });
});

describe("FlowPanel: transitions", () => {
  beforeEach(() => install(populated()));

  it("each row shows from -> to, label (or trigger), guard and effect", () => {
    render(<FlowPanel />);
    const r1 = screen.getByRole("button", { name: "Transition A to B" });
    expect(r1).toHaveTextContent("Next");
    const r2 = screen.getByRole("button", { name: "Transition B to C" });
    expect(r2).toHaveTextContent("Click");
    expect(r2).toHaveTextContent("if cart=full");
    expect(r2).toHaveTextContent("paid=true");
  });

  it("clicking a row selects it and opens the editor; again closes it", () => {
    render(<FlowPanel />);
    const row = screen.getByRole("button", { name: "Transition A to B" });
    expect(screen.queryByRole("textbox", { name: "Label" })).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(useFlowUi.getState().selectedTransitionId).toBe("t1");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Next");
    fireEvent.click(row);
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Label" })).not.toBeInTheDocument();
  });

  it("the camera does not move if the arrow is already fully in view", () => {
    const setCamera = vi.spyOn(useScene.getState(), "setCamera");
    useScene.setState({ camera: { x: 0, y: 0, zoom: 0.5 } });
    render(<FlowPanel />);
    // jsdom: no "scene" canvas, the view measures 800x600 as a fallback; A->B (x 200..400) at zoom .5 fits inside
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    expect(setCamera).not.toHaveBeenCalled();
    setCamera.mockRestore();
  });

  it("the camera frames the arrow if it is out of view", () => {
    useScene.setState({ camera: { x: -5000, y: 0, zoom: 1 } });
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    const cam = useScene.getState().camera;
    expect(cam.x).not.toBe(-5000);
    // now the A->B arc (world x 200..400) falls within the 800x600 view
    expect(200 * cam.zoom + cam.x).toBeGreaterThanOrEqual(0);
    expect(400 * cam.zoom + cam.x).toBeLessThanOrEqual(800);
  });

  it("inline edit: label, guard, effect = one op each; unchanged = no op", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    const label = screen.getByRole("textbox", { name: "Label" });
    fireEvent.keyDown(label, { key: "Enter" }); // unchanged
    expect(sync.sent).toHaveLength(0);

    fireEvent.change(label, { target: { value: "Log in" } });
    fireEvent.keyDown(label, { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox", { name: "Guard" }), { target: { value: "user=guest" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Guard" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Effect" }), { target: { value: "user=logged" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Effect" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setTransition", "setTransition", "setTransition"]);
    expect(useScene.getState().scene!.transitions.t1).toMatchObject({
      label: "Log in", guard: "user=guest", effect: "user=logged", fromId: "A", toId: "B", elementId: "btn",
    });
  });

  it("Escape in the field discards the draft", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    const label = screen.getByRole("textbox", { name: "Label" });
    fireEvent.change(label, { target: { value: "draft" } });
    fireEvent.keyDown(label, { key: "Escape" });
    fireEvent.blur(label);
    expect(sync.sent).toHaveLength(0);
    expect(label).toHaveValue("Next");
  });

  it("keys typed in the fields do not reach the global shortcuts", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Label" }), { key: "k" });
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("the trigger is a select with click/submit/auto/key/back", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition B to C" }));
    const sel = screen.getByRole("combobox", { name: "Trigger" });
    expect(within(sel).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["click", "submit", "auto", "key", "back"]);
    fireEvent.change(sel, { target: { value: "submit" } });
    expect(useScene.getState().scene!.transitions.t2.trigger).toBe("submit");
  });

  it("a free-text trigger (from CLI/MCP) stays selectable and is not lost", () => {
    const s = useScene.getState().scene!;
    install({ ...s, transitions: { ...s.transitions, t2: { ...s.transitions.t2, trigger: "swipe" } } });
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition B to C" }));
    const sel = screen.getByRole("combobox", { name: "Trigger" }) as HTMLSelectElement;
    expect(sel.value).toBe("swipe");
  });

  it("the hotspot element is chosen among the descendants of the source screen", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    const sel = screen.getByRole("combobox", { name: "Element" }) as HTMLSelectElement;
    expect(sel.value).toBe("btn");
    expect(within(sel).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["", "btn"]);
    fireEvent.change(sel, { target: { value: "" } });
    expect(useScene.getState().scene!.transitions.t1.elementId).toBe("");
  });

  it("«Delete transition» deletes it (one op, undoable) and closes the editor", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transition B to C" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete transition" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["deleteTransition"]);
    expect(useScene.getState().scene!.transitions.t2).toBeUndefined();
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    useScene.getState().undo();
    expect(useScene.getState().scene!.transitions.t2).toBeDefined();
  });

  it("a flow without transitions says so", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], []));
    render(<FlowPanel />);
    expect(screen.getByText(/No transitions/)).toBeInTheDocument();
  });
});

describe("FlowPanel: problems and paths (AnalyzeFlows)", () => {
  const issueReport = () =>
    report("f1", {
      issues: [
        { kind: "dead_end", flowId: "f1", nodeId: "C", transitionId: "", message: "«C» is a dead end." },
        { kind: "dead_end", flowId: "f1", nodeId: "B", transitionId: "", message: "«B» is a dead end." },
        { kind: "ambiguous", flowId: "f1", nodeId: "", transitionId: "t2", message: "Two identical exits." },
      ],
      paths: [{ transitionIds: ["t1", "t2"], nodeIds: ["A", "B", "C"], loops: false }, { transitionIds: ["t1"], nodeIds: ["A", "B", "A"], loops: true }],
    });

  beforeEach(() => install(populated()));

  it("requests the analysis on mount and shows problems, counters and paths", async () => {
    const fetcher = vi.fn(async () => [issueReport()]);
    setAnalysisFetcher(fetcher);
    render(<FlowPanel />);
    expect(await screen.findByText("«C» is a dead end.")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("doc");
    const summary = screen.getByLabelText("Problem summary");
    expect(summary).toHaveTextContent("dead ends: 2");
    expect(summary).toHaveTextContent("ambiguous: 1");
    // the number next to the title
    expect(screen.getByText("Problems").parentElement).toHaveTextContent("3");

    const paths = screen.getByRole("list", { name: "Flow paths" });
    expect(within(paths).getByText("A → B → C")).toBeInTheDocument();
    expect(within(paths).getByText("A → B → A ↻")).toBeInTheDocument();
  });

  it("without problems: «No problems found»", async () => {
    setAnalysisFetcher(async () => [report("f1")]);
    render(<FlowPanel />);
    expect(await screen.findByText("No problems found.")).toBeInTheDocument();
    expect(screen.getByText(/No paths/)).toBeInTheDocument();
  });

  it("until something arrives it says the analysis is in progress / not available", async () => {
    setAnalysisFetcher(async () => []);
    render(<FlowPanel />);
    await waitFor(() => expect(screen.getByText("No analysis available.")).toBeInTheDocument());
  });

  it("a server error is shown without breaking the panel", async () => {
    setAnalysisFetcher(async () => {
      throw new Error("server down");
    });
    render(<FlowPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("server down");
    expect(screen.getByRole("list", { name: "Transitions" })).toBeInTheDocument();
  });

  it("clicking a node problem selects it and frames it (if out of view)", async () => {
    setAnalysisFetcher(async () => [issueReport()]);
    useScene.setState({ camera: { x: -9000, y: 0, zoom: 1 } });
    render(<FlowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "«C» is a dead end." }));
    expect(useScene.getState().selection).toEqual(["C"]);
    const cam = useScene.getState().camera;
    // C is at x 800..1000: now it is in view
    expect(800 * cam.zoom + cam.x).toBeGreaterThanOrEqual(0);
    expect(1000 * cam.zoom + cam.x).toBeLessThanOrEqual(800);
  });

  it("clicking a transition problem selects the arrow and deselects the nodes", async () => {
    setAnalysisFetcher(async () => [issueReport()]);
    useScene.getState().setSelection(["A"]);
    render(<FlowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Two identical exits." }));
    expect(useFlowUi.getState().selectedTransitionId).toBe("t2");
    expect(useScene.getState().selection).toEqual([]);
  });

  it("clicking a path selects its screens", async () => {
    setAnalysisFetcher(async () => [issueReport()]);
    render(<FlowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "A → B → C" }));
    expect(useScene.getState().selection).toEqual(["A", "B", "C"]);
  });

  it("the analysis is retaken when the confirmed document changes", async () => {
    const fetcher = vi.fn(async () => [report("f1")]);
    setAnalysisFetcher(fetcher);
    render(<FlowPanel />);
    await screen.findByText("No problems found.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Transition A to B" }));
    const label = screen.getByRole("textbox", { name: "Label" });
    fireEvent.change(label, { target: { value: "Other" } });
    fireEvent.keyDown(label, { key: "Enter" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("the shown problems are those of the current flow", async () => {
    setAnalysisFetcher(async () => [issueReport(), report("f2", { issues: [{ kind: "no_start", flowId: "f2", nodeId: "", transitionId: "", message: "Return without entry." }] })]);
    render(<FlowPanel />);
    await screen.findByText("«C» is a dead end.");
    expect(screen.queryByText("Return without entry.")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("list", { name: "Flows" })).getByRole("button", { name: /Return/ }));
    expect(await screen.findByText("Return without entry.")).toBeInTheDocument();
  });
});
