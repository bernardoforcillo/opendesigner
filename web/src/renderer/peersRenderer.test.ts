import { describe, it, expect, vi } from "vitest";
import { drawPeers } from "./peersRenderer";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import type { Peers, PeerLite } from "../store/presence";

const cam = { x: 0, y: 0, zoom: 1 };

function scene(): SceneState {
  const s = emptyScene("d", "t");
  const n: NodeLite = {
    id: "n1", parentId: s.pages[0].id, orderKey: "a0", name: "n", visible: true, opacity: 1,
    x: 10, y: 20, width: 100, height: 50, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
  return { ...s, nodes: { n1: n } };
}

function peer(over: Partial<PeerLite> = {}): PeerLite {
  return { clientId: "p", nickname: "Bea", hasCursor: true, cursorX: 40, cursorY: 60, pageId: "", selection: [], ...over };
}

function ctxMock() {
  const calls: string[] = [];
  const ctx = {
    setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    roundRect: vi.fn(), strokeRect: vi.fn(() => calls.push("selection")),
    measureText: () => ({ width: 30 }),
    fillText: vi.fn((t: string) => calls.push(`label:${t}`)),
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, textBaseline: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx };
}

const peers = (...ps: PeerLite[]): Peers => Object.fromEntries(ps.map((p) => [p.clientId, p]));

describe("drawPeers", () => {
  it("disegna il nickname del peer col cursore", () => {
    const { ctx, calls } = ctxMock();
    drawPeers(ctx, scene(), cam, peers(peer()), null);
    expect(calls).toContain("label:Bea");
  });

  it("senza cursore niente freccia, ma la selezione sì e col nome sopra", () => {
    const { ctx, calls, raw } = ctxMock();
    drawPeers(ctx, scene(), cam, peers(peer({ hasCursor: false, selection: ["n1"] })), null);
    expect(calls).toEqual(["selection", "label:Bea"]);
    expect(raw.lineTo).not.toHaveBeenCalled(); // nessuna freccia
    // La targhetta sta sopra l'angolo in alto a sinistra del nodo (10,20).
    expect(raw.roundRect).toHaveBeenCalledWith(10, 20 - 16 - 2, expect.any(Number), 16, 4);
  });

  it("un id di selezione sparito dal documento non disegna nulla", () => {
    const { ctx, calls } = ctxMock();
    drawPeers(ctx, scene(), cam, peers(peer({ hasCursor: false, selection: ["ghost"] })), null);
    expect(calls).toEqual([]);
  });

  it("un peer su un'altra pagina non si vede; senza pagina corrente vale la prima", () => {
    const s = scene();
    const first = s.pages[0].id;
    const a = ctxMock();
    drawPeers(a.ctx, s, cam, peers(peer({ pageId: "altra" })), null);
    expect(a.calls).toEqual([]);
    const b = ctxMock();
    drawPeers(b.ctx, s, cam, peers(peer({ pageId: first })), null);
    expect(b.calls).toContain("label:Bea");
    const c = ctxMock();
    drawPeers(c.ctx, s, cam, peers(peer({ pageId: "altra" })), "altra");
    expect(c.calls).toContain("label:Bea");
  });

  it("il cursore segue la camera: stessa posizione mondo, schermo diverso", () => {
    const a = ctxMock();
    drawPeers(a.ctx, scene(), { x: 0, y: 0, zoom: 1 }, peers(peer()), null);
    const b = ctxMock();
    drawPeers(b.ctx, scene(), { x: 0, y: 0, zoom: 2 }, peers(peer()), null);
    expect(a.raw.translate).toHaveBeenCalledWith(40, 60);
    expect(b.raw.translate).toHaveBeenCalledWith(80, 120);
  });
});
