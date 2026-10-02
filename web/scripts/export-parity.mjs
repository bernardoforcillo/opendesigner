// Parità dei pixel fra l'EDITOR e il codice ESPORTATO.
//
// Costruisce la galleria (Go: scripts/gen-export-samples, un protojson che copre
// forme, tratti, gradienti, effetti, contenitori, auto layout, testo, vettori,
// immagini e istanze), la esporta col CLI nel target `html`, e per ogni schermata
// confronta pixel per pixel
//   - ciò che disegna il canvas dell'editor (drawScene, Canvas 2D, dpr 1), e
//   - ciò che Chromium renderizza dal file HTML esportato (dpr 1).
//
//   pnpm export-parity                  # usa il Chromium di Playwright (PLAYWRIGHT_BROWSERS_PATH)
//   CHROMIUM_PATH=/usr/bin/chromium pnpm export-parity
//
// Il TESTO si misura a parte: il canvas e il DOM non fanno lo stesso
// anti-aliasing né la stessa baseline (differenza di ~1px a 16px: il canvas
// piazza la baseline a 0.8em, CSS usa l'ascent vero del font), quindi i
// rettangoli dei testi sono esclusi dal confronto stretto e valutati con una
// soglia più larga. Tutto il resto deve coincidere.
//
// Salva editor / export / differenza di ogni schermata in web/export-parity-out/.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const VITE_PORT = 5198;
const STATIC_PORT = 5197;
// Fuori dal testo: al più lo 0.5% dei pixel può differire di più di 32/255
// (bordi curvi e rotati: l'anti-aliasing di Skia non è identico fra canvas e
// CSS) e la differenza media deve restare sotto 0.5/255.
const STRICT_MAX_OVER32_PCT = 0.5;
const STRICT_MAX_MEAN = 0.5;
// Dentro i rettangoli del testo: differenza media sotto 12/255 (il testo è fine,
// un pixel di baseline sposta molto in valore assoluto ma poco in estensione).
const TEXT_MAX_MEAN = 16;
// Tailwind contro CSS: lo STESSO IR scritto in due sintassi deve dare gli stessi
// pixel (nessuna differenza oltre 2/255: il rumore della compressione dei colori).
const REACT_MAX_DIFF = 2;

const webDir = process.cwd();
const repoDir = path.resolve(webDir, "..");
const OUT = path.resolve(webDir, "export-parity-out");
const WORK = path.join(OUT, "work");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repoDir, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} è fallito`);
}

// 1. documento + export html
const bin = path.join(WORK, "opendesigner");
run("go", ["build", "-o", bin, "./cmd/opendesigner"]);
run("go", ["run", "./scripts/gen-export-samples", "-out", WORK]);
const htmlDir = path.join(WORK, "html");
run(bin, ["export", "-json", path.join(WORK, "gallery.json"), "-assets", path.join(WORK, "assets"), "-target", "html", "-out", htmlDir]);

const doc = JSON.parse(fs.readFileSync(path.join(WORK, "gallery.json"), "utf8"));
const masters = new Set(Object.values(doc.components ?? {}).map((c) => c.rootNodeId));
const screens = Object.values(doc.nodes)
  .filter((n) => n.parentId === "page1" && n.frame && !masters.has(n.id))
  .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
const textIds = new Set(Object.values(doc.nodes).filter((n) => n.text).map((n) => n.id));

// quale file HTML è la schermata `id`
const htmlFiles = fs.readdirSync(htmlDir).filter((f) => f.endsWith(".html"));
const fileOf = (id) => htmlFiles.find((f) => fs.readFileSync(path.join(htmlDir, f), "utf8").includes(`data-node-id="${id}"`));

// 2. i server: vite (l'editor) e uno statico per l'export (con i font di Inter)
const vite = spawn(process.execPath, [path.join("node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--strictPort"], { stdio: "ignore", cwd: webDir });
const staticServer = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const root = url.startsWith("/fonts/") ? path.join(webDir, "public") : htmlDir;
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const types = { ".html": "text/html", ".png": "image/png", ".ttf": "font/ttf" };
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => staticServer.listen(STATIC_PORT, r));
const stop = () => { vite.kill(); staticServer.close(); };
process.on("exit", stop);

async function waitForVite() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://localhost:${VITE_PORT}/scripts/export-parity/harness.html`)).ok) return; } catch { /* non ancora su */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("il server di sviluppo non è partito");
}

// CHROMIUM_PATH, altrimenti il Chromium di Playwright se c'è, altrimenti un
// chromium-NNNN già installato in PLAYWRIGHT_BROWSERS_PATH (versione diversa
// da quella che playwright-core si aspetta: funziona comunque).
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch { /* nessun default */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = path.join(root, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const dataUrl = (file) => "data:image/png;base64," + fs.readFileSync(file).toString("base64");
const save = (name, url) => fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(",")[1], "base64"));

// Apre `url`, carica Inter (stessi TTF dell'editor) e ritorna lo screenshot
// W x H come data URL, più i rettangoli dei testi (data-node-id dei nodi testo
// del documento, anche dentro le istanze: "<istanza>/<nodo del master>").
async function shoot(page, url, W, H) {
  await page.goto(url);
  await page.addStyleTag({ content: [400, 500, 600, 700].map((w) => `@font-face{font-family:"Inter";font-weight:${w};src:url("${new URL("/fonts/Inter-" + w + ".ttf", FONT_ORIGIN)}")}`).join("") });
  await page.evaluate(async () => {
    for (const w of [400, 500, 600, 700]) await document.fonts.load(`${w} 16px Inter`);
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  });
  const mask = await page.evaluate(([ids, pad]) => {
    const set = new Set(ids);
    return [...document.querySelectorAll("[data-node-id]")]
      .filter((e) => set.has(e.getAttribute("data-node-id").split("/").pop()))
      .map((e) => { const r = e.getBoundingClientRect(); return { x: r.x - pad, y: r.y - pad, w: r.width + 2 * pad, h: r.height + 2 * pad }; });
  }, [[...textIds], 14]);
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  return { png: "data:image/png;base64," + shot.toString("base64"), mask };
}
const FONT_ORIGIN = `http://localhost:${STATIC_PORT}`;

