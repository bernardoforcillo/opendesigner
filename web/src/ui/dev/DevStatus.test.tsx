import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { useFlowUi } from "@/store/flowUi";
import { baseScene } from "@/flow/testSupport";
import { setCompareFetcher, type Comparison } from "@/dev/devStatus";
import { DevStatusSection } from "@/ui/dev/DevStatusSection";
import { ReadyListSection } from "@/ui/dev/ReadyListSection";

// DEV STATUS: marking a frame ready for dev, annotating layers, Compare changes and the ready list,
// against a fake server (ops are applied locally, the comparison is injected).

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "dev", currentFlowId: null, presenting: false });
  useScene.getState().setScene(baseScene());
  useScene.getState().setSync(sync);
  setCompareFetcher(async () => ({ markedAt: 0, changes: [] }));
  try { localStorage.clear(); } catch { /* */ }
});
afterEach(() => {
  cleanup();
  setCompareFetcher();
});

const select = (...ids: string[]) => act(() => useScene.getState().setSelection(ids));

describe("DevStatusSection: ready for dev", () => {
  it("asks for a selection first", () => {
    render(<DevStatusSection />);
    expect(screen.getByText(/Select a frame to mark it ready/)).toBeInTheDocument();
  });

  it("marks a frame ready with its note, and the mark is not an undo step", () => {
    select("A");
    render(<DevStatusSection />);
    expect(screen.getByText("Not marked")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Note for the developer"), { target: { value: "  Start with the button " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setReadyForDev"]);
    const mark = useScene.getState().scene!.dev?.ready.A;
    expect(mark).toMatchObject({ nodeId: "A", note: "Start with the button" });
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark ready again" })).toBeInTheDocument();
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("a layer inside a frame shows its frame's status; a loose layer cannot be marked", () => {
    select("btn");
    render(<DevStatusSection />);
    expect(screen.getByRole("button", { name: "Mark ready for dev" })).toBeInTheDocument();
    select("loose");
    expect(screen.getByText(/not inside a frame/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark ready for dev" })).toBeNull();
  });

  it("unmarks", () => {
    select("A");
    render(<DevStatusSection />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Unmark" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setReadyForDev", "clearReadyForDev"]);
    expect(useScene.getState().scene!.dev?.ready).toEqual({});
    expect(screen.getByText("Not marked")).toBeInTheDocument();
  });
});

describe("DevStatusSection: Compare changes", () => {
  const changes: Comparison = {
    markedAt: 0,
    changes: [
      { nodeId: "btn", nodeName: "Buy", kind: "changed", property: "width", before: "100", after: "160" },
      { nodeId: "btn", nodeName: "Buy", kind: "changed", property: "fills[0]", before: "solid #ff0000", after: "solid #0000ff" },
      { nodeId: "n9", nodeName: "Badge", kind: "added", property: "", before: "", after: "" },
    ],
  };

  it("lists what changed since the frame was marked, layer by layer, with before and after", async () => {
    const asked: string[] = [];
    setCompareFetcher(async (docId, nodeId) => { asked.push(`${docId}/${nodeId}`); return changes; });
    select("A");
    render(<DevStatusSection />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    const box = await screen.findByTestId("compare-changes");
    await waitFor(() => expect(within(box).getByText("3 changes")).toBeInTheDocument());
    expect(asked[0]).toBe("doc/A");
    expect(within(box).getByText("Width")).toBeInTheDocument();
    expect(within(box).getByText("100")).toBeInTheDocument();
    expect(within(box).getByText("160")).toBeInTheDocument();
    expect(within(box).getByText("Fill 1")).toBeInTheDocument();
    expect(within(box).getByText("added")).toBeInTheDocument();
    // A click on a layer selects it.
    fireEvent.click(within(box).getByRole("button", { name: /Buy/ }));
    expect(useScene.getState().selection).toEqual(["btn"]);
  });

  it("says so when nothing changed, and reports a server error", async () => {
    select("A");
    render(<DevStatusSection />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    expect(await screen.findByText("Unchanged")).toBeInTheDocument();
    cleanup();
    setCompareFetcher(async () => { throw new Error("down"); });
    render(<DevStatusSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot compare: down");
  });

  it("marking again asks for a new comparison", async () => {
    let calls = 0;
    setCompareFetcher(async () => { calls++; return { markedAt: 0, changes: [] }; });
    select("A");
    render(<DevStatusSection />);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    await waitFor(() => expect(calls).toBeGreaterThan(0));
    const before = calls;
    // markedAt is whole seconds: make the second marking differ.
    const mark = useScene.getState().scene!.dev!.ready.A;
    act(() => useScene.getState().apply({ ...sync.sent[0], kind: { case: "setReadyForDev", value: { ready: { ...(sync.sent[0].kind as { value: { ready: object } }).value.ready, markedAt: BigInt(mark.markedAt + 5) } } } } as unknown as Op));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });
});

describe("DevStatusSection: annotations", () => {
  it("adds a colour-coded annotation to the selected layer and deletes it", () => {
    select("btn");
    render(<DevStatusSection />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Interaction" }));
    expect(screen.getByRole("radio", { name: "Interaction" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Add annotation" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Annotation text"), { target: { value: "Opens the cart as a sheet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add annotation" }));

    const sent = sync.sent[0];
    expect(sent.kind.case).toBe("setAnnotation");
    const list = screen.getByRole("list", { name: "Annotations" });
    const item = within(list).getByText("Opens the cart as a sheet").closest("li")!;
    expect(item).toHaveAttribute("data-category", "interaction");
    expect(useScene.getState().scene!.dev?.annotations).toMatchObject({ [Object.keys(useScene.getState().scene!.dev!.annotations)[0]]: { nodeId: "btn", category: "interaction" } });
    expect(screen.getByLabelText("Annotation text")).toHaveValue("");

    fireEvent.click(within(item).getByRole("button", { name: "Delete the interaction annotation" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setAnnotation", "deleteAnnotation"]);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("each layer has its own annotations", () => {
    select("btn");
    const { rerender } = render(<DevStatusSection />);
    fireEvent.change(screen.getByLabelText("Annotation text"), { target: { value: "on the button" } });
    fireEvent.click(screen.getByRole("button", { name: "Add annotation" }));
    select("A");
    rerender(<DevStatusSection />);
    expect(screen.queryByText("on the button")).toBeNull();
    select("btn");
    rerender(<DevStatusSection />);
    expect(screen.getByText("on the button")).toBeInTheDocument();
  });
});

describe("ReadyListSection: the focus view", () => {
  it("is empty until a frame is marked", () => {
    render(<ReadyListSection />);
    expect(screen.getByText(/No frame is marked yet/)).toBeInTheDocument();
  });

  it("lists the ready frames with their annotation colours; picking one focuses it", () => {
    select("A");
    render(<><DevStatusSection /><ReadyListSection /></>);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    select("btn");
    fireEvent.change(screen.getByLabelText("Annotation text"), { target: { value: "note" } });
    fireEvent.click(screen.getByRole("button", { name: "Add annotation" }));

    const list = screen.getByTestId("ready-list");
    const row = within(list).getByRole("button", { name: /A/ });
    expect(within(list).getByTitle("1 annotation")).toBeInTheDocument();
    select("C");
    fireEvent.click(row);
    expect(useScene.getState().selection).toEqual(["A"]);
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("a frame deleted since it was marked stays listed and cannot be focused", () => {
    select("A");
    render(<><DevStatusSection /><ReadyListSection /></>);
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for dev" }));
    act(() => {
      useScene.getState().apply({ kind: { case: "deleteNode", value: { id: "A" } } } as unknown as Op);
    });
    const list = screen.getByTestId("ready-list");
    expect(within(list).getByText("(deleted frame)")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /deleted frame/ })).toBeDisabled();
  });
});
