import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyScene } from "../store/types";
import { useRenderer } from "../store/rendererChoice";

// CanvasKit and its renderer are fake: here the DECISION is tested (which
// renderer draws, and the CPU fallback), not the drawing, which only runs in a
// real browser (see docs/performance.md).
const gpuDraw = vi.fn();
const gpuDispose = vi.fn();
let gpuLost = false;
let loadFails: Error | null = null;

vi.mock("./ck/canvaskit", () => ({
  loadCanvasKit: async () => {
    if (loadFails) throw loadFails;
    return {};
  },
  FontBook: class {
    async ready() {}
    dispose() {}
  },
}));
vi.mock("./ck/ckRenderer", () => ({
  CanvasKitRenderer: class {
    get lost() { return gpuLost; }
    draw(...a: unknown[]) { gpuDraw(...a); }
    fontsChanged() {}
    dispose() { gpuDispose(); }
  },
}));
const cpuDraw = vi.fn(() => true);
vi.mock("./layerCache", () => ({
  SceneLayerCache: class { draw(...a: unknown[]) { return (cpuDraw as (...x: unknown[]) => boolean)(...a); } },
  SETTLE_MS: 120,
}));

import { SceneSurface } from "./sceneSurface";

function canvases() {
  const clear = vi.fn();
  const cpu = { width: 800, height: 600, getContext: () => ({ clearRect: clear }) } as unknown as HTMLCanvasElement;
  const gl = { width: 0, height: 0, clientWidth: 800, clientHeight: 600, style: { display: "none" } } as unknown as HTMLCanvasElement;
  return { cpu, gl, clear };
}
const cam = { x: 0, y: 0, zoom: 1 };
const images = { get: () => ({ status: "loading" as const, image: null }) };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  gpuDraw.mockClear(); gpuDispose.mockClear(); cpuDraw.mockClear();
  gpuLost = false;
  loadFails = null;
  useRenderer.setState({ choice: "cpu", status: "cpu", error: null, frameMs: null });
});

describe("SceneSurface", () => {
  it("with the CPU chosen it draws on the CPU and hides the WebGL canvas", () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    expect(surface.draw(emptyScene("d", "t"), cam, null, false)).toBe(true);
    expect(cpuDraw).toHaveBeenCalledTimes(1);
    expect(gpuDraw).not.toHaveBeenCalled();
    expect(gl.style.display).toBe("none");
  });

  it("choosing the GPU starts loading, meanwhile the CPU draws; then it switches to the GPU", async () => {
    const { cpu, gl, clear } = canvases();
    const invalidate = vi.fn();
    const surface = new SceneSurface(cpu, gl, images, invalidate);
    useRenderer.getState().setChoice("gpu");
    const scene = emptyScene("d", "t");

    surface.draw(scene, cam, null, false);
    expect(useRenderer.getState().status).toBe("loading");
    expect(cpuDraw).toHaveBeenCalledTimes(1); // no hole while loading
    await tick();
    expect(invalidate).toHaveBeenCalled(); // the GPU is ready: it asks for a frame

    surface.draw(scene, cam, null, false);
    expect(gpuDraw).toHaveBeenCalledTimes(1);
    expect(cpuDraw).toHaveBeenCalledTimes(1); // the CPU did not draw again
    expect(gl.style.display).toBe("block");
    expect(clear).toHaveBeenCalledTimes(1); // the 2D canvas above stays transparent
    expect(useRenderer.getState().status).toBe("gpu");

    // More frames: the 2D canvas is emptied only ONCE.
    surface.draw(scene, cam, null, false);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("if CanvasKit does not load it falls back to the CPU, says why, and does NOT erase the preference", async () => {
    loadFails = new Error("rete caduta");
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    useRenderer.getState().setChoice("gpu");
    surface.draw(emptyScene("d", "t"), cam, null, false);
    await tick();
    expect(useRenderer.getState()).toMatchObject({ choice: "cpu", status: "error", error: "rete caduta" });
    // A transient fault must not rewrite the saved choice.
    expect(localStorage.getItem("opendesigner.renderer")).toBe("gpu");

    // And drawing continues, on the CPU, without re-queuing the load.
    cpuDraw.mockClear();
    surface.draw(emptyScene("d", "t"), cam, null, false);
    expect(cpuDraw).toHaveBeenCalledTimes(1);
    expect(useRenderer.getState().status).toBe("error"); // the reason stays visible
  });

  it("if the WebGL context is lost, it goes back to the CPU in the same frame", async () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    useRenderer.getState().setChoice("gpu");
    const scene = emptyScene("d", "t");
    surface.draw(scene, cam, null, false);
    await tick();
    surface.draw(scene, cam, null, false);
    expect(gpuDraw).toHaveBeenCalledTimes(1);

    gpuLost = true;
    cpuDraw.mockClear();
    surface.draw(scene, cam, null, false);
    expect(cpuDraw).toHaveBeenCalledTimes(1);
    expect(gpuDispose).toHaveBeenCalled();
    expect(useRenderer.getState()).toMatchObject({ choice: "cpu", status: "error" });
    expect(useRenderer.getState().error).toMatch(/WebGL/);
  });

  it("an error inside the GPU drawing does not kill the loop: it falls back to the CPU", async () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    useRenderer.getState().setChoice("gpu");
    const scene = emptyScene("d", "t");
    surface.draw(scene, cam, null, false);
    await tick();
    gpuDraw.mockImplementationOnce(() => { throw new Error("shader rotto"); });
    cpuDraw.mockClear();
    expect(() => surface.draw(scene, cam, null, false)).not.toThrow();
    expect(cpuDraw).toHaveBeenCalledTimes(1);
    expect(useRenderer.getState().error).toBe("shader rotto");
  });

  it("going back to the CPU frees the GPU? no: it stays ready; but dispose() frees it", async () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    useRenderer.getState().setChoice("gpu");
    surface.draw(emptyScene("d", "t"), cam, null, false);
    await tick();
    surface.dispose();
    expect(gpuDispose).toHaveBeenCalled();
  });

  it("the last frame's time is published at most every half second", () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    const set = vi.spyOn(useRenderer.getState(), "setFrameMs");
    const scene = emptyScene("d", "t");
    for (let i = 0; i < 10; i++) surface.draw(scene, cam, null, false);
    expect(set.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
