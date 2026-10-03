import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { App } from "./App";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { useTimeline } from "../animation/timelineStore";
import { baseScene } from "../flow/testSupport";
import type { ClipLite } from "../store/types";
import * as overlayRenderer from "../renderer/overlayRenderer";
import * as renderer from "../renderer/canvasRenderer";

// La timeline dentro App: la voce del dock, M, il pannello sotto la tela, la posa
// che arriva al renderer e -- il punto di costo -- un editor che resta a ZERO
// frame con il pannello aperto ma fermo.

vi.mock("../rpc/client", () => ({ docClient: { createDocument: vi.fn(async () => ({ id: "doc-1" })) } }));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));
vi.stubGlobal("localStorage", { getItem: () => "doc-1", setItem: () => {}, removeItem: () => {} });

const clip: ClipLite = {
  id: "k", name: "Entrata", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0, easing: "" }, { time: 1000, value: 1, easing: "" }] }],
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setupCtx() {
  const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
  const fakeCtx = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => {}) }) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
  vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
  // jsdom non ha Path2D: il disegno vero della scena (rect) lancerebbe dentro il rAF.
  vi.spyOn(renderer, "drawScene").mockImplementation(() => {});
  return vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
}

beforeEach(() => {
  useTimeline.setState({ open: false, clipId: null, playhead: 0, playing: false, record: false, posed: false, selection: [], draftClip: null, recordDraft: null, collapsed: false });
  useScene.setState({ undoStack: [], redoStack: [], gesture: null, sync: null, selection: [] });
  useScene.getState().setScene({ ...baseScene(), clips: { k: clip } });
});
afterEach(() => {
  cleanup();
  useTimeline.getState().setOpen(false);
  useFlowUi.setState({ mode: "design", presenting: false });
  vi.restoreAllMocks();
});

describe("timeline in App", () => {
  it("M apre e chiude il pannello; il pulsante del dock fa lo stesso e riflette lo stato", () => {
    render(<App />);
    const dock = screen.getByRole("button", { name: "Animazione" });
    expect(dock).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: "Timeline" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "m" });
    expect(screen.getByRole("region", { name: "Timeline" })).toBeInTheDocument();
    expect(dock).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "m" });
    expect(screen.queryByRole("region", { name: "Timeline" })).not.toBeInTheDocument();
    fireEvent.click(dock);
    expect(useTimeline.getState().open).toBe(true);
  });

  it("M non scatta in un campo di testo né con un modificatore", () => {
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "m" });
    fireEvent.keyDown(window, { key: "m", ctrlKey: true });
    fireEvent.keyDown(window, { key: "m", shiftKey: true });
    expect(useTimeline.getState().open).toBe(false);
    input.remove();
  });

  it("da Flussi M riporta in Design con la timeline aperta; in Flussi il pannello non c'è", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Flussi" }));
    expect(screen.queryByRole("button", { name: "Animazione" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "m" });
    expect(useFlowUi.getState().mode).toBe("design");
    expect(screen.getByRole("region", { name: "Timeline" })).toBeInTheDocument();
  });

  it("aprire una clip (dalla lista) apre anche il pannello", () => {
    render(<App />);
    act(() => useTimeline.getState().openClip("k"));
    expect(screen.getByRole("region", { name: "Timeline" })).toBeInTheDocument();
  });

  it("il pannello sta SOTTO la tela, non sopra: la tela resta nella stessa colonna", () => {
    const { container } = render(<App />);
    act(() => useTimeline.getState().setOpen(true));
    const canvas = container.querySelector("#scene") as HTMLElement;
    const panel = screen.getByRole("region", { name: "Timeline" });
    expect(canvas.parentElement!.parentElement).toBe(panel.parentElement);
    expect(canvas.parentElement!.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("la posa arriva al renderer, il documento no", () => {
  it("scorrere il playhead disegna la scena campionata; chiudere torna a quella vera", async () => {
    setupCtx();
    const drawScene = vi.spyOn(renderer, "drawScene");
    render(<App />);
    act(() => {
      useTimeline.getState().openClip("k");
      useTimeline.getState().setPlayhead(500);
    });
    await waitFor(() => {
      const last = drawScene.mock.calls.at(-1)?.[1];
      expect(last?.nodes.at("btn").opacity).toBeCloseTo(0.5);
    });
    expect(useScene.getState().scene!.nodes.at("btn").opacity).toBe(1);
    act(() => useTimeline.getState().setOpen(false));
    await waitFor(() => expect(drawScene.mock.calls.at(-1)?.[1]).toBe(useScene.getState().scene));
  });
});

describe("zero frame da fermi", () => {
  it("con il pannello aperto ma fermo il ciclo di disegno non gira; gira solo mentre si riproduce", async () => {
    const drawOverlay = setupCtx();
    render(<App />);
    useTimeline.getState().openClip("k");
    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    await sleep(120);
    const idle = drawOverlay.mock.calls.length;
    await sleep(300);
    expect(drawOverlay.mock.calls.length).toBe(idle);

    useTimeline.getState().play();
    await waitFor(() => expect(drawOverlay.mock.calls.length).toBeGreaterThan(idle + 3));
    useTimeline.getState().pause();
    await sleep(80);
    const paused = drawOverlay.mock.calls.length;
    await sleep(300);
    expect(drawOverlay.mock.calls.length).toBe(paused);
  });

  it("chiusa e riaperta: ancora zero frame", async () => {
    const drawOverlay = setupCtx();
    render(<App />);
    useTimeline.getState().setOpen(true);
    useTimeline.getState().setOpen(false);
    await sleep(150);
    const idle = drawOverlay.mock.calls.length;
    await sleep(300);
    expect(drawOverlay.mock.calls.length).toBe(idle);
  });
});
