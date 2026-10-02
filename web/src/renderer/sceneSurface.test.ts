import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyScene } from "../store/types";
import { useRenderer } from "../store/rendererChoice";

// CanvasKit e il suo renderer sono finti: qui si prova la DECISIONE (quale
// renderer disegna, e il ripiego sulla CPU), non il disegno, che gira solo in un
// browser vero (vedi docs/performance.md).
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
  it("con la CPU scelta disegna in CPU e nasconde il canvas WebGL", () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    expect(surface.draw(emptyScene("d", "t"), cam, null, false)).toBe(true);
    expect(cpuDraw).toHaveBeenCalledTimes(1);
    expect(gpuDraw).not.toHaveBeenCalled();
    expect(gl.style.display).toBe("none");
  });

  it("scegliendo la GPU parte il caricamento, nel frattempo disegna la CPU; poi passa alla GPU", async () => {
    const { cpu, gl, clear } = canvases();
    const invalidate = vi.fn();
    const surface = new SceneSurface(cpu, gl, images, invalidate);
    useRenderer.getState().setChoice("gpu");
    const scene = emptyScene("d", "t");

    surface.draw(scene, cam, null, false);
    expect(useRenderer.getState().status).toBe("loading");
    expect(cpuDraw).toHaveBeenCalledTimes(1); // niente buco mentre carica
    await tick();
    expect(invalidate).toHaveBeenCalled(); // la GPU è pronta: chiede un frame

    surface.draw(scene, cam, null, false);
    expect(gpuDraw).toHaveBeenCalledTimes(1);
    expect(cpuDraw).toHaveBeenCalledTimes(1); // la CPU non ha disegnato di nuovo
    expect(gl.style.display).toBe("block");
    expect(clear).toHaveBeenCalledTimes(1); // il canvas 2D sopra resta trasparente
    expect(useRenderer.getState().status).toBe("gpu");

    // Più frame: il canvas 2D si svuota UNA volta sola.
    surface.draw(scene, cam, null, false);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("se CanvasKit non si carica ripiega sulla CPU, dice perché, e NON cancella la preferenza", async () => {
    loadFails = new Error("rete caduta");
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    useRenderer.getState().setChoice("gpu");
    surface.draw(emptyScene("d", "t"), cam, null, false);
    await tick();
    expect(useRenderer.getState()).toMatchObject({ choice: "cpu", status: "error", error: "rete caduta" });
    // Un guasto passeggero non deve riscrivere la scelta salvata.
    expect(localStorage.getItem("opendesigner.renderer")).toBe("gpu");

    // E si continua a disegnare, in CPU, senza rimettere in coda il caricamento.
    cpuDraw.mockClear();
    surface.draw(emptyScene("d", "t"), cam, null, false);
    expect(cpuDraw).toHaveBeenCalledTimes(1);
    expect(useRenderer.getState().status).toBe("error"); // il motivo resta visibile
  });

  it("se il contesto WebGL si perde, torna alla CPU nello stesso frame", async () => {
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

  it("un errore dentro il disegno GPU non spegne il ciclo: ripiega sulla CPU", async () => {
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

  it("tornare alla CPU libera la GPU? no: resta pronta; ma dispose() la libera", async () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    useRenderer.getState().setChoice("gpu");
    surface.draw(emptyScene("d", "t"), cam, null, false);
    await tick();
    surface.dispose();
    expect(gpuDispose).toHaveBeenCalled();
  });

  it("il tempo dell'ultimo frame si pubblica al più ogni mezzo secondo", () => {
    const { cpu, gl } = canvases();
    const surface = new SceneSurface(cpu, gl, images, () => {});
    const set = vi.spyOn(useRenderer.getState(), "setFrameMs");
    const scene = emptyScene("d", "t");
    for (let i = 0; i < 10; i++) surface.draw(scene, cam, null, false);
    expect(set.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