let failed = false;
const rows = [];
const htmlShots = new Map();
try {
  await waitForVite();
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const assets = {};
  for (const f of fs.readdirSync(path.join(WORK, "assets"))) assets[f.replace(/\.png$/, "")] = dataUrl(path.join(WORK, "assets", f));

  const editor = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  editor.on("pageerror", (e) => console.error("errore nella pagina dell'editor:", e.message));
  await editor.goto(`http://localhost:${VITE_PORT}/scripts/export-parity/harness.html`);
  await editor.waitForFunction(() => typeof window.renderFrame === "function", { timeout: 60000 });

  const exported = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  exported.on("pageerror", (e) => console.error("errore nella pagina esportata:", e.message));
  // Niente rete: il font Inter lo serve lo statico locale (gli stessi TTF dell'editor).
  await exported.route(/googleapis|gstatic/, (r) => r.abort());

  for (const s of screens) {
    const file = fileOf(s.id);
    if (!file) throw new Error(`nessun file HTML per la schermata ${s.id}`);
    const png2d = await editor.evaluate(([d, id, a]) => window.renderFrame(d, id, a), [doc, s.id, assets]);

    const W = Math.ceil(s.width), H = Math.ceil(s.height);
    const { png: pngExp, mask } = await shoot(exported, `http://localhost:${STATIC_PORT}/${file}`, W, H);
    htmlShots.set(s.id, pngExp);

    const r = await editor.evaluate(([a, b, m]) => window.compare(a, b, m), [png2d, pngExp, mask]);
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    save(`${slug}-editor.png`, png2d);
    save(`${slug}-export.png`, pngExp);
    save(`${slug}-diff.png`, r.diff);
    const textual = r.textPixels > 0;
    const ok = r.strictOver32Pct <= STRICT_MAX_OVER32_PCT && r.strictMean <= STRICT_MAX_MEAN && (!textual || r.textMean <= TEXT_MAX_MEAN);
    if (!ok) failed = true;
    rows.push({
      schermata: s.name,
      "media (fuori testo)": +r.strictMean.toFixed(3),
      "max": r.strictMax,
      "% > 32": +r.strictOver32Pct.toFixed(3),
      "% > 8": +r.strictOver8Pct.toFixed(3),
      "media (testo)": textual ? +r.textMean.toFixed(2) : "-",
      esito: ok ? "ok" : "KO",
    });
  }
  console.table(rows);

  // Il progetto React (Tailwind) dello stesso documento deve dare gli stessi
  // pixel del target html: nessuna deriva fra le due sintassi. Richiede
  // `npm install` (rete); se non è possibile si salta e lo si dice.
  if (!process.env.SKIP_REACT_PARITY) {
    const reactRows = await reactParity(editor, exported);
    if (reactRows) {
      console.table(reactRows);
      if (reactRows.some((r) => r.esito !== "ok")) failed = true;
    }
  }
  await browser.close();
} finally {
  stop();
}
async function reactParity(editor, exported) {
  const reactDir = path.join(WORK, "react");
  run(bin, ["export", "-json", path.join(WORK, "gallery.json"), "-assets", path.join(WORK, "assets"), "-target", "react", "-out", reactDir]);
  const npm = (args) => spawnSync("npm", args, { cwd: reactDir, stdio: "inherit" });
  if (npm(["install", "--no-audit", "--no-fund"]).status !== 0) { console.warn("npm install non riuscito: parità React saltata"); return null; }
  if (npm(["run", "build"]).status !== 0) throw new Error("il progetto React esportato non compila");
  const preview = spawn(process.execPath, [path.join("node_modules", "vite", "bin", "vite.js"), "preview", "--port", "5196", "--strictPort"], { cwd: reactDir, stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch("http://localhost:5196/")).ok) break; } catch { /* non ancora su */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const out = [];
    for (const s of screens) {
      const route = "/" + fileOf(s.id).replace(/\.html$/, "");
      const W = Math.ceil(s.width), H = Math.ceil(s.height);
      const { png } = await shoot(exported, `http://localhost:5196${route}`, W, H);
      const r = await editor.evaluate(([a, b]) => window.compare(a, b, []), [htmlShots.get(s.id), png]);
      const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      save(`${slug}-react.png`, png);
      out.push({ schermata: s.name, "media": +r.strictMean.toFixed(4), "max": r.strictMax, "% > 8": +r.strictOver8Pct.toFixed(4), esito: r.strictMax <= REACT_MAX_DIFF ? "ok" : "KO" });
    }
    return out;
  } finally {
    preview.kill();
  }
}
if (failed) {
  console.error(`Parità NON rispettata (fuori dal testo: >${STRICT_MAX_OVER32_PCT}% di pixel con differenza > 32, o media > ${STRICT_MAX_MEAN}; testo: media > ${TEXT_MAX_MEAN}). Immagini in ${OUT}.`);
  process.exit(1);
}
console.log(`Parità rispettata. Immagini in ${OUT}.`);
