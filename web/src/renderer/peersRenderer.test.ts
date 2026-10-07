import { nodesOf } from "../store/nodeMap";
import { describe, it, expect, vi } from "vitest";
import { drawPeers } from "./peersRenderer";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { newPeer, type Peers, type PeerLite } from "../store/presence";

const cam = { x: 0, y: 0, zoom: 1 };

function scene(): SceneState {
  const s = emptyScene("d", "t");
  const n: NodeLite = {
    id: "n1", parentId: s.pages[0].id, orderKey: "a0", name: "n", visible: true, opacity: 1,
    x: 10, y: 20, width: 100, height: 50, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
  return { ...s, nodes: nodesOf({ n1: n }) };
}

function peer(over: Partial<PeerLite> = {}): PeerLite {
  return newPeer("p", "Bea", { hasCursor: true, cursorX: 40, cursorY: 60, ...over });
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
  it("draws the nickname of the peer with a cursor", () => {
    const { ctx, calls } = ctxMock();
    drawPeers(ctx, scene(), cam, peers(peer()), null);
    expect(calls).toContain("label:Bea");
  });

  it("without a cursor no arrow, but the selection yes and with the name above", () => {
    const { ctx, calls, raw } = ctxMock();
    drawPeers(ctx, scene(), cam, peers(peer({ hasCursor: false, selection: ["n1"] })), null);
    expect(calls).toEqual(["selection", "label:Bea"]);
    expect(raw.lineTo).not.toHaveBeenCalled(); // no arrow
    // The tag sits above the node's top-left corner (10,20).
    expect(raw.roundRect).toHaveBeenCalledWith(10, 20 - 16 - 2, expect.any(Number), 16, 4);
  });

  it("a selection id vanished from the document draws nothing", () => {
    const { ctx, calls } = ctxMock();
    drawPeers(ctx, scene(), cam, peers(peer({ hasCursor: false, selection: ["ghost"] })), null);
    expect(calls).toEqual([]);
  });

  it("a peer on another page is not seen; without a current page the first one counts", () => {
    const s = scene();
    const first = s.pages[0].id;
    const a = ctxMock();
    drawPeers(a.ctx, s, cam, peers(peer({ pageId: "other" })), null);
    expect(a.calls).toEqual([]);
    const b = ctxMock();
    drawPeers(b.ctx, s, cam, peers(peer({ pageId: first })), null);
    expect(b.calls).toContain("label:Bea");
    const c = ctxMock();
    drawPeers(c.ctx, s, cam, peers(peer({ pageId: "other" })), "other");
    expect(c.calls).toContain("label:Bea");
  });

  it("the cursor follows the camera: same world position, different screen", () => {
    const a = ctxMock();
    drawPeers(a.ctx, scene(), { x: 0, y: 0, zoom: 1 }, peers(peer()), null);
    const b = ctxMock();
    drawPeers(b.ctx, scene(), { x: 0, y: 0, zoom: 2 }, peers(peer()), null);
    expect(a.raw.translate).toHaveBeenCalledWith(40, 60);
    expect(b.raw.translate).toHaveBeenCalledWith(80, 120);
  });
});
