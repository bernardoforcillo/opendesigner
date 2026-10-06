import { drawScene } from "../renderer/canvasRenderer";
import { CanvasKitRenderer } from "../renderer/ck/ckRenderer";
import { FontBook, loadCanvasKit } from "../renderer/ck/canvaskit";
import { fitCamera, makeScene } from "./scene";

const images = { get: () => ({ status: "loading" as const, image: null }) };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// @ts-expect-error exposed to Playwright
window.runCk = async (sizes: number[]) => {
  const CK = await loadCanvasKit();
  const fonts = new FontBook(CK);
  await fonts.ready();
  const c2d = document.getElementById("c2d") as HTMLCanvasElement;
  const cgl = document.getElementById("cgl") as HTMLCanvasElement;
  const ctx = c2d.getContext("2d")!;
  const r = new CanvasKitRenderer(CK, cgl, fonts, images);
  const gl = cgl.getContext("webgl2") as WebGL2RenderingContext | null;
  const out = [];
  for (const n of sizes) {
    const scene = makeScene(n);
    const fit = fitCamera(scene, 1200, 800);
    const zoomed = { x: -2000, y: -1500, zoom: 1 };
    const t2 = (cam: typeof fit) => {
      const t: number[] = [];
      drawScene(ctx, scene, cam, { currentPageId: "page1", dpr: 1, images });
      for (let i = 0; i < 5; i++) { const a = performance.now(); drawScene(ctx, scene, cam, { currentPageId: "page1", dpr: 1, images }); t.push(performance.now() - a); }
      return +median(t).toFixed(1);
    };
    const tg = (cam: typeof fit) => {
      const t: number[] = [];
      r.draw(scene, cam, "page1");
      for (let i = 0; i < 5; i++) {
        const a = performance.now();
        r.draw(scene, cam, "page1");
        gl?.finish();
        t.push(performance.now() - a);
      }
      return +median(t).toFixed(1);
    };
    out.push({
      nodes: scene.nodes.size,
      canvas2d_fit: t2(fit), canvaskit_fit: tg(fit),
      canvas2d_zoom: t2(zoomed), canvaskit_zoom: tg(zoomed),
    });
  }
  r.dispose();
  return out;
};
