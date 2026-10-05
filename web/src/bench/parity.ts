import { drawScene } from "../renderer/canvasRenderer";
import { CanvasKitRenderer } from "../renderer/ck/ckRenderer";
import { FontBook, loadCanvasKit } from "../renderer/ck/canvaskit";
import { makeGallery } from "./gallery";

const images = {
  get: (_doc: string, hash: string) =>
    hash === "missing" ? { status: "missing" as const, image: null } : { status: "loading" as const, image: null },
};

// @ts-expect-error exposed to Playwright
window.runParity = async (zoom = 1) => {
  await document.fonts.load("400 16px Inter");
  await document.fonts.load("700 16px Inter");
  const scene = makeGallery();
  const cam = { x: 0, y: 0, zoom };

  const c2d = document.getElementById("c2d") as HTMLCanvasElement;
  const cgl = document.getElementById("cgl") as HTMLCanvasElement;
  const ctx = c2d.getContext("2d")!;
  drawScene(ctx, scene, cam, { currentPageId: "page1", dpr: 1, images });

  const CK = await loadCanvasKit();
  const fonts = new FontBook(CK);
  await fonts.ready();
  // Weights other than 400: they load on first request, so a first draw
  // asks for them and waits for them to arrive.
  const r = new CanvasKitRenderer(CK, cgl, fonts, images);
  r.draw(scene, cam, "page1");
  await new Promise((res) => setTimeout(res, 500));
  r.fontsChanged();
  const t0 = performance.now();
  r.draw(scene, cam, "page1");
  const glMs = performance.now() - t0;

  // The WebGL buffer is readable only in the same task as the draw: copy it now.
  const copy = document.createElement("canvas");
  copy.width = cgl.width; copy.height = cgl.height;
  const cctx = copy.getContext("2d")!;
  cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, copy.width, copy.height);
  cctx.drawImage(cgl, 0, 0);
  // And the 2D on a white background.
  const flat = document.createElement("canvas");
  flat.width = c2d.width; flat.height = c2d.height;
  const fctx = flat.getContext("2d")!;
  fctx.fillStyle = "#fff"; fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(c2d, 0, 0);

  const a = fctx.getImageData(0, 0, flat.width, flat.height).data;
  const b = cctx.getImageData(0, 0, copy.width, copy.height).data;
  const diff = new Uint8ClampedArray(a.length);
  let differing = 0;
  let sum = 0;
  const W = flat.width;
  // By region (100x100 cells) to see WHERE they differ.
  const cells = new Map<string, number>();
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    sum += d;
    if (d > 32) {
      differing++;
      const px = (i / 4) % W, py = Math.floor(i / 4 / W);
      const key = `${Math.floor(px / 100) * 100},${Math.floor(py / 100) * 100}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    diff[i] = 255; diff[i + 1] = 255 - Math.min(255, d * 4); diff[i + 2] = 255 - Math.min(255, d * 4); diff[i + 3] = 255;
  }
  const out = document.createElement("canvas");
  out.width = W; out.height = flat.height;
  out.getContext("2d")!.putImageData(new ImageData(diff, W, flat.height), 0, 0);
  r.dispose();
  return {
    totalPixels: a.length / 4,
    differing,
    differingPct: +(differing / (a.length / 4) * 100).toFixed(3),
    meanAbsDiff: +(sum / (a.length / 4)).toFixed(3),
    glMs: +glMs.toFixed(2),
    worstCells: [...cells.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8),
    png2d: flat.toDataURL("image/png"),
    pngGl: copy.toDataURL("image/png"),
    pngDiff: out.toDataURL("image/png"),
  };
};
