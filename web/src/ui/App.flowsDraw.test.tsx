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

// Il canvas dei flussi si disegna dentro il ciclo A INVALIDAZIONE di App: solo in
// modalità Flussi, solo quando qualcosa che si vede cambia -- mai a editor fermo.
describe("ciclo di disegno dei flussi", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function setupCtx() {
    const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
    const fakeCtx = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => {}) }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
    vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
    return vi.spyOn(flowRenderer, "drawFlows").mockImplementation(() => {});
  }

  it("in Design non disegna i flussi; in Flussi sì, e da fermo non ridisegna", async () => {
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

    // l'hover su una freccia invalida il canvas
    useFlowUi.getState().setHoverTransition("t");
    await waitFor(() => expect(drawFlows.mock.calls.length).toBeGreaterThan(idle));
    expect(drawFlows.mock.calls.at(-1)![3]).toMatchObject({ hoverTransitionId: "t", flowId: null });
  });

  it("passa all'overlay il flusso corrente effettivo e il suo ingresso", async () => {
    const drawFlows = setupCtx();
    useScene.getState().setScene({
      ...emptyScene("doc-1", "Untitled"),
      flows: { f1: { id: "f1", name: "Uno", description: "", startId: "" } },
    });
    useFlowUi.getState().setMode("flows");
    render(<App />);
    await waitFor(() => expect(drawFlows).toHaveBeenCalled());
    expect(drawFlows.mock.calls.at(-1)![3]).toMatchObject({ flowId: "f1", startId: "" });
  });
});
