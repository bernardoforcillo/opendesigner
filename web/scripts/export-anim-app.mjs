// The exported animations WORK: it exports the example document with the
// clips (samples.AnimDemo) in the `react` target (Motion) and in the `html` target (CSS
// @keyframes), builds the app (tsc + vite build) and runs in Chromium a test
// that samples opacity / transform / stroke over TIME and under hover and tap.
//
//   pnpm export-anim-app                  # uses Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH)
//   CHROMIUM_PATH=/usr/bin/chromium pnpm export-anim-app
//
// It needs the network for `npm install` (see /root/.ccr/README.md if it goes through a proxy).
// It writes to web/export-parity-out/anim-app and anim-html (gitignored).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const webDir = process.cwd();
const repoDir = path.resolve(webDir, "..");
const WORK = path.resolve(webDir, "export-parity-out");
const appDir = path.join(WORK, "anim-app");
const htmlDir = path.join(WORK, "anim-html");
fs.rmSync(appDir, { recursive: true, force: true });
fs.rmSync(htmlDir, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = path.join(root, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  return "";
}

const bin = path.join(WORK, "opendesigner");
run("go", ["build", "-o", bin, "./cmd/opendesigner"], repoDir);
run("go", ["run", "./scripts/gen-export-samples", "-out", path.join(WORK, "samples")], repoDir);
const sample = path.join(WORK, "samples", "anim.json");
run(bin, ["export", "-json", sample, "-target", "react", "-out", appDir], repoDir);
run(bin, ["export", "-json", sample, "-target", "html", "-out", htmlDir], repoDir);

// The test: it samples what Chromium COMPUTES, not the source.
const spec = `import { test, expect, type Page, type Locator } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

// matrix(a,b,c,d,e,f) | none -> {angle (degrees), scale, tx, ty}
const parse = (t: string) => {
  if (!t || t === "none") return { angle: 0, scale: 1, tx: 0, ty: 0 };
  const m = t.match(/matrix\\(([^)]+)\\)/);
  if (!m) throw new Error("unexpected transform: " + t);
  const [a, b, , , e, f] = m[1].split(",").map(Number);
  return { angle: (Math.atan2(b, a) * 180) / Math.PI, scale: Math.hypot(a, b), tx: e, ty: f };
};
const css = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const opacity = async (l: Locator) => Number(await css(l, "opacity"));
const tf = async (l: Locator) => parse(await css(l, "transform"));
const byId = (page: Page, id: string) => page.getByTestId(id);

// How to sample over time without sleeping idly: read right after
// loading, halfway and at the end.
async function sampleOpacity(l: Locator, times: number[]) {
  const out: number[] = [];
  const t0 = Date.now();
  for (const t of times) {
    const wait = t - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    out.push(await opacity(l));
  }
  return out;
}

test.describe("react + Motion", () => {
  test("enter: the card enters in opacity and in y with a delay, the title in scale", async ({ page }) => {
    await page.goto("/", { waitUntil: "commit" });
    const card = byId(page, "card");
    await card.waitFor({ state: "attached" });
    // sample every 60ms: the series rises, starts below 1 and reaches 1
    const series: number[] = [];
    for (let i = 0; i < 30; i++) {
      series.push(await opacity(card));
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);
    const late = await opacity(card);
    expect(series[0]).toBeLessThan(0.7);             // initial: opacity 0, then it rises
    expect(series.some((v) => v > 0.02 && v < 0.98)).toBe(true);   // intermediate values: it is animating
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] - 1e-6);
    expect(late).toBe(1);
    // y: starts from -20 (relative to the design position) and reaches 0
    expect((await tf(card)).ty).toBeCloseTo(0, 1);
    const title = byId(page, "title");
    expect((await tf(title)).scale).toBeCloseTo(1, 2);
  });

  test("draw: pathLength goes from 0 to 1 on the vector's path", async ({ page }) => {
    await page.goto("/");
    const path = page.locator('[data-node-id="sig"] path');
    await path.waitFor();
    const dash = async () => (await css(path, "stroke-dasharray")).split(/[ ,]+/).map((s) => parseFloat(s));
    const first = await dash();
    await page.waitForTimeout(900);
    const mid = await dash();
    await page.waitForTimeout(1500);
    const end = await dash();
    // Motion writes "<length> 1" with a normalised length (pathLength=1)
    expect(first[0]).toBeLessThan(0.5);
    expect(mid[0]).toBeGreaterThan(first[0]);
    expect(end[0]).toBeCloseTo(1, 2);
  });

  test("loop: the circle rotates back and forth without stopping", async ({ page }) => {
    await page.goto("/");
    const spin = byId(page, "spin");
    await spin.waitFor();
    const angles: number[] = [];
    for (let i = 0; i < 6; i++) {
      angles.push((await tf(spin)).angle);
      await page.waitForTimeout(350);
    }
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(20);
    for (const a of angles) { expect(a).toBeGreaterThanOrEqual(-1); expect(a).toBeLessThanOrEqual(181); }
  });

  test("hover/tap on the button: scales the button and dims the label (a descendant)", async ({ page }) => {
    await page.goto("/");
    const btn = byId(page, "btn");
    const label = byId(page, "btn-label");
    await page.waitForTimeout(2200); // the entrances are finished
    expect((await tf(btn)).scale).toBeCloseTo(1, 2);
    expect(await opacity(label)).toBe(1);
    await btn.hover();
    await page.waitForTimeout(600);
    expect((await tf(btn)).scale).toBeCloseTo(1.08, 2);
    expect(await opacity(label)).toBeCloseTo(0.8, 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    expect((await tf(btn)).scale).toBeCloseTo(0.95, 2);
    await page.mouse.up();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(600);
    expect((await tf(btn)).scale).toBeCloseTo(1, 2);
    expect(await opacity(label)).toBeCloseTo(1, 2);
  });

  test("hover: rotate and x are DELTAS and compose with the base rotation and position", async ({ page }) => {
    await page.goto("/");
    const tilt = byId(page, "tilt");
    await page.waitForTimeout(2200);
    const left0 = (await tilt.boundingBox())!;
    expect(await css(tilt, "rotate")).toBe("30deg");     // the base rotation stays
    await tilt.hover();
    await page.waitForTimeout(700);
    const t = await tf(tilt);                            // Motion's delta: +30 degrees and +30px
    expect(t.angle).toBeCloseTo(30, 0);
    expect(t.tx).toBeCloseTo(30, 0);
    expect(await css(tilt, "rotate")).toBe("30deg");
    expect(left0.width).toBeGreaterThan(0);
  });
});

test.describe("html + CSS keyframes", () => {
  const url = pathToFileURL(path.join(process.env.ANIM_HTML_DIR!, "animations.html")).href;

  test("enter: opacity from the delay to the end, y from -20 to 0 (translate)", async ({ page }) => {
    await page.goto(url);
    const card = byId(page, "card");
    const [early, mid, late] = await sampleOpacity(card, [0, 600, 1800]);
    expect(early).toBeLessThan(0.3);
    expect(mid).toBeGreaterThan(early);
    expect(mid).toBeLessThan(1);
    expect(late).toBe(1);
    expect(await css(card, "translate")).toMatch(/^(0px|none)( 0px)?$/);
  });

  test("draw: stroke-dasharray from 0 to 1", async ({ page }) => {
    await page.goto(url);
    const path = page.locator('[data-node-id="sig"] path');
    const dash = async () => parseFloat((await css(path, "stroke-dasharray")).split(/[ ,]+/)[0]);
    const first = await dash();
    await page.waitForTimeout(1100);
    const mid = await dash();
    await page.waitForTimeout(1500);
    const end = await dash();
    expect(first).toBeLessThan(0.3);
    expect(mid).toBeGreaterThan(first);
    expect(end).toBeCloseTo(1, 2);
  });

  test("loop: the rotate property changes over time", async ({ page }) => {
    await page.goto(url);
    const spin = byId(page, "spin");
    const vals: number[] = [];
    for (let i = 0; i < 5; i++) { vals.push(parseFloat(await css(spin, "rotate")) || 0); await page.waitForTimeout(300); }
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(15);
  });

  test("hover and tap: the button's scale, the label's opacity", async ({ page }) => {
    await page.goto(url);
    const btn = byId(page, "btn");
    const label = byId(page, "btn-label");
    await page.waitForTimeout(300);
    expect(await css(btn, "scale")).toMatch(/^(none|1)$/);
    await btn.hover();
    await page.waitForTimeout(600);
    expect(parseFloat(await css(btn, "scale"))).toBeCloseTo(1.08, 2);
    expect(await opacity(label)).toBeCloseTo(0.8, 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    expect(parseFloat(await css(btn, "scale"))).toBeCloseTo(0.95, 2);
    await page.mouse.up();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    expect(await css(btn, "scale")).toMatch(/^(none|1)$/);
  });

  test("hover: rotate (property) and x (translate) compose with the base transform:rotate(30deg)", async ({ page }) => {
    await page.goto(url);
    const tilt = byId(page, "tilt");
    expect(await css(tilt, "transform")).toContain("matrix");   // base rotate(30deg)
    await tilt.hover();
    await page.waitForTimeout(700);
    expect(parseFloat(await css(tilt, "rotate"))).toBeCloseTo(30, 0);
    expect(await css(tilt, "translate")).toMatch(/^30px/);
    expect((await tf(tilt)).angle).toBeCloseTo(30, 0);          // the base is still there
  });
});
`;
fs.mkdirSync(path.join(appDir, "tests"), { recursive: true });
fs.writeFileSync(path.join(appDir, "tests", "anim.spec.ts"), spec);

run("npm", ["install", "--no-audit", "--no-fund"], appDir);
run("npm", ["run", "build"], appDir);
run("npx", ["playwright", "test", "--workers=1"], appDir, { PW_CHROMIUM_PATH: chromiumPath(), ANIM_HTML_DIR: htmlDir });
console.log("Animated app exported: build succeeded and animations verified in Chromium (react+Motion and html+CSS).");
