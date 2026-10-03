import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { PrototypePlayer } from "./PrototypePlayer";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { ClipLite, SceneState } from "../store/types";
import * as renderer from "../renderer/canvasRenderer";

// Le animazioni in Presenta: enter e loop partono con la schermata, hover e tap
// sul bersaglio, e un'animazione finita non tiene acceso nessun ciclo di frame.

let size = 0;
beforeEach(() => {
  size = 1;
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() { return size ? (prop === "clientWidth" ? 800 : 600) : 0; },
    });
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  useFlowUi.setState({ currentFlowId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

const op = (id: string, extra: Partial<ClipLite> = {}): ClipLite => ({
  id, name: id, duration: 300, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "A",
  tracks: [{ nodeId: "btn", prop: "opacity", keyframes: [{ time: 0, value: 0.2, easing: "" }, { time: 300, value: 0.9, easing: "" }] }],
  ...extra,
});

function install(...clips: ClipLite[]): SceneState {
  const s = {
    ...withFlows(baseScene(), [flowOf("f1", "A", "Principale")], [transition("t1", "f1", "A", "B", { label: "Vai" })]),
    clips: Object.fromEntries(clips.map((c) => [c.id, c])),
  };
  useScene.getState().setScene(s);
  return s;
}
const spy = () => vi.spyOn(renderer, "drawScene").mockImplementation(() => {});
const lastBtn = (d: ReturnType<typeof spy>) => d.mock.calls.at(-1)?.[1].nodes.at("btn");
const stage = () => (screen.getByRole("dialog", { name: "Prototipo" }).firstElementChild as HTMLElement);
// La camera del player a 800x600 per un frame 200x300: zoom 1.68, origine (232, 48). btn sta a (60,200) 80x30.
const BTN = { clientX: 232 + 100 * 1.68, clientY: 48 + 215 * 1.68 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Presenta: clip del documento", () => {
  it("senza clip si disegna la scena derivata di sempre, nessun ciclo di frame", async () => {
    install();
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d).toHaveBeenCalled());
    await sleep(60);
    const n = d.mock.calls.length;
    await sleep(200);
    expect(d.mock.calls.length).toBe(n);
    expect(d.mock.calls.at(-1)?.[1].anim).toBeUndefined();
  });

  it("enter: parte con la schermata, arriva al valore finale e poi i frame si fermano", async () => {
    install(op("e"));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    // all'inizio vale il primo keyframe (0.2), alla fine l'ultimo (0.9) -- e ci resta
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    expect(d.mock.calls.some((c) => c[1].nodes.at("btn").opacity < 0.9)).toBe(true);
    await sleep(80);
    const n = d.mock.calls.length;
    await sleep(250);
    expect(d.mock.calls.length).toBe(n); // finita: nessun rAF in giro
    expect(lastBtn(d)?.opacity).toBeCloseTo(0.9);
  });

  it("loop: non finisce mai (i frame continuano)", async () => {
    install(op("l", { trigger: "loop" }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d.mock.calls.length).toBeGreaterThan(6));
    const n = d.mock.calls.length;
    await sleep(200);
    expect(d.mock.calls.length).toBeGreaterThan(n + 3);
  });

  it("hover: parte quando il puntatore entra nel bersaglio e torna alla base quando esce", async () => {
    install(op("h", { trigger: "hover", targetId: "btn" }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d).toHaveBeenCalled());
    expect(lastBtn(d)?.opacity).toBe(1); // base: nessuna animazione ancora
    fireEvent.pointerMove(stage(), BTN);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    fireEvent.pointerMove(stage(), { clientX: 10, clientY: 10 }); // fuori dal bersaglio
    await waitFor(() => expect(lastBtn(d)?.opacity).toBe(1));
  });

  it("tap: vale finché si tiene premuto", async () => {
    install(op("t", { trigger: "tap", targetId: "btn" }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(d).toHaveBeenCalled());
    fireEvent.pointerDown(stage(), BTN);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    fireEvent.pointerUp(stage(), BTN);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBe(1));
  });

  it("cambiare schermata: le clip della nuova ripartono, quelle dell'altra non girano più", async () => {
    install(op("a"), op("b", { targetId: "B", tracks: [{ nodeId: "B", prop: "opacity", keyframes: [{ time: 0, value: 0.5, easing: "" }] }] }));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    fireEvent.click(screen.getByRole("button", { name: "Vai" }));
    await waitFor(() => expect(d.mock.calls.at(-1)?.[1].nodes.at("B").opacity).toBe(0.5));
    // la scena derivata ora mostra solo B: la clip di A non c'entra
    expect(d.mock.calls.at(-1)?.[1].nodes.at("btn").opacity).toBe(1);
  });

  it("il documento dello store non viene toccato", async () => {
    const s = install(op("e"));
    const d = spy();
    render(<PrototypePlayer onClose={() => {}} />);
    await waitFor(() => expect(lastBtn(d)?.opacity).toBeCloseTo(0.9));
    expect(useScene.getState().scene).toBe(s);
    expect(s.nodes.at("btn").opacity).toBe(1);
  });
});
