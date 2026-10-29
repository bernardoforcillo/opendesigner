// Draws EffectCraft effect tracks through the REAL pipeline (clip -> pose -> CanvasKitRenderer on WebGL) in headless Chromium
// and saves the picture, so the offscreen kernels, layers, time effects and lookup-table read-back can be looked at.
// src/bench/fxdemo.ts has the scene (one node per effect).
//
//   pnpm fx-render               # zoom 1, playhead 500 ms -> fx-out/zoom-1-t-500.png
//   pnpm fx-render 2 900         # zoom 2, playhead 900 ms
//   pnpm fx-render 1 500 1       # the second set of effects (shatter, cards, particles, text...)
//   CHROMIUM_PATH=/usr/bin/chromium pnpm fx-render
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = 5201;
const zoom = Number(process.argv[2] ?? 1);
const t = Number(process.argv[3] ?? 500);
const set = Number(process.argv[4] ?? 0);
const OUT = path.resolve("fx-out");

const vite = spawn("pnpm", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
process.on("exit", () => vite.kill());

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/fxdemo.html`)).ok) break;
  } catch { /* not up yet */ }
  if (i >= 60) throw new Error("the development server did not start");
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  page.on("pageerror", (e) => { failed = true; console.error("error in the page:", e.message); });
  await page.goto(`http://localhost:${PORT}/fxdemo.html`);
  await page.waitForFunction(() => typeof window.runFx === "function", { timeout: 60000 });
  const r = await page.evaluate(([z, tt, st]) => window.runFx(z, tt, st), [zoom, t, set]);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `set-${set}-zoom-${zoom}-t-${t}.png`);
  fs.writeFileSync(file, Buffer.from(r.png.split(",")[1], "base64"));
  console.log("saved", file);
  if (r.errors.length > 0) { failed = true; console.error("shader errors:", r.errors); }
} finally {
  await browser.close();
  vite.kill();
}
process.exit(failed ? 1 : 0);
