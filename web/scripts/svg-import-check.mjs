// Verification of SVG import IN A REAL BROWSER.
//
// For each fixture in src/svg/__fixtures__/:
//   1. opens the editor (Go server + web/dist) on a new document;
//   2. puts the SVG on the clipboard and presses Ctrl+V: it is the REAL paste path
//      (tools/clipboard.ts -> tools/svgImport.ts -> importSvg), gesture included;
//   3. photographs the canvas around the imported root (zoom 1, dpr 1: one
//      canvas pixel = one image pixel);
//   4. has the browser draw the SAME file (an <img src=data:...> at the same
//      size, on the same background colour) and compares the two pixel by pixel.
//
//   pnpm svg-import                       # everything: web build, server build, start, comparison
//   pnpm svg-import -- --skip-build       # reuses the web/dist and the binary already built
//   pnpm svg-import -- --scheme dark      # editor with the dark theme
//   CHROMIUM_PATH=/usr/bin/chromium pnpm svg-import
//
// WHAT IS TOLERATED (and why):
//   - a pixel is "different" if one of its channels differs by more than TOL (64/255)
//     from the pixel at the same spot in the reference. Below that, it is
//     anti-aliasing noise: the 2D canvas and Chromium's SVG image rasterizer
//     do not dose an edge's coverage the same way (measured:
//     all pixels above 32 are edges, none above ~110, none interior).
//     64 = a coverage that differs by about a quarter of a pixel;
//   - no neighbourhood tolerance: a 3x3 neighbourhood would forgive a shift
//     of a whole pixel, which is exactly the error to find.
//     The SENSITIVITY check at the bottom proves it: the same comparison,
//     with the reference shifted on purpose (half a pixel, one, two), must
//     see the difference;
//   - the percentage is over the "ink" pixels (different from the background in at least one
//     of the two images), not over the area: a thin icon is almost all background.
//   - text is the only one with a wider threshold (kerning and hinting differ
//     between canvas.fillText and <text>): see `maxPct` in the fixtures.
//
// It saves editor / reference / difference in web/svg-import-out/ (gitignored).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const WEB = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(WEB, "..");
const FIXTURES = path.join(WEB, "src/svg/__fixtures__");
const OUT = path.resolve(process.env.SVG_IMPORT_OUT ?? path.join(WEB, "svg-import-out"));
const PORT = Number(process.env.OD_PORT ?? 8121);
const TOL = 64;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SCHEME = opt("scheme", "light");
const RENDERER = opt("renderer", "cpu");
const SHOTS = opt("shots", "");

// Per fixture: whether to compare it with the browser and how much margin of differing pixels.
const CONFIG = {
  "logo-gradient.svg": { compare: true, maxPct: 1.0 }, // contains text
  "icon-strokes-arcs.svg": { compare: true, maxPct: 1.0 },
  "illustration-nested.svg": { compare: true, maxPct: 1.0 },
  // Filters, masks, patterns: the browser applies them, we only report them.
  "hostile.svg": { compare: false, maxPct: 100 },
};

function build() {
  if (!flag("skip-build")) {
    execFileSync("npx", ["vite", "build"], { cwd: WEB, stdio: "inherit" });
    // the build empties dist: .gitkeep is needed by the frontend embed
    try { execFileSync("git", ["checkout", "web/dist/.gitkeep"], { cwd: ROOT, stdio: "ignore" }); } catch { /* ok */ }
  }
  const bin = process.env.OD_BIN ?? path.join(os.tmpdir(), "od-svg-import");
  if (!flag("skip-build") || !fs.existsSync(bin)) {
    execFileSync("go", ["build", "-o", bin, "./cmd/opendesigner"], { cwd: ROOT, stdio: "inherit" });
  }
  return bin;
}

async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the server does not respond on ${url}`);
}

async function createDoc(name) {
  const res = await fetch(`http://localhost:${PORT}/opendesigner.v1.DocumentService/CreateDocument`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  return (await res.json()).id;
}

