// Verifica dell'import SVG IN UN BROWSER VERO.
//
// Per ogni fixture di src/svg/__fixtures__/:
//   1. apre l'editor (server Go + web/dist) su un documento nuovo;
//   2. mette l'SVG negli appunti e preme Ctrl+V: è il percorso REALE dell'incolla
//      (tools/clipboard.ts -> tools/svgImport.ts -> importSvg), gesto compreso;
//   3. fotografa il canvas attorno alla radice importata (zoom 1, dpr 1: un
//      pixel del canvas = un pixel dell'immagine);
//   4. fa disegnare lo STESSO file al browser (un <img src=data:...> alla stessa
//      dimensione, sullo stesso colore di fondo) e confronta i due pixel per pixel.
//
//   pnpm svg-import                       # tutto: build web, build server, avvio, confronto
//   pnpm svg-import -- --skip-build       # riusa web/dist e il binario già pronti
//   pnpm svg-import -- --scheme dark      # editor a tema scuro
//   CHROMIUM_PATH=/usr/bin/chromium pnpm svg-import
//
// COSA SI TOLLERA (e perché):
//   - un pixel è "diverso" se un suo canale differisce di più di TOL (64/255)
//     dal pixel nello stesso punto del riferimento. Sotto, è rumore di
//     anti-aliasing: il canvas 2D e il rasterizzatore delle immagini SVG di
//     Chromium non dosano la copertura di un bordo allo stesso modo (misurato:
//     tutti i pixel oltre 32 sono bordi, nessuno oltre ~110, nessuno interno).
//     64 = una copertura che differisce di circa un quarto di pixel;
//   - nessuna tolleranza di vicinato: un vicinato 3x3 perdonerebbe uno
//     spostamento di un intero pixel, cioè proprio l'errore da trovare.
//     La verifica di SENSIBILITÀ in fondo lo dimostra: lo stesso confronto,
//     con il riferimento spostato di proposito (mezzo pixel, uno, due), deve
//     vedere la differenza;
//   - la percentuale è sui pixel "d'inchiostro" (diversi dal fondo in almeno una
//     delle due immagini), non sull'area: un'icona sottile è quasi tutta fondo.
//   - il testo è l'unico con una soglia più larga (crenatura e hinting diversi
//     fra canvas.fillText e <text>): vedi `maxPct` nelle fixture.
//
// Salva editor / riferimento / differenza in web/svg-import-out/ (gitignorato).
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

// Per fixture: se confrontarla col browser e quanto margine di pixel diversi.
const CONFIG = {
  "logo-gradient.svg": { compare: true, maxPct: 1.0 }, // contiene testo
  "icon-strokes-arcs.svg": { compare: true, maxPct: 1.0 },
  "illustration-nested.svg": { compare: true, maxPct: 1.0 },
  // Filtri, maschere, pattern: il browser li applica, noi li segnaliamo e basta.
  "hostile.svg": { compare: false, maxPct: 100 },
};

function build() {
  if (!flag("skip-build")) {
    execFileSync("npx", ["vite", "build"], { cwd: WEB, stdio: "inherit" });
    // il build svuota dist: .gitkeep serve all'embed del frontend
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
    try { if ((await fetch(url)).ok) return; } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`il server non risponde su ${url}`);
}

