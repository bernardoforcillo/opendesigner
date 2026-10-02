import { drawScene, hitTest } from "../renderer/canvasRenderer";
import { applyOp } from "../store/applyOp";
import { makeSetPropsOp } from "../tools/ops";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { fitCamera, makeScene } from "./scene";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function median(xs: number[]) {
  const a = [...xs].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
}
function time(fn: () => void, runs: number) {
  const t: number[] = [];
  fn(); // riscaldamento
  for (let i = 0; i < runs; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); }
  return +median(t).toFixed(2);
}

// @ts-expect-error esposto a Playwright
window.runBench = (sizes: number[]) => {
  const out: Record<string, unknown>[] = [];
  for (const n of sizes) {
    const scene = makeScene(n);
    const fit = fitCamera(scene, 1200, 800);
    // Zoom-in: ~una schermata e mezza visibili (il caso d'uso reale).
    const zoomed = { x: -2000, y: -1500, zoom: 1 };
    const op = makeSetPropsOp("n0_1", { x: 5, y: 6 }, ["x", "y"]);
    out.push({
      nodes: Object.keys(scene.nodes).length,
      drawFit_ms: time(() => drawScene(ctx, scene, fit, "page1"), 5),
      drawZoomed_ms: time(() => drawScene(ctx, scene, zoomed, "page1"), 5),
      hitTest_ms: time(() => hitTest(scene, 1000, 1000, 1, "page1"), 10),
      applyOp_ms: time(() => applyOp(scene, op), 10),
      // Il costo di UNA modifica come la vede chi trascina: nuova scena (applyOp)
      // + indice da ricostruire + un frame zoomato. Ogni chiamata parte da una
      // scena nuova, quindi la cache dell'indice non aiuta.
      index_ms: time(() => sceneIndexOf(applyOp(scene, op)), 5),
      editFrame_ms: time(() => drawScene(ctx, applyOp(scene, op), zoomed, "page1"), 5),
    });
  }
  return out;
};

// @ts-expect-error esposto a Playwright
window.runFitOnly = (n: number, times: number) => {
  const scene = makeScene(n);
  const fit = fitCamera(scene, 1200, 800);
  for (let i = 0; i < times; i++) drawScene(ctx, scene, fit, "page1");
};

import { SceneLayerCache } from "../renderer/layerCache";

// @ts-expect-error esposto a Playwright
window.runPan = (n: number) => {
  const scene = makeScene(n);
  const fit = fitCamera(scene, 1200, 800);
  const cache = new SceneLayerCache();
  const t0 = performance.now();
  cache.draw(ctx, scene, fit, "page1", true);
  const exact = performance.now() - t0;
  const moves: number[] = [];
  for (let i = 1; i <= 20; i++) {
    const a = performance.now();
    const ok = cache.draw(ctx, scene, { x: fit.x + i * 6, y: fit.y + i * 3, zoom: fit.zoom * (1 + i * 0.02) }, "page1");
    moves.push(performance.now() - a);
    if (ok) throw new Error("expected a blit");
  }
  moves.sort((p, q) => p - q);
  return { exact_ms: +exact.toFixed(1), move_median_ms: +moves[10].toFixed(2), move_max_ms: +moves[19].toFixed(2) };
};

// @ts-expect-error esposto a Playwright
window.shotPan = (n: number, mode: "blit" | "exact") => {
  const scene = makeScene(n);
  const fit = fitCamera(scene, 1200, 800);
  const cache = new SceneLayerCache();
  cache.draw(ctx, scene, fit, "page1", true);
  const next = { x: fit.x - 40, y: fit.y - 30, zoom: fit.zoom * 1.4 };
  cache.draw(ctx, scene, next, "page1", mode === "exact");
};