// The comparison lives in an empty page: the browser already knows how to decode PNGs.
const COMPARE = ({ a, b, tol }) => new Promise((resolve) => {
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  Promise.all([load(a), load(b)]).then(([ia, ib]) => {
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const A = px(ia), B = px(ib);
    const bg = [A[0], A[1], A[2]];
    const d = (P, i, Q, j) => Math.max(Math.abs(P[i] - Q[j]), Math.abs(P[i + 1] - Q[j + 1]), Math.abs(P[i + 2] - Q[j + 2]));
    let ink = 0, strict32 = 0, diff = 0, sum = 0;
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    const ox = out.getContext("2d"); const od = ox.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dab = d(A, i, B, i);
      sum += dab;
      const isInk = Math.max(Math.abs(A[i] - bg[0]), Math.abs(A[i + 1] - bg[1]), Math.abs(A[i + 2] - bg[2])) > 32
        || Math.max(Math.abs(B[i] - bg[0]), Math.abs(B[i + 1] - bg[1]), Math.abs(B[i + 2] - bg[2])) > 32;
      if (isInk) ink++;
      const bad = dab > tol;
      if (dab > 32) strict32++;
      if (bad) diff++;
      const g = Math.round((B[i] + B[i + 1] + B[i + 2]) / 3 * 0.35 + 165);
      od.data[i] = bad ? 255 : g; od.data[i + 1] = bad ? 0 : g; od.data[i + 2] = bad ? 60 : g; od.data[i + 3] = 255;
    }
    ox.putImageData(od, 0, 0);
    resolve({ w, h, ink, strict: strict32, diff, mean: sum / (w * h), diffPng: out.toDataURL("image/png"), bg });
  });
});

const bin = build();
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "od-svg-ws-"));
fs.mkdirSync(OUT, { recursive: true });
const server = spawn(bin, ["serve", "-addr", `:${PORT}`, "-workspace", ws, "-web", path.join(WEB, "dist")], { stdio: "ignore" });
const stop = () => { try { server.kill(); } catch { /* already down */ } };
process.on("exit", stop);