async function createDoc(name) {
  const res = await fetch(`http://localhost:${PORT}/opendesigner.v1.DocumentService/CreateDocument`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  return (await res.json()).id;
}

// Il confronto vive in una pagina vuota: il browser sa già decodificare i PNG.
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
const stop = () => { try { server.kill(); } catch { /* già giù */ } };
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
    page.on("pageerror", (e) => console.error(`[${file}] errore nella pagina:`, e.message));
    const docId = await createDoc(`svg-import ${name}`);
    await page.goto(`http://localhost:${PORT}/?renderer=${RENDERER}#doc=${docId}`);
    await page.waitForFunction(() => !!document.querySelector(".bg-ok"), { timeout: 30000 });
    await page.waitForTimeout(500);
    // La scheda "Da dove parti?" copre il centro del canvas su un documento vuoto.
    await page.getByRole("button", { name: /Chiudi e non mostrare/ }).click({ timeout: 3000 }).catch(() => {});

    const canvasRect = () => page.evaluate(() => {
      const r = (document.getElementById("overlay") ?? document.querySelector("canvas")).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    // L'import è CENTRATO sul centro della vista com'è PRIMA dell'avviso.
    const r0 = await canvasRect();
    // L'incolla, davvero: testo negli appunti + Ctrl+V.
    await page.mouse.click(720, 700);
    await page.evaluate((t) => navigator.clipboard.writeText(t), svg);
    await page.keyboard.press("Control+V");
    let notice = "";
    try {
      const banner = page.getByText(/Importato come|Importazione SVG non riuscita/).first();
      await banner.waitFor({ timeout: 8000 });
      notice = (await banner.textContent()) ?? "";
    } catch { notice = "(nessun avviso)"; }
    // Deseleziona (la selezione disegna maniglie sopra il disegno) e lascia
    // il tempo al frame successivo.
    await page.mouse.click(720, 150);
    await page.mouse.move(40, 840);
    await page.waitForTimeout(600);

    // Il banner dell'avviso spinge il canvas in basso: la radice si muove con lui.
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
      // Il riferimento: lo stesso file, disegnato dal browser, sul colore di
      // fondo dell'editor (il pixel d'angolo dello scatto, fuori dal disegno).
      const bgPage = await ctx.newPage();
      const b64 = editorPng.toString("base64");
      const bg = await bgPage.evaluate((src) => new Promise((res) => {
        const i = new Image(); i.onload = () => { const cv = document.createElement("canvas"); cv.width = 1; cv.height = 1; const x = cv.getContext("2d"); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, 1, 1).data; res(`rgb(${d[0]},${d[1]},${d[2]})`); }; i.src = src;
      }), `data:image/png;base64,${b64}`);
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      await bgPage.setViewportSize({ width: clip.width + 20, height: clip.height + 20 });
      // `shift` (px) sposta il riferimento: serve alla verifica di sensibilità.
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
      // Sensibilità: se il confronto non vedesse uno spostamento di mezzo
      // pixel o di un pixel, "ok" non direbbe niente. Si misura una volta.
      if (sensitivity.length === 0) {
        for (const shift of [0.5, 1, 2]) {
          const s = await compare(await renderRef(shift));
          sensitivity.push({ fixture: file, "spostamento riferimento (px)": shift, "% d'inchiostro diverso": Number(((s.diff / Math.max(1, s.ink)) * 100).toFixed(2)) });
        }
      }
      await bgPage.close();
      fs.writeFileSync(path.join(OUT, `${name}-diff.png`), Buffer.from(r.diffPng.split(",")[1], "base64"));
      const pct = (r.diff / Math.max(1, r.ink)) * 100;
      const ok = pct <= cfg.maxPct;
      if (!ok) failed = true;
      rows.push({
        fixture: file, "pixel d'inchiostro": r.ink, "diversi (strict)": r.strict, "diversi (tolleranza AA)": r.diff,
        "% d'inchiostro": Number(pct.toFixed(3)), soglia: cfg.maxPct, "diff media/255": Number(r.mean.toFixed(3)), esito: ok ? "ok" : "FALLITO",
      });
    } else {
      rows.push({ fixture: file, esito: "non confrontata (filtri/maschere)" });
    }
    console.log(`${file}: ${notice}`);
    await page.close();
  }
  await browser.close();
} finally {
  stop();
}
console.table(rows);
console.log("sensibilità del confronto (riferimento spostato di proposito):");
console.table(sensitivity);
console.log(`immagini in ${OUT}`);
process.exit(failed ? 1 : 0);
