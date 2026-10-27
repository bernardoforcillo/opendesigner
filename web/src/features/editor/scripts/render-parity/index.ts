// Compares the two scene renderers (Canvas 2D and CanvasKit on WebGL) on the same
// "gallery" (src/bench/gallery.ts): shapes, strokes, gradients, effects, rotation,
// clipping, groups, text, vector, placeholder and instances. For each zoom it counts the
// pixels that differ by more than 32/255 and fails if they exceed the threshold.
//
//   pnpm parity                # uses Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH)
//   CHROMIUM_PATH=/usr/bin/chromium pnpm parity
//
// It saves the images (2D, GPU, difference) in web/parity-out/.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 5199;
const ZOOMS = [1, 2, 0.35, 0.08];
// These are expected sub-pixel differences in text (CanvasKit does not do kerning):
// with today's gallery they stay below 1%. Beyond that, something is drawn differently.
const MAX_DIFFERING_PCT = 1.5;
const OUT = path.resolve("parity-out");

const vite = spawn("pnpm", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const stop = () => vite.kill();
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/parity.html`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the development server did not start");
}

const executablePath = process.env.CHROMIUM_PATH || undefined;
let failed = false;
try {
  await waitForServer();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath,
    // WebGL even without a GPU (SwiftShader): slow but enough to compare pixels.
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1250, height: 850 } });
  page.on("pageerror", (e) => console.error("error in the page:", e.message));
  await page.goto(`http://localhost:${PORT}/parity.html`);
  await page.waitForFunction(() => typeof window.runParity === "function", { timeout: 60000 });

  const rows = [];
  for (const zoom of ZOOMS) {
    const r = await page.evaluate((z) => window.runParity(z), zoom);
    for (const k of ["png2d", "pngGl", "pngDiff"]) {
      fs.writeFileSync(path.join(OUT, `zoom-${zoom}-${k}.png`), Buffer.from(r[k].split(",")[1], "base64"));
    }
    rows.push({ zoom, "differing pixels %": r.differingPct, "mean difference": r.meanAbsDiff, "GPU ms": r.glMs });
    if (r.differingPct > MAX_DIFFERING_PCT) failed = true;
  }
  console.table(rows);
  await browser.close();
} finally {
  stop();
}
if (failed) {
  console.error(`Parity not met: more than ${MAX_DIFFERING_PCT}% of pixels differ. Images in ${OUT}.`);
  process.exit(1);
}
console.log(`Parity met (threshold ${MAX_DIFFERING_PCT}%). Images in ${OUT}.`);
