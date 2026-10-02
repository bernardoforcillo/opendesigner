// Confronta i due renderer della scena (Canvas 2D e CanvasKit su WebGL) sulla stessa
// "galleria" (src/bench/gallery.ts): forme, tratti, gradienti, effetti, rotazione,
// ritaglio, gruppi, testo, vettoriale, segnaposto e istanze. Per ogni zoom conta i
// pixel che differiscono di più di 32/255 e fallisce se superano la soglia.
//
//   pnpm parity                # usa il Chromium di Playwright (PLAYWRIGHT_BROWSERS_PATH)
//   CHROMIUM_PATH=/usr/bin/chromium pnpm parity
//
// Salva le immagini (2D, GPU, differenza) in web/parity-out/.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 5199;
const ZOOMS = [1, 2, 0.35, 0.08];
// Sono differenze attese di sub-pixel nel testo (CanvasKit non fa la crenatura):
// con la galleria di oggi stanno sotto l'1%. Oltre, qualcosa si disegna diverso.
const MAX_DIFFERING_PCT = 1.5;
const OUT = path.resolve("parity-out");

const vite = spawn("pnpm", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const stop = () => vite.kill();
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/parity.html`)).ok) return;
    } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("il server di sviluppo non è partito");
}

const executablePath = process.env.CHROMIUM_PATH || undefined;
let failed = false;
try {
  await waitForServer();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath,
    // WebGL anche senza GPU (SwiftShader): lento ma sufficiente per confrontare i pixel.
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1250, height: 850 } });
  page.on("pageerror", (e) => console.error("errore nella pagina:", e.message));
  await page.goto(`http://localhost:${PORT}/parity.html`);
  await page.waitForFunction(() => typeof window.runParity === "function", { timeout: 60000 });

  const rows = [];
  for (const zoom of ZOOMS) {
    const r = await page.evaluate((z) => window.runParity(z), zoom);
    for (const k of ["png2d", "pngGl", "pngDiff"]) {
      fs.writeFileSync(path.join(OUT, `zoom-${zoom}-${k}.png`), Buffer.from(r[k].split(",")[1], "base64"));
    }
    rows.push({ zoom, "pixel diversi %": r.differingPct, "differenza media": r.meanAbsDiff, "GPU ms": r.glMs });
    if (r.differingPct > MAX_DIFFERING_PCT) failed = true;
  }
  console.table(rows);
  await browser.close();
} finally {
  stop();
}
if (failed) {
  console.error(`Parità non rispettata: oltre ${MAX_DIFFERING_PCT}% di pixel diversi. Immagini in ${OUT}.`);
  process.exit(1);
}
console.log(`Parità rispettata (soglia ${MAX_DIFFERING_PCT}%). Immagini in ${OUT}.`);
