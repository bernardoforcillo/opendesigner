// Pagina di supporto di web/scripts/export-parity.mjs: disegna UNA schermata del
// documento col renderer VERO dell'editor (drawScene su Canvas 2D, dpr 1) e
// confronta due immagini pixel per pixel. Il documento arriva come protojson,
// lo stesso file che il CLI esporta: l'editor e l'export partono dagli stessi byte.
import { fromJson } from "@bufbuild/protobuf";
import { DocumentSchema } from "../../src/gen/opendesigner/v1/opendesigner_pb";
import { fromDocument } from "../../src/store/types";
import { drawScene } from "../../src/renderer/canvasRenderer";

type Img = { status: "ready" | "missing" | "loading"; image: HTMLImageElement | null };

async function loadFonts(): Promise<void> {
  for (const w of [400, 500, 600, 700]) await document.fonts.load(`${w} 16px Inter`);
  await document.fonts.ready;
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("immagine non decodificabile"));
    im.src = url;
  });
}

// renderFrame: i pixel (PNG data URL, su fondo bianco) della schermata `frameId`
// come li disegna l'editor. `assets` mappa hash -> data URL dell'immagine.
(window as any).renderFrame = async (docJson: unknown, frameId: string, assets: Record<string, string>) => {
  await loadFonts();
  const scene = fromDocument(fromJson(DocumentSchema, docJson as never));
  const frame = scene.nodes.at(frameId);
  const cache = new Map<string, Img>();
  for (const [hash, url] of Object.entries(assets)) cache.set(hash, { status: "ready", image: await decode(url) });
  const images = { get: (_doc: string, hash: string): Img => cache.get(hash) ?? { status: "missing", image: null } };

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(frame.width);
  canvas.height = Math.ceil(frame.height);
  const ctx = canvas.getContext("2d")!;
  // La schermata sta alle sue coordinate nella pagina: la camera la porta a (0,0).
  drawScene(ctx, scene, { x: -frame.x, y: -frame.y, zoom: 1 }, { currentPageId: "page1", dpr: 1, images });
  const flat = document.createElement("canvas");
  flat.width = canvas.width;
  flat.height = canvas.height;
  const fctx = flat.getContext("2d")!;
  fctx.fillStyle = "#fff";
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(canvas, 0, 0);
  return flat.toDataURL("image/png");
};

interface Rect { x: number; y: number; w: number; h: number }

// compare: differenze fra due PNG della stessa misura. `mask` sono i rettangoli
// del TESTO (anti-aliasing e baseline differiscono per costruzione fra canvas e
// DOM): si misurano a parte, e fuori da lì il confronto è quello stretto.
(window as any).compare = async (aUrl: string, bUrl: string, mask: Rect[]) => {
  const [a, b] = await Promise.all([decode(aUrl), decode(bUrl)]);
  const W = a.width, H = a.height;
  const read = (im: HTMLImageElement) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d")!;
    x.drawImage(im, 0, 0);
    return x.getImageData(0, 0, W, H).data;
  };
  const pa = read(a), pb = read(b);
  const masked = new Uint8Array(W * H);
  for (const r of mask) {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(H, Math.ceil(r.y + r.h)); y++) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(W, Math.ceil(r.x + r.w)); x++) masked[y * W + x] = 1;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  const s = { n: 0, sum: 0, over32: 0, over8: 0, max: 0, tn: 0, tsum: 0, tover32: 0 };
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o + 1] - pb[o + 1]), Math.abs(pa[o + 2] - pb[o + 2]));
    const v = 255 - Math.min(255, d * 4);
    if (masked[i]) {
      s.tn++; s.tsum += d; if (d > 32) s.tover32++;
      out[o] = v; out[o + 1] = v; out[o + 2] = 255;
    } else {
      s.n++; s.sum += d; if (d > 32) s.over32++; if (d > 8) s.over8++; if (d > s.max) s.max = d;
      out[o] = 255; out[o + 1] = v; out[o + 2] = v;
    }
    out[o + 3] = 255;
  }
  const dc = document.createElement("canvas");
  dc.width = W; dc.height = H;
  dc.getContext("2d")!.putImageData(new ImageData(out, W, H), 0, 0);
  return {
    width: W, height: H,
    strictMean: s.n ? s.sum / s.n : 0,
    strictOver32Pct: s.n ? (100 * s.over32) / s.n : 0,
    strictOver8Pct: s.n ? (100 * s.over8) / s.n : 0,
    strictMax: s.max,
    textPixels: s.tn,
    textMean: s.tn ? s.tsum / s.tn : 0,
    textOver32Pct: s.tn ? (100 * s.tover32) / s.tn : 0,
    diff: dc.toDataURL("image/png"),
  };
};