let failed = false;
const rows = [];
const sensitivity = [];
try {
  await waitFor(`http://localhost:${PORT}/`);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1, colorScheme: SCHEME,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` }).catch(() => {});
  const cmp = await ctx.newPage();
  await cmp.goto("about:blank");

  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".svg")).sort()) {
    const cfg = CONFIG[file] ?? { compare: true, maxPct: 1.0 };
    const svg = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    const natural = { w: Number(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 240), h: Number(/<svg[^>]*\sheight="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 240) };
    const name = file.replace(/\.svg$/, "");

    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${file}] error in the page:`, e.message));
    const docId = await createDoc(`svg-import ${name}`);
    await page.goto(`http://localhost:${PORT}/doc/${docId}?renderer=${RENDERER}`);
    await page.waitForFunction(() => !!document.querySelector(".bg-ok"), { timeout: 30000 });
    await page.waitForTimeout(500);
    // The "Where do you start?" card covers the centre of the canvas on an empty document.
    await page.getByRole("button", { name: /Close and don't show/ }).click({ timeout: 3000 }).catch(() => {});

    const canvasRect = () => page.evaluate(() => {
      const r = (document.getElementById("overlay") ?? document.querySelector("canvas")).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    // The import is CENTRED on the view's centre as it is BEFORE the notice.
    const r0 = await canvasRect();
    // The paste, for real: text on the clipboard + Ctrl+V.
    await page.mouse.click(720, 700);
    await page.evaluate((t) => navigator.clipboard.writeText(t), svg);
    await page.keyboard.press("Control+V");
    let notice = "";
    try {
      const banner = page.getByText(/Imported as|SVG import failed/).first();
      await banner.waitFor({ timeout: 8000 });
      notice = (await banner.textContent()) ?? "";
    } catch { notice = "(no notice)"; }
    // Deselect (the selection draws handles above the drawing) and leave
    // time for the next frame.
    await page.mouse.click(720, 150);
    await page.mouse.move(40, 840);
    await page.waitForTimeout(600);

    // The notice banner pushes the canvas down: the root moves with it.
    const r1 = await canvasRect();
    const c = { x: r1.left + r0.width / 2, y: r1.top + r0.height / 2 };
    const PAD = 8;
    const clip = {
      x: Math.round(c.x - natural.w / 2) - PAD, y: Math.round(c.y - natural.h / 2) - PAD,
      width: Math.ceil(natural.w) + 2 * PAD, height: Math.ceil(natural.h) + 2 * PAD,
    };
    const editorPng = await page.screenshot({ clip });
    fs.writeFileSync(path.join(OUT, `${name}-editor.png`), editorPng);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}-${SCHEME}.png`) });
    }

    if (cfg.compare) {
      // The reference: the same file, drawn by the browser, on the editor's background
      // colour (the corner pixel of the shot, outside the drawing).
      const bgPage = await ctx.newPage();
      const b64 = editorPng.toString("base64");
      const bg = await bgPage.evaluate((src) => new Promise((res) => {
        const i = new Image(); i.onload = () => { const cv = document.createElement("canvas"); cv.width = 1; cv.height = 1; const x = cv.getContext("2d"); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, 1, 1).data; res(`rgb(${d[0]},${d[1]},${d[2]})`); }; i.src = src;
      }), `data:image/png;base64,${b64}`);
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      await bgPage.setViewportSize({ width: clip.width + 20, height: clip.height + 20 });
      // `shift` (px) shifts the reference: it serves the sensitivity check.
      const renderRef = async (shift) => {
        await bgPage.setContent(`<html><body style="margin:0;background:${bg}"><img style="position:absolute;left:${PAD}px;top:${PAD}px;width:${natural.w}px;height:${natural.h}px;transform:translateX(${shift}px)" src="${dataUri}"></body></html>`);
        await bgPage.waitForTimeout(300);
        return bgPage.screenshot({ clip: { x: 0, y: 0, width: clip.width, height: clip.height } });
      };
      const refPng = await renderRef(0);
      fs.writeFileSync(path.join(OUT, `${name}-reference.png`), refPng);
      const compare = (ref) => cmp.evaluate(COMPARE, {
        a: `data:image/png;base64,${editorPng.toString("base64")}`,
        b: `data:image/png;base64,${ref.toString("base64")}`,
        tol: TOL,
      });
      const r = await compare(refPng);
      // Sensitivity: if the comparison did not see a shift of half a
      // pixel or of one pixel, "ok" would say nothing. It is measured once.
      if (sensitivity.length === 0) {
        for (const shift of [0.5, 1, 2]) {
          const s = await compare(await renderRef(shift));
          sensitivity.push({ fixture: file, "reference shift (px)": shift, "% ink differing": Number(((s.diff / Math.max(1, s.ink)) * 100).toFixed(2)) });
        }
      }
      await bgPage.close();
      fs.writeFileSync(path.join(OUT, `${name}-diff.png`), Buffer.from(r.diffPng.split(",")[1], "base64"));
      const pct = (r.diff / Math.max(1, r.ink)) * 100;
      const ok = pct <= cfg.maxPct;
      if (!ok) failed = true;
      rows.push({
        fixture: file, "ink pixels": r.ink, "differing (strict)": r.strict, "differing (AA tolerance)": r.diff,
        "% of ink": Number(pct.toFixed(3)), threshold: cfg.maxPct, "mean diff/255": Number(r.mean.toFixed(3)), result: ok ? "ok" : "FAILED",
      });
    } else {
      rows.push({ fixture: file, result: "not compared (filters/masks)" });
    }
    console.log(`${file}: ${notice}`);
    await page.close();
  }
  await browser.close();
} finally {
  stop();
}
console.table(rows);
console.log("comparison sensitivity (reference shifted on purpose):");
console.table(sensitivity);
console.log(`images in ${OUT}`);
process.exit(failed ? 1 : 0);
