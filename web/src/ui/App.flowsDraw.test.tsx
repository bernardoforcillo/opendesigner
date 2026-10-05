import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { App } from "./App";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import * as overlayRenderer from "../renderer/overlayRenderer";
import * as flowRenderer from "../renderer/flowRenderer";

vi.mock("../rpc/client", () => ({
  docClient: {
    createDocument: vi.fn(async () => ({ id: "doc-1" })),
    analyzeFlows: vi.fn(async () => ({ reports: [] })),
  },
}));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));
vi.stubGlobal("localStorage", { getItem: () => "doc-1", setItem: () => {}, removeItem: () => {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useFlowUi.setState({ mode: "design", presenting: false, hoverTransitionId: null });
});

// The flows canvas is drawn inside App's ON-INVALIDATION loop: only in
// Flows mode, only when something visible changes -- never with the editor idle.
describe("flows drawing loop", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function setupCtx() {
    const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
    const fakeCtx = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => {}) }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
    vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
    return vi.spyOn(flowRenderer, "drawFlows").mockImplementation(() => {});
  }

  it("in Design it does not draw the flows; in Flows it does, and when idle it does not redraw", async () => {
    const drawFlows = setupCtx();
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    await sleep(100);
    expect(drawFlows).not.toHaveBeenCalled();

    useFlowUi.getState().setMode("flows");
    await waitFor(() => expect(drawFlows).toHaveBeenCalled());
    await sleep(80);
    const idle = drawFlows.mock.calls.length;
    await sleep(250);
    expect(drawFlows.mock.calls.length).toBe(idle);

    // hovering an arrow invalidates the canvas
    useFlowUi.getState().setHoverTransition("t");
    await waitFor(() => expect(drawFlows.mock.calls.length).toBeGreaterThan(idle));
    expect(drawFlows.mock.calls.at(-1)![3]).toMatchObject({ hoverTransitionId: "t", flowId: null });
  });

  it("passes the effective current flow and its entry to the overlay", async () => {
    const drawFlows = setupCtx();
    useScene.getState().setScene({
      ...emptyScene("doc-1", "Untitled"),
      flows: { f1: { id: "f1", name: "One", description: "", startId: "" } },
    });
    useFlowUi.getState().setMode("flows");
    render(<App />);
    await waitFor(() => expect(drawFlows).toHaveBeenCalled());
    expect(drawFlows.mock.calls.at(-1)![3]).toMatchObject({ flowId: "f1", startId: "" });
  });
});
