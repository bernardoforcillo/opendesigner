// Runs src/bench/audiotest.ts in headless Chromium: renders each audio effect offline in the browser's real Web Audio on a known signal and
// measures the result (a low-pass removes the highs, a delay echoes at its time, a compressor reduces a loud tone...). Fails on any miss.
//
//   pnpm audio-check
//   CHROMIUM_PATH=/usr/bin/chromium pnpm audio-check
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = 5202;
const vite = spawn("pnpm", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
process.on("exit", () => vite.kill());
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/audiotest.html`)).ok) break;
  } catch { /* not up yet */ }
  if (i >= 60) throw new Error("the development server did not start");
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
let failed = false;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { failed = true; console.error("error in the page:", e.message); });
  await page.goto(`http://localhost:${PORT}/audiotest.html`);
  await page.waitForFunction(() => typeof window.runAudioChecks === "function", { timeout: 60000 });
  const results: { name: string; ok: boolean; detail: string }[] = await page.evaluate(() => window.runAudioChecks());
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}  (${r.detail})`);
  const bad = results.filter((r) => !r.ok);
  console.log(`${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length > 0) failed = true;
} finally {
  await browser.close();
  vite.kill();
}
process.exit(failed ? 1 : 0);
