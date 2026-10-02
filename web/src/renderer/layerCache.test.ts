import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyScene } from "../store/types";

// drawScene finto, che "costa" quanto dice il test: il tempo lo decide
// performance.now, così i test non dipendono dalla velocità della macchina.
let cost = 0;
let now = 0;
const drawSceneMock = vi.fn(() => {
  now += cost;
});
vi.mock("./canvasRenderer", () => ({ drawScene: (...a: unknown[]) => (drawSceneMock as (...x: unknown[]) => void)(...a) }));

import { HEAVY_MS, SceneLayerCache } from "./layerCache";

function fakeCtx(width = 1200, height = 800, clientWidth = 600) {
  const canvas = { width, height, clientWidth } as HTMLCanvasElement;
  const calls = {
    drawImage: [] as unknown[][],
    clearRect: vi.fn(),
    setTransform: vi.fn(),
  };
  const ctx = {
    canvas,
    clearRect: calls.clearRect,
    setTransform: calls.setTransform,
    drawImage: (...a: unknown[]) => calls.drawImage.push(a),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, canvas, calls };
}

beforeEach(() => {
  cost = 0;
  now = 0;
  drawSceneMock.mockClear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

const cam = (x: number, y: number, zoom: number) => ({ x, y, zoom });

describe("SceneLayerCache", () => {
  it("un documento leggero disegna sempre esatto, anche se si muove solo la camera", () => {
    const scene = emptyScene("d", "t");
    const cache = new SceneLayerCache();
    const { ctx } = fakeCtx();
    cost = 3;
    expect(cache.draw(ctx, scene, cam(0, 0, 1), null)).toBe(true);
    expect(cache.draw(ctx, scene, cam(10, 0, 1), null)).toBe(true);
    expect(cache.draw(ctx, scene, cam(10, 0, 2), null)).toBe(true);
    expect(drawSceneMock).toHaveBeenCalledTimes(3);
  });

  it("un frame pesante: se si muove SOLO la camera si riusa l'immagine, senza ridisegnare", () => {
    const scene = emptyScene("d", "t");
    const cache = new SceneLayerCache();
    const { ctx, calls } = fakeCtx(1200, 800, 600); // dpr 2
    cost = HEAVY_MS + 5;
    expect(cache.draw(ctx, scene, cam(10, 20, 1), null)).toBe(true);
    expect(drawSceneMock).toHaveBeenCalledTimes(1);

    // Zoom 1 -> 2 e camera da (10,20) a (50,60): k = 2,
    // tx = (50 - 10*2) * dpr = 60, ty = (60 - 20*2) * dpr = 40.
    expect(cache.draw(ctx, scene, cam(50, 60, 2), null)).toBe(false);
    expect(drawSceneMock).toHaveBeenCalledTimes(1); // niente disegno vero
    // Un solo drawImage sul canvas principale: la stampa (layer, tx, ty, w*k, h*k).
    // La fotografia si disegna sul canvas fuori schermo, non qui.
    expect(calls.drawImage).toHaveLength(1);
    expect(calls.drawImage[0].slice(1)).toEqual([60, 40, 2400, 1600]);
  });

  it("solo camera, ma `force` o un cambio di scena/pagina/dimensione ridisegnano esatto", () => {
    const scene = emptyScene("d", "t");
    const cache = new SceneLayerCache();
    const a = fakeCtx(1200, 800, 600);
    cost = HEAVY_MS + 5;
    cache.draw(a.ctx, scene, cam(0, 0, 1), null);
    expect(cache.draw(a.ctx, scene, cam(5, 0, 1), null, true)).toBe(true); // force
    expect(cache.draw(a.ctx, { ...scene }, cam(5, 0, 1), null)).toBe(true); // scena diversa
    expect(cache.draw(a.ctx, { ...scene }, cam(5, 0, 1), "p2")).toBe(true); // pagina diversa
    const b = fakeCtx(1600, 800, 800); // altra dimensione
    expect(cache.draw(b.ctx, scene, cam(5, 0, 1), "p2")).toBe(true);
  });

  it("una camera ferma non è 'camera mossa': ridisegna (es. cambia solo la selezione)", () => {
    const scene = emptyScene("d", "t");
    const cache = new SceneLayerCache();
    const { ctx } = fakeCtx();
    cost = HEAVY_MS + 5;
    cache.draw(ctx, scene, cam(0, 0, 1), null);
    drawSceneMock.mockClear();
    expect(cache.draw(ctx, scene, cam(0, 0, 1), null)).toBe(true);
    expect(drawSceneMock).toHaveBeenCalledTimes(1);
  });

  it("se il documento torna leggero smette di usare la scorciatoia", () => {
    const scene = emptyScene("d", "t");
    const cache = new SceneLayerCache();
    const { ctx } = fakeCtx();
    cost = HEAVY_MS + 5;
    cache.draw(ctx, scene, cam(0, 0, 1), null);
    expect(cache.draw(ctx, scene, cam(5, 0, 1), null)).toBe(false);
    cost = 2; // un ridisegno esatto (a movimento finito) ora è veloce
    expect(cache.draw(ctx, scene, cam(5, 0, 1), null, true)).toBe(true);
    expect(cache.draw(ctx, scene, cam(9, 0, 1), null)).toBe(true);
  });
});
