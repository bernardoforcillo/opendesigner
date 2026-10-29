import { drawScene } from "@/renderer/canvasRenderer";
import { CanvasKitRenderer } from "@/renderer/ck/ckRenderer";
import { FontBook, loadCanvasKit } from "@/renderer/ck/canvaskit";
import { fitCamera, makeScene } from "@/bench/scene";

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

// Where a CanvasKit frame goes: `record` is the JS walk plus the calls into CanvasKit (building the Skia
// display list), `flush` is the wait for the GPU to finish it. With a software GL (a headless run) `flush`
// is slow and unrepresentative; `record` is the part the code controls.
// @ts-expect-error exposed to Playwright
window.runCkSplit = async (sizes: number[]) => {
  const CK = await loadCanvasKit();
  const fonts = new FontBook(CK);
  await fonts.ready();
  const cgl = document.getElementById("cgl") as HTMLCanvasElement;
  const r = new CanvasKitRenderer(CK, cgl, fonts, images);
  const gl = cgl.getContext("webgl2") as WebGL2RenderingContext | null;
  const out = [];
  for (const n of sizes) {
    const scene = makeScene(n);
    const fit = fitCamera(scene, 1200, 800);
    r.draw(scene, fit, "page1");
    const rec: number[] = [], fl: number[] = [];
    for (let i = 0; i < 25; i++) {
      r.draw(scene, fit, "page1");
      gl?.finish();
      rec.push(r.stats.walkMs); fl.push(r.stats.flushMs);
    }
    out.push({ nodes: scene.nodes.size, record: +median(rec).toFixed(1), recordMin: +Math.min(...rec).toFixed(1), flush: +median(fl).toFixed(1) });
  }
  r.dispose();
  return out;
};

// A PAN on the GPU renderer: after one exact frame, 30 camera steps. `reuse` lets the renderer move its last
// heavy frame (what the editor does while the camera moves); `exact` forces a full frame each step (what it
// used to do). Times are per frame, medians.
// @ts-expect-error exposed to Playwright
window.runCkPan = async (sizes: number[]) => {
  const CK = await loadCanvasKit();
  const fonts = new FontBook(CK);
  await fonts.ready();
  const cgl = document.getElementById("cgl") as HTMLCanvasElement;
  const r = new CanvasKitRenderer(CK, cgl, fonts, images);
  const gl = cgl.getContext("webgl2") as WebGL2RenderingContext | null;
  const out = [];
  for (const n of sizes) {
    const scene = makeScene(n);
    const fit = fitCamera(scene, 1200, 800);
    const run = (force: boolean) => {
      r.draw(scene, fit, "page1", null, true);
      gl?.finish();
      const t: number[] = [];
      for (let i = 1; i <= 30; i++) {
        const cam = { x: fit.x - i * 7, y: fit.y + i * 3, zoom: fit.zoom * (1 + i * 0.004) };
        const a = performance.now();
        r.draw(scene, cam, "page1", null, force);
        gl?.finish();
        t.push(performance.now() - a);
      }
      return +median(t).toFixed(1);
    };
    out.push({ nodes: scene.nodes.size, exact: run(true), reuse: run(false) });
  }
  r.dispose();
  return out;
};

// Is the moved frame the frame? Draws the scene exactly, then at a nearby camera once by reuse and once exactly,
// and compares the two over the area both cover. Returns the mean absolute difference per channel (0-255).
// @ts-expect-error exposed to Playwright
window.runCkCheck = async (n: number) => {
  const CK = await loadCanvasKit();
  const fonts = new FontBook(CK);
  await fonts.ready();
  const cgl = document.getElementById("cgl") as HTMLCanvasElement;
  const r = new CanvasKitRenderer(CK, cgl, fonts, images);
  const gl = cgl.getContext("webgl2") as WebGL2RenderingContext;
  const W = cgl.width, H = cgl.height;
  const scene = makeScene(n);
  const fit = fitCamera(scene, 1200, 800);
  const read = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  r.draw(scene, fit, "page1", null, true);
  const cam = { x: fit.x - 60, y: fit.y + 20, zoom: fit.zoom * ((window as unknown as { __zf?: number }).__zf ?? 1.05) };
  const exactFlag = r.draw(scene, cam, "page1", null, false); // by reuse if the frame was heavy
  const reused = read();
  r.draw(scene, cam, "page1", null, true);
  const exact = read();
  // The interior: well inside the canvas on every side, whichever way the image moved.
  let sum = 0, count = 0;
  for (let y = Math.round(H * 0.25); y < H * 0.75; y += 2) for (let x = Math.round(W * 0.25); x < W * 0.75; x += 2) {
    const i = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) { sum += Math.abs(reused[i + c] - exact[i + c]); count++; }
  }
  r.dispose();
  return { reusedFrame: exactFlag === false, meanAbsDiff: +(sum / count).toFixed(2) };
};
