import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyOp } from "../store/applyOp";
import { emptyScene, toNodeLite, type NodeLite, type SceneState } from "../store/types";
import { vectorBounds } from "../store/vectorGeometry";
import { applyTransform } from "../canvas/transform";
import { nodesToSvg } from "../export/svg";
import { MAX_SVG_BYTES, SvgImportError, importSvg, imageSizeOf, type ImportOptions, type ImportResult } from "./importSvg";
import { parsePathData, transformCmds, type PathCmd } from "./pathData";
import { parseTransform } from "./transform";

// --- helpers ------------------------------------------------------------------

const NS = `xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`;

function seq(prefix = "n"): () => string {
  let i = 0;
  return () => `${prefix}${i++}`;
}

function svg(inner: string, attrs = `viewBox="0 0 100 100" width="100" height="100"`): string {
  return `<svg ${NS} ${attrs}>${inner}</svg>`;
}

interface Run {
  r: ImportResult;
  nodes: NodeLite[];
  root: NodeLite;
  byName: (name: string) => NodeLite;
  children: (id: string) => NodeLite[];
  leaves: () => NodeLite[];
}

function run(source: string, opts: ImportOptions = {}): Run {
  const r = importSvg(source, { newId: seq(), parentId: "page1", ...opts });
  const nodes = r.ops.map((op) => {
    if (op.kind.case !== "createNode" || !op.kind.value.node) throw new Error("op inatteso");
    return toNodeLite(op.kind.value.node);
  });
  const byName = (name: string) => {
    const n = nodes.find((x) => x.name === name);
    if (!n) throw new Error(`nodo "${name}" non trovato fra ${nodes.map((x) => x.name).join(", ")}`);
    return n;
  };
  return {
    r, nodes, root: nodes[0], byName,
    children: (id) => nodes.filter((n) => n.parentId === id),
    leaves: () => nodes.filter((n) => n.kind !== "group"),
  };
}

const near = (a: number, b: number, digits = 3) => expect(a).toBeCloseTo(b, digits);

function sceneFrom(r: ImportResult): SceneState {
  let s = emptyScene("doc", "doc");
  for (const op of r.ops) s = applyOp(s, op);
  return s;
}

// t del gradiente in un punto, secondo il MODELLO: coordinate normalizzate del
// box del nodo (annullando la rotazione), asse p1->p2, isolivelli ortogonali.
function modelT(n: NodeLite, px: number, py: number): number {
  const g = n.fills[0].gradient!;
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  const a = (-n.rotation * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  const qx = cx + dx * Math.cos(a) - dy * Math.sin(a);
  const qy = cy + dx * Math.sin(a) + dy * Math.cos(a);
  const X = qx - n.x, Y = qy - n.y;
  const x1 = g.x1 * n.width, y1 = g.y1 * n.height, x2 = g.x2 * n.width, y2 = g.y2 * n.height;
  const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  return ((X - x1) * (x2 - x1) + (Y - y1) * (y2 - y1)) / len2;
}

// ----------------------------------------------------------------------------

describe("importSvg: struttura e op", () => {
  it("un gruppo radice col titolo come nome e i figli dentro, in ordine padre-prima", () => {
    const { r, nodes, root } = run(svg(`<title>Logo</title><rect width="10" height="10"/><circle cx="5" cy="5" r="2"/>`));
    expect(root.kind).toBe("group");
    expect(root.name).toBe("Logo");
    expect(root.parentId).toBe("page1");
    expect(r.rootId).toBe(root.id);
    expect(nodes.length).toBe(3);
    expect(r.nodeCount).toBe(3);
    const seen = new Set<string>(["page1"]);
    for (const n of nodes) {
      expect(seen.has(n.parentId)).toBe(true);
      seen.add(n.id);
    }
    expect(r.ops.every((op) => op.kind.case === "createNode")).toBe(true);
  });

  it("gli id sono deterministici con un generatore iniettato (e distinti senza)", () => {
    const s = svg(`<rect width="10" height="10"/><g><circle r="3"/></g>`);
    const a = importSvg(s, { newId: seq("a") });
    const b = importSvg(s, { newId: seq("a") });
    const ids = (r: ImportResult) => r.ops.map((o) => (o.kind.case === "createNode" ? o.kind.value.node?.id : ""));
    expect(ids(a)).toEqual(ids(b));
    expect(new Set([...ids(a)]).size).toBe(ids(a).length);
    const c = importSvg(s);
    const d = importSvg(s);
    expect(ids(c)[0]).not.toBe(ids(d)[0]);
    expect(ids(c)[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("docId e opId finiscono negli op; orderKey della radice dall'opzione, figli crescenti", () => {
    const r = importSvg(svg(`<rect width="1" height="1"/><rect width="2" height="2"/><rect width="3" height="3"/>`), {
      newId: seq(), docId: "doc-9", parentId: "p", orderKey: "a000005",
    });
    expect(r.ops.every((o) => o.docId === "doc-9" && o.opId !== "")).toBe(true);
    const ks = r.ops.map((o) => (o.kind.case === "createNode" ? o.kind.value.node!.orderKey : ""));
    expect(ks[0]).toBe("a000005");
    expect(ks[1] < ks[2] && ks[2] < ks[3]).toBe(true);
  });

  it("gli op sono applicabili dal reducer e producono l'albero atteso", () => {
    const { r } = run(svg(`<g id="g"><rect id="r" width="10" height="10"/><path id="p" d="M0 0L10 10"/></g>`));
    const s = sceneFrom(r);
    expect(s.nodes.size).toBe(4);
  });

  it("un <g> senza figli disegnabili non lascia un gruppo vuoto", () => {
    const { nodes } = run(svg(`<g id="vuoto"><defs/><title>x</title></g><rect id="r" width="5" height="5"/>`));
    expect(nodes.map((n) => n.name)).toEqual(["SVG", "r"]);
  });

  it("l'ordine di disegno è quello del documento", () => {
    const { nodes } = run(svg(`<rect id="a" width="1" height="1"/><rect id="b" width="1" height="1"/><rect id="c" width="1" height="1"/>`));
    const sorted = nodes.slice(1).sort((x, y) => (x.orderKey < y.orderKey ? -1 : 1)).map((n) => n.name);
    expect(sorted).toEqual(["a", "b", "c"]);
  });
});

describe("importSvg: nomi", () => {
  it("inkscape:label > data-name > id > fallback numerato per tipo", () => {
    const { nodes } = run(svg(
      `<rect inkscape:label="Etichetta" data-name="dn" id="i" width="1" height="1"/>` +
      `<rect data-name="dn" id="i2" width="1" height="1"/>` +
      `<rect id="solo-id" width="1" height="1"/>` +
      `<rect width="1" height="1"/><rect width="1" height="1"/><circle r="1"/><ellipse rx="1" ry="2"/>` +
      `<line x2="5"/><polyline points="0,0 5,5"/><polygon points="0,0 5,0 5,5"/><path d="M0 0L5 5"/><path d="M1 1L7 7"/>`,
      `${"xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\""} viewBox="0 0 100 100" width="100" height="100"`,
    ));
    expect(nodes.slice(1).map((n) => n.name)).toEqual([
      "Etichetta", "dn", "solo-id", "Rettangolo 1", "Rettangolo 2", "Cerchio 1", "Ellisse 1",
      "Linea 1", "Polilinea 1", "Poligono 1", "Path 1", "Path 2",
    ]);
  });

  it("riconosce inkscape:label anche senza xmlns:inkscape dichiarato", () => {
    const { byName } = run(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect inkscape:label="Senza ns" width="5" height="5"/></svg>`);
    expect(byName("Senza ns").kind).toBe("rect");
  });

  it("nome del file di ripiego per la radice; titolo e id hanno la precedenza giusta", () => {
    expect(run(svg(`<rect width="1" height="1"/>`), { name: "logo" }).root.name).toBe("logo");
    expect(run(svg(`<title>Titolo</title><rect width="1" height="1"/>`), { name: "logo" }).root.name).toBe("Titolo");
    expect(run(`<svg ${NS} id="Layer_1" viewBox="0 0 1 1" width="1" height="1"><rect width="1" height="1"/></svg>`, { name: "logo" }).root.name).toBe("logo");
    expect(run(`<svg ${NS} id="Layer_1" viewBox="0 0 1 1" width="1" height="1"><rect width="1" height="1"/></svg>`).root.name).toBe("Layer_1");
    expect(run(svg(`<rect width="1" height="1"/>`)).root.name).toBe("SVG");
  });

  it("i nomi sono ripuliti da caratteri di controllo e troncati", () => {
    const { nodes } = run(svg(`<rect id="a&#10;b&#9;c" width="1" height="1"/><rect id="${"x".repeat(300)}" width="1" height="1"/>`));
    expect(nodes[1].name).toBe("a b c");
    expect(nodes[2].name.length).toBe(100);
  });

  it("il testo prende il proprio contenuto come nome", () => {
    const { nodes } = run(svg(`<text x="1" y="10">Ciao mondo</text>`));
    expect(nodes[1].name).toBe("Ciao mondo");
  });
});

describe("importSvg: dimensioni e viewBox", () => {
  it("viewBox senza width/height: la dimensione è quella del viewBox", () => {
    const { r } = run(`<svg ${NS} viewBox="0 0 24 24"><rect width="24" height="24"/></svg>`);
    expect(r.size).toEqual({ width: 24, height: 24 });
  });

  it("width/height senza viewBox: unità utente = px, le lunghezze con unità si convertono", () => {
    const { r, nodes } = run(`<svg ${NS} width="2in" height="96px"><rect width="96" height="96"/></svg>`);
    expect(r.size).toEqual({ width: 192, height: 96 });
    expect(nodes[1]).toMatchObject({ width: 96, height: 96 });
  });

  it("un viewBox con origine non nulla trasla il contenuto", () => {
    const { nodes } = run(`<svg ${NS} viewBox="10 20 100 100" width="100" height="100"><rect x="10" y="20" width="5" height="5"/></svg>`);
    expect(nodes[1]).toMatchObject({ x: 0, y: 0 });
  });

  it("un viewBox più largo del viewport lo centra (xMidYMid meet)", () => {
    // viewport 200x100, viewBox 100x100: scala 1, contenuto centrato in orizzontale (+50)
    const { nodes, r } = run(`<svg ${NS} viewBox="0 0 100 100" width="200" height="100"><rect width="10" height="10"/></svg>`);
    expect(r.size).toEqual({ width: 200, height: 100 });
    expect(nodes[1]).toMatchObject({ x: 50, y: 0, width: 10, height: 10 });
  });

  it("preserveAspectRatio: none stira, xMinYMin allinea, slice riempie", () => {
    const base = (par: string) =>
      run(`<svg ${NS} viewBox="0 0 100 100" width="200" height="100" preserveAspectRatio="${par}"><rect width="100" height="100"/></svg>`);
    // rect 100x100 in un viewBox 100x100 su viewport 200x100:
    expect(base("none").nodes[1]).toMatchObject({ x: 0, width: 200 }); // stirato: non è una similitudine -> vettoriale
  });

  it("un SVG grande si rimpicciolisce in proporzione al lato lungo massimo", () => {
    const { r, nodes } = run(`<svg ${NS} viewBox="0 0 2000 1000" width="2000" height="1000"><rect width="2000" height="1000"/></svg>`, { maxSize: 500 });
    expect(r.size).toEqual({ width: 500, height: 250 });
    expect(nodes[1]).toMatchObject({ width: 500, height: 250 });
    // e uno piccolo NON si ingrandisce
    expect(run(`<svg ${NS} viewBox="0 0 24 24"><rect width="24" height="24"/></svg>`).r.size.width).toBe(24);
    // il default è 512
    expect(run(`<svg ${NS} viewBox="0 0 1024 1024"><rect width="1024" height="1024"/></svg>`).r.size.width).toBe(512);
  });

  it("una scala esplicita vince su maxSize", () => {
    const { r, nodes } = run(`<svg ${NS} viewBox="0 0 24 24"><rect width="24" height="24"/></svg>`, { scale: 10, maxSize: 100 });
    expect(r.size).toEqual({ width: 240, height: 240 });
    expect(nodes[1]).toMatchObject({ width: 240 });
  });

  it("`at` posiziona la radice; i figli restano locali", () => {
    const { root, nodes } = run(svg(`<rect x="5" y="5" width="10" height="10"/>`), { at: { x: 300, y: 400 } });
    expect(root).toMatchObject({ x: 300, y: 400 });
    expect(nodes[1]).toMatchObject({ x: 5, y: 5 });
  });

  it("senza viewBox né dimensioni usa la dimensione del contenuto e avvisa", () => {
    const { r, nodes } = run(`<svg ${NS}><rect x="50" y="60" width="30" height="20"/></svg>`);
    expect(r.size).toEqual({ width: 30, height: 20 });
    expect(nodes[1]).toMatchObject({ x: 0, y: 0, width: 30, height: 20 });
    expect(r.warnings.join(" ")).toMatch(/senza viewBox/);
  });

  it("larghezza in percentuale senza viewBox non si prende per una misura", () => {
    const { r } = run(`<svg ${NS} width="100%" height="100%"><rect width="40" height="10"/></svg>`);
    expect(r.size).toEqual({ width: 40, height: 10 });
  });
});

describe("importSvg: forme", () => {
  it("rect: x/y/width/height, raggio, raggio solo rx o solo ry, clamp a metà lato", () => {
    const { nodes } = run(svg(
      `<rect x="1" y="2" width="30" height="20" rx="4"/>` +
      `<rect width="30" height="20" ry="3"/>` +
      `<rect width="20" height="20" rx="500"/>`,
    ));
    expect(nodes[1]).toMatchObject({ kind: "rect", x: 1, y: 2, width: 30, height: 20, cornerRadius: 4 });
    expect(nodes[2]).toMatchObject({ kind: "rect", cornerRadius: 3 });
    expect(nodes[3]).toMatchObject({ kind: "rect", cornerRadius: 10 });
  });

  it("rect con rx diverso da ry diventa un path (il modello ha un solo raggio)", () => {
    const { nodes } = run(svg(`<rect width="30" height="20" rx="6" ry="3"/>`));
    expect(nodes[1].kind).toBe("vector");
    expect(nodes[1].vector!.subpaths[0].closed).toBe(true);
    near(nodes[1].width, 30);
    near(nodes[1].height, 20);
  });

  it("rect a dimensione nulla o negativa non si disegna (e non produce un nodo)", () => {
    const { nodes } = run(svg(`<rect width="0" height="5"/><rect width="5" height="-1"/><rect height="5"/><rect id="ok" width="1" height="1"/>`));
    expect(nodes.map((n) => n.name)).toEqual(["SVG", "ok"]);
  });

  it("circle ed ellipse -> nodi ellisse nel box giusto", () => {
    const { nodes } = run(svg(`<circle cx="50" cy="40" r="10"/><ellipse cx="30" cy="30" rx="20" ry="5"/><ellipse cx="9" cy="9" rx="4"/>`));
    expect(nodes[1]).toMatchObject({ kind: "ellipse", x: 40, y: 30, width: 20, height: 20 });
    expect(nodes[2]).toMatchObject({ kind: "ellipse", x: 10, y: 25, width: 40, height: 10 });
    // solo rx: ry = rx
    expect(nodes[3]).toMatchObject({ kind: "ellipse", width: 8, height: 8 });
  });

  it("line -> path aperto di due ancoraggi; polyline aperta; polygon chiuso", () => {
    const { nodes } = run(svg(`<line x1="10" y1="20" x2="30" y2="60" stroke="red"/><polyline points="0,0 10,10 20,0" stroke="red" fill="none"/><polygon points="0,0 10,0 10,10"/>`));
    const [l, pl, pg] = [nodes[1], nodes[2], nodes[3]];
    expect(l.vector!.subpaths[0]).toMatchObject({ closed: false });
    expect(l).toMatchObject({ x: 10, y: 20, width: 20, height: 40 });
    expect(l.vector!.subpaths[0].anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [20, 40]]);
    expect(pl.vector!.subpaths[0].anchors.length).toBe(3);
    expect(pl.vector!.subpaths[0].closed).toBe(false);
    expect(pg.vector!.subpaths[0].closed).toBe(true);
  });

  it("points con numero dispari di coordinate: l'ultima si scarta e si avvisa; meno di due punti: niente", () => {
    const { r, nodes } = run(svg(`<polyline points="0,0 10,10 20" stroke="red"/><polygon points="5,5"/>`));
    expect(nodes.length).toBe(2);
    expect(nodes[1].vector!.subpaths[0].anchors.length).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/dispari/);
  });

  it("path: geometria normalizzata al box (bbox locale = (0,0)-(w,h)) con la bbox VERA delle curve", () => {
    const { nodes } = run(svg(`<path d="M10 50 C10 0 90 0 90 50"/>`));
    const n = nodes[1];
    expect(n.kind).toBe("vector");
    // la cubica non esce dal rettangolo dei suoi estremi in x ma sale in y fino a 12.5
    near(n.x, 10); near(n.width, 80);
    near(n.y, 12.5); near(n.height, 37.5);
    const b = vectorBounds(n.vector!.subpaths);
    near(b.x, 0); near(b.y, 0); near(b.width, n.width); near(b.height, n.height);
  });

  it("un path con dati non validi si disegna fino all'errore e avvisa; vuoto non produce un nodo", () => {
    const { r, nodes } = run(svg(`<path d="M0 0 L10 10 L oops"/><path d=""/><path/>`));
    expect(nodes.length).toBe(2);
    expect(r.warnings.join(" ")).toMatch(/dati non validi/);
  });
});

describe("importSvg: trasformazioni", () => {
  it("rect con translate+scale resta un rect (similitudine)", () => {
    const { nodes } = run(svg(`<rect x="10" y="20" width="30" height="10" transform="translate(5 5) scale(2)"/>`));
    expect(nodes[1]).toMatchObject({ kind: "rect", x: 25, y: 45, width: 60, height: 20, rotation: 0 });
  });

  it("rect ruotato: box non ruotato attorno al centro trasformato + rotazione", () => {
    const { nodes } = run(svg(`<rect x="10" y="20" width="30" height="10" transform="rotate(90)"/>`));
    const n = nodes[1];
    expect(n.kind).toBe("rect");
    near(n.rotation, 90);
    // centro (25,25) -> (-25,25)
    near(n.x + n.width / 2, -25);
    near(n.y + n.height / 2, 25);
    near(n.width, 30);
    near(n.height, 10);
  });

  it("rect con rotate(a cx cy) tiene il centro quando coincide con quello della forma", () => {
    const { nodes } = run(svg(`<rect x="10" y="10" width="20" height="20" transform="rotate(45 20 20)"/>`));
    const n = nodes[1];
    near(n.x, 10); near(n.y, 10); near(n.rotation, 45);
  });

  it("rect riflesso o con skew diventa un path con gli angoli trasformati", () => {
    const { nodes } = run(svg(`<rect width="10" height="10" transform="skewX(45)"/>`));
    const n = nodes[1];
    expect(n.kind).toBe("vector");
    near(n.width, 20);
    expect(n.vector!.subpaths[0].anchors.map((a) => [Math.round(a.x), Math.round(a.y)])).toEqual([[0, 0], [10, 0], [20, 10], [10, 10]]);
    const flip = run(svg(`<rect width="10" height="10" transform="scale(-1 1)"/>`)).nodes[1];
    expect(flip.kind).toBe("vector");
    near(flip.x, -10);
  });

  it("ellisse con scala non uniforme -> path a quattro ancoraggi, area giusta", () => {
    const { nodes } = run(svg(`<circle cx="50" cy="50" r="10" transform="scale(3 1)"/>`));
    const n = nodes[1];
    expect(n.kind).toBe("vector");
    near(n.width, 60); near(n.height, 20); near(n.x, 120); near(n.y, 40);
    expect(n.vector!.subpaths[0].anchors.length).toBe(4);
    // ellisse con rotazione e scala uniforme: resta un'ellisse
    expect(run(svg(`<ellipse rx="10" ry="5" transform="rotate(30) scale(2)"/>`)).nodes[1].kind).toBe("ellipse");
  });

  it("path: ogni ancoraggio e ogni maniglia seguono la matrice", () => {
    const d = "M0 0 C10 0 20 10 30 10 L30 30";
    const { nodes } = run(svg(`<path d="${d}" transform="translate(10 20) rotate(30) scale(2 1)"/>`));
    const n = nodes[1];
    const M = parseTransform("translate(10 20) rotate(30) scale(2 1)").matrix;
    const expected = transformCmds(parsePathData(d).cmds, M);
    const c = expected[1] as Extract<PathCmd, { t: "C" }>;
    const a0 = n.vector!.subpaths[0].anchors[0];
    // world = node.x + a.x ; handle world = anchor + out
    near(n.x + a0.x, (expected[0] as { x: number }).x);
    near(n.y + a0.y, (expected[0] as { y: number }).y);
    near(n.x + a0.x + a0.outX, c.x1);
    near(n.y + a0.y + a0.outY, c.y1);
    const a1 = n.vector!.subpaths[0].anchors[1];
    near(n.x + a1.x + a1.inX, c.x2);
    near(n.y + a1.y + a1.inY, c.y2);
    near(n.x + a1.x, c.x);
  });

  it("una pura traslazione di un <g> diventa x/y del GRUPPO e i figli restano locali", () => {
    const { nodes, byName } = run(svg(`<g id="g" transform="translate(30 40)"><rect id="r" x="1" y="2" width="3" height="4"/></g>`));
    expect(byName("g")).toMatchObject({ kind: "group", x: 30, y: 40 });
    expect(byName("r")).toMatchObject({ x: 1, y: 2, width: 3, height: 4 });
    expect(nodes.find((n) => n.name === "r")!.parentId).toBe(byName("g").id);
  });

  it("la scala del viewport entra nel x/y del gruppo e nella geometria dei figli", () => {
    const { byName } = run(`<svg ${NS} viewBox="0 0 100 100" width="200" height="200"><g id="g" transform="translate(30 40)"><rect id="r" x="1" y="2" width="3" height="4"/></g></svg>`);
    expect(byName("g")).toMatchObject({ x: 60, y: 80 });
    expect(byName("r")).toMatchObject({ x: 2, y: 4, width: 6, height: 8 });
  });

  it("un <g> con scala/rotazione non ha x/y: la matrice si cuoce nei figli", () => {
    const { byName } = run(svg(`<g id="g" transform="scale(2)"><rect id="r" x="1" y="2" width="3" height="4"/></g>`));
    expect(byName("g")).toMatchObject({ x: 0, y: 0, rotation: 0 });
    expect(byName("r")).toMatchObject({ x: 2, y: 4, width: 6, height: 8 });
  });

  it("gruppi annidati con traslazioni: ognuno ha la sua", () => {
    const { byName } = run(svg(`<g id="a" transform="translate(10 0)"><g id="b" transform="translate(0 20)"><rect id="r" width="1" height="1"/></g></g>`));
    expect(byName("a")).toMatchObject({ x: 10, y: 0 });
    expect(byName("b")).toMatchObject({ x: 0, y: 20 });
  });

  it("composizione: la posizione MONDO del figlio è quella dello SVG", () => {
    const src = svg(`<g transform="translate(10 5) scale(2)"><g transform="translate(3 1)"><rect id="r" x="1" y="1" width="2" height="2"/></g></g>`);
    const { r } = run(src);
    const s = sceneFrom(r);
    const r0 = [...s.nodes.values()].find((n) => n.name === "r")!;
    // mondo = M·point: punto (1,1) -> translate(3 1) -> (4,2) -> scale(2) -> (8,4) -> translate(10 5) -> (18,9)
    let x = r0.x, y = r0.y;
    let p: NodeLite | undefined = r0;
    while (p && p.parentId !== "page1") { p = s.nodes.at(p.parentId); if (p) { x += p.x; y += p.y; } }
    expect([x, y]).toEqual([18, 9]);
    near(r0.width, 4);
  });

  it("transform non valido: si applica ciò che è valido e si avvisa", () => {
    const { r, nodes } = run(svg(`<rect width="10" height="10" transform="translate(5 5) bogus(2)"/>`));
    expect(nodes[1]).toMatchObject({ x: 5, y: 5 });
    expect(r.warnings.join(" ")).toMatch(/transform non valido/);
  });

  it("la proprietà CSS transform in style funziona come l'attributo", () => {
    const { nodes } = run(svg(`<rect width="10" height="10" style="transform: translate(7px, 3px)"/>`));
    expect(nodes[1]).toMatchObject({ x: 7, y: 3 });
  });
});

describe("importSvg: stile", () => {
  const fillOf = (n: NodeLite) => n.fills[0];

  it("attributo, style inline e classe del <style>: la precedenza è attr < classe < style", () => {
    const { byName } = run(svg(
      `<style>.c{fill:#00ff00} #idr{fill:#0000ff} rect{fill:#ffff00}</style>` +
      `<rect id="a" fill="#ff0000" width="1" height="1"/>` +
      `<rect id="b" fill="#ff0000" class="c" width="1" height="1"/>` +
      `<rect id="c" fill="#ff0000" class="c" style="fill:#ffffff" width="1" height="1"/>` +
      `<rect id="idr" class="c" width="1" height="1"/>` +
      `<circle id="d" fill="#123456" r="1"/>`,
    ));
    expect(fillOf(byName("a"))).toMatchObject({ r: 1, g: 1, b: 0 }); // il selettore `rect` batte l'attributo
    expect(fillOf(byName("b"))).toMatchObject({ r: 0, g: 1, b: 0 });
    expect(fillOf(byName("c"))).toMatchObject({ r: 1, g: 1, b: 1 });
    expect(fillOf(byName("idr"))).toMatchObject({ r: 0, g: 0, b: 1 }); // #id batte .classe
    expect(Math.round(fillOf(byName("d")).r * 255)).toBe(0x12);
  });

  it("selettori combinati: discendente, figlio, tag.classe, liste", () => {
    const { byName } = run(svg(
      `<style>g.hills path{fill:#00ff00} g > .x{stroke:#ff0000;stroke-width:3} .a,.b{fill:#0000ff}</style>` +
      `<g class="hills"><path id="p" d="M0 0L5 5L0 5Z"/><g><path id="q" d="M0 0L5 5L0 5Z"/></g></g>` +
      `<g><rect id="x" class="x" width="2" height="2"/></g><rect id="b" class="b" width="1" height="1"/>`,
    ));
    expect(fillOf(byName("p"))).toMatchObject({ g: 1, r: 0 });
    expect(fillOf(byName("q"))).toMatchObject({ g: 1 });
    expect(byName("x").strokes[0].weight).toBe(3);
    expect(fillOf(byName("b"))).toMatchObject({ b: 1 });
  });

  it("ereditarietà da gruppi antenati; il figlio può sovrascrivere", () => {
    const { byName } = run(svg(
      `<g fill="#ff0000" stroke="#0000ff" stroke-width="4"><g><rect id="a" width="1" height="1"/></g><rect id="b" fill="#00ff00" width="1" height="1"/></g>`,
    ));
    expect(fillOf(byName("a"))).toMatchObject({ r: 1, g: 0 });
    expect(byName("a").strokes[0]).toMatchObject({ weight: 4, align: "center" });
    expect(byName("a").strokes[0].color).toMatchObject({ b: 1 });
    expect(fillOf(byName("b"))).toMatchObject({ g: 1 });
  });

  it("il default è fill nero e nessun tratto", () => {
    const n = run(svg(`<rect width="1" height="1"/>`)).nodes[1];
    expect(fillOf(n)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(n.strokes).toEqual([]);
  });

  it('fill="none" è un riempimento TRASPARENTE (non la lista vuota che il renderer legge come grigio)', () => {
    const n = run(svg(`<rect width="1" height="1" fill="none" stroke="red"/>`)).nodes[1];
    expect(n.fills.length).toBe(1);
    expect(fillOf(n).a).toBe(0);
    expect(n.strokes.length).toBe(1);
  });

  it("currentColor risolve `color` ereditato", () => {
    const { byName } = run(svg(`<g color="#ff00ff"><rect id="a" fill="currentColor" width="1" height="1"/><rect id="b" stroke="currentColor" fill="none" width="1" height="1"/></g>`));
    expect(fillOf(byName("a"))).toMatchObject({ r: 1, g: 0, b: 1 });
    expect(byName("b").strokes[0].color).toMatchObject({ r: 1, b: 1 });
  });

  it("colori in tutte le sintassi", () => {
    const { nodes } = run(svg(
      `<rect fill="rgb(255,0,0)" width="1" height="1"/><rect fill="hsl(120,100%,50%)" width="1" height="1"/>` +
      `<rect fill="navy" width="1" height="1"/><rect fill="#f0f" width="1" height="1"/><rect fill="rgba(0,0,0,.5)" width="1" height="1"/>`,
    ));
    expect(fillOf(nodes[1])).toMatchObject({ r: 1, g: 0 });
    expect(fillOf(nodes[2])).toMatchObject({ g: 1, r: 0 });
    near(fillOf(nodes[3]).b, 128 / 255, 3);
    expect(fillOf(nodes[4])).toMatchObject({ r: 1, b: 1 });
    expect(fillOf(nodes[5]).a).toBe(0.5);
  });

  it("colore sconosciuto: si avvisa e vale il default", () => {
    const { r, nodes } = run(svg(`<rect fill="bluish" width="1" height="1"/>`));
    expect(fillOf(nodes[1])).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(r.warnings.join(" ")).toMatch(/non riconosciuto/);
  });

  it("fill-opacity e stroke-opacity vanno nell'alfa delle tinte; opacity nel nodo", () => {
    const n = run(svg(`<rect width="1" height="1" fill="red" fill-opacity="0.4" stroke="blue" stroke-opacity="0.25" opacity="0.5"/>`)).nodes[1];
    near(fillOf(n).a, 0.4);
    near(n.strokes[0].color.a, 0.25);
    expect(n.opacity).toBe(0.5);
  });

  it("opacity dei gruppi si moltiplica nei figli (i gruppi non la disegnano)", () => {
    const { byName } = run(svg(`<g opacity="0.5"><g opacity="0.5"><rect id="r" opacity="0.5" width="1" height="1"/></g></g>`));
    expect(byName("r").opacity).toBe(0.125);
    expect(run(svg(`<g opacity="0.5"><rect id="r" width="1" height="1"/></g>`)).nodes[0].opacity).toBe(1);
  });

  it("stroke-width scala con la matrice; con unità e percentuali", () => {
    const { byName } = run(`<svg ${NS} viewBox="0 0 100 100" width="200" height="200"><rect id="a" width="10" height="10" stroke="red" stroke-width="3"/><rect id="b" width="10" height="10" stroke="red" stroke-width="2mm" transform="scale(2)"/></svg>`);
    expect(byName("a").strokes[0].weight).toBe(6);
    near(byName("b").strokes[0].weight, (2 * 96) / 25.4 * 4, 2);
  });

  it("stroke-width 0, stroke none o paint illeggibile: nessun tratto", () => {
    const { nodes } = run(svg(`<rect width="1" height="1" stroke="red" stroke-width="0"/><rect width="1" height="1" stroke="none"/><rect width="1" height="1" stroke="red" stroke-width="abc"/>`));
    expect(nodes[1].strokes).toEqual([]);
    expect(nodes[2].strokes).toEqual([]);
    expect(nodes[3].strokes[0].weight).toBe(1); // valore non leggibile -> default 1
  });

  it("display:none e visibility:hidden -> visible=false; il figlio può riaccendersi con visibility", () => {
    const { byName } = run(svg(
      `<g id="hidden" display="none"><rect id="in" width="1" height="1"/></g>` +
      `<g visibility="hidden"><rect id="v1" width="1" height="1"/><rect id="v2" visibility="visible" width="1" height="1"/></g>` +
      `<rect id="style-none" style="display:none" width="1" height="1"/>`,
    ));
    expect(byName("hidden").visible).toBe(false);
    expect(byName("in").visible).toBe(false);
    expect(byName("v1").visible).toBe(false);
    expect(byName("v2").visible).toBe(true);
    expect(byName("style-none").visible).toBe(false);
  });

  it("meta vettoriali: fill-rule, tratteggio (scalato), capi e giunti, niente filo", () => {
    const { byName } = run(`<svg ${NS} viewBox="0 0 100 100" width="200" height="200"><path id="p" d="M0 0L10 10L0 10Z" fill-rule="evenodd" stroke="red" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="7" stroke-dasharray="3 1" stroke-dashoffset="1"/><path id="q" d="M0 0L5 5"/></svg>`);
    expect(byName("p").meta).toEqual({
      "vector.hairline": "0", "vector.fillRule": "evenodd",
      "stroke.cap": "round", "stroke.join": "bevel", "stroke.miter": "7", "stroke.dash": "6,2", "stroke.dashOffset": "2",
    });
    expect(byName("q").meta).toEqual({ "vector.hairline": "0", "vector.fillRule": "nonzero" });
  });

  it("rect con tratteggio, o giunto non miter senza raggio, diventa path (per portarsi cap/join/dash)", () => {
    const { nodes } = run(svg(
      `<rect width="10" height="10" fill="none" stroke="red" stroke-dasharray="2 2"/>` +
      `<rect width="10" height="10" fill="none" stroke="red" stroke-linejoin="round"/>` +
      `<rect width="10" height="10" rx="2" fill="none" stroke="red" stroke-linejoin="round"/>` +
      `<circle r="5" fill="none" stroke="red" stroke-dasharray="1 1"/>`,
    ));
    expect(nodes[1].kind).toBe("vector");
    expect(nodes[1].meta?.["stroke.dash"]).toBe("2,2");
    expect(nodes[2].kind).toBe("vector");
    expect(nodes[2].meta?.["stroke.join"]).toBe("round");
    expect(nodes[3].kind).toBe("rect"); // con raggio il giunto non esiste
    expect(nodes[4].kind).toBe("vector");
  });

  it("un path aperto riempito si chiude se non ha tratto; con tratto si avvisa", () => {
    const a = run(svg(`<path d="M0 0L10 0L10 10" fill="red"/>`));
    expect(a.nodes[1].vector!.subpaths[0].closed).toBe(true);
    const b = run(svg(`<path d="M0 0L10 0L10 10" fill="red" stroke="blue"/>`));
    expect(b.nodes[1].vector!.subpaths[0].closed).toBe(false);
    expect(b.r.warnings.join(" ")).toMatch(/aperto con riempimento/);
    // una line (nessuna area) non avvisa
    expect(run(svg(`<line x2="5" stroke="red"/>`)).r.warnings).toEqual([]);
    // fill none: resta aperto
    expect(run(svg(`<path d="M0 0L10 0L10 10" fill="none" stroke="blue"/>`)).nodes[1].vector!.subpaths[0].closed).toBe(false);
  });
});

describe("importSvg: gradienti", () => {
  const rectWith = (grad: string, rect = `<rect id="r" width="100" height="100" fill="url(#g)"/>`, attrs?: string) =>
    run(svg(`<defs>${grad}</defs>${rect}`, attrs));

  it("lineare objectBoundingBox su box quadrato: asse (0,0)->(1,1) normalizzato; stop in ordine", () => {
    const { byName } = rectWith(`<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>`);
    const g = byName("r").fills[0].gradient!;
    expect(g.kind).toBe("linear");
    near(g.x1, 0); near(g.y1, 0); near(g.x2, 1); near(g.y2, 1);
    expect(g.stops.map((s) => [s.position, s.color.r, s.color.b])).toEqual([[0, 1, 0], [1, 0, 1]]);
    // r,g,b,a del fill = primo stop (tinta di ripiego)
    expect(byName("r").fills[0]).toMatchObject({ r: 1, b: 0 });
  });

  it("default: orizzontale da sinistra a destra", () => {
    const g = rectWith(`<linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`).byName("r").fills[0].gradient!;
    near(g.x1, 0); near(g.y1, 0); near(g.x2, 1); near(g.y2, 0);
  });

  it("userSpaceOnUse: coordinate assolute normalizzate sul box", () => {
    const g = rectWith(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="25" y1="0" x2="75" y2="0"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`,
      `<rect id="r" x="0" y="0" width="100" height="50" fill="url(#g)"/>`,
    ).byName("r").fills[0].gradient!;
    near(g.x1, 0.25); near(g.x2, 0.75); near(g.y1, 0); near(g.y2, 0);
  });

  it("userSpaceOnUse con percentuali riferite al viewport", () => {
    const g = rectWith(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0%" y1="0%" x2="50%" y2="0%"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`,
    ).byName("r").fills[0].gradient!;
    near(g.x2, 0.5);
  });

  it("gradientTransform: ruota l'asse", () => {
    const g = rectWith(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="100" y2="50" gradientTransform="rotate(90 50 50)"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`,
    ).byName("r").fills[0].gradient!;
    // l'asse orizzontale ruotato di 90° attorno al centro diventa verticale: dall'alto al basso
    near(g.x1, 0.5); near(g.x2, 0.5); near(g.y1, 0); near(g.y2, 1);
  });

  it("isolivelli esatti anche con bbox NON quadrato in diagonale (covettore, non vettore)", () => {
    const { byName } = rectWith(
      `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`,
      `<rect id="r" x="20" y="10" width="200" height="100" fill="url(#g)"/>`,
      `viewBox="0 0 300 200" width="300" height="200"`,
    );
    const n = byName("r");
    // SVG: t = ((x-20)/200 + (y-10)/100) / 2
    for (const [x, y] of [[20, 10], [220, 110], [120, 60], [20, 110], [220, 10], [70, 30]]) {
      near(modelT(n, x, y), ((x - 20) / 200 + (y - 10) / 100) / 2, 6);
    }
  });

  it("isolivelli esatti sotto rotazione e sotto skew", () => {
    const grad = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0.5"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`;
    // rotazione: il nodo resta un rect ruotato
    const rot = rectWith(grad, `<rect id="r" x="10" y="10" width="80" height="40" fill="url(#g)" transform="rotate(25 50 30)"/>`).byName("r");
    expect(rot.kind).toBe("rect");
    const M = parseTransform("rotate(25 50 30)").matrix;
    const svgT = (x: number, y: number) => {
      const u = [(x - 10) / 80, (y - 10) / 40];
      return (u[0] * 1 + u[1] * 0.5) / (1 + 0.25);
    };
    for (const [x, y] of [[10, 10], [90, 50], [50, 30], [70, 15]]) {
      const w = applyTransform(M, x, y);
      near(modelT(rot, w.x, w.y), svgT(x, y), 5);
    }
    // skew: diventa path; la geometria del gradiente resta esatta in coordinate mondo
    const sk = rectWith(grad, `<rect id="r" x="10" y="10" width="80" height="40" fill="url(#g)" transform="skewX(30)"/>`).byName("r");
    expect(sk.kind).toBe("vector");
    const Ms = parseTransform("skewX(30)").matrix;
    for (const [x, y] of [[10, 10], [90, 50], [50, 30]]) {
      const w = applyTransform(Ms, x, y);
      near(modelT(sk, w.x, w.y), svgT(x, y), 5);
    }
  });

  it("radiale: centro e raggio (cerchio), stop con opacità", () => {
    const { byName } = rectWith(
      `<radialGradient id="g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`,
    );
    const g = byName("r").fills[0].gradient!;
    expect(g.kind).toBe("radial");
    near(g.x1, 0.5); near(g.y1, 0.5);
    // raggio = distanza p1-p2 in unità del box (qui box 100x100): 50
    near(Math.hypot((g.x2 - g.x1) * 100, (g.y2 - g.y1) * 100), 50);
    near(g.stops[0].color.a, 0.9); near(g.stops[1].color.a, 0);
  });

  it("radiale userSpaceOnUse con gradientTransform di scala: il raggio segue la scala", () => {
    const g = rectWith(
      `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="10" gradientTransform="translate(50 50) scale(2) translate(-50 -50)"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient>`,
    ).byName("r").fills[0].gradient!;
    near(Math.hypot((g.x2 - g.x1) * 100, (g.y2 - g.y1) * 100), 20);
    near(g.x1, 0.5);
  });

  it("radiale ellittico (bbox non quadrato) e fuoco decentrato: ripiego con avviso", () => {
    const { r } = rectWith(
      `<radialGradient id="g" fx="0.2"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient>`,
      `<rect id="r" width="200" height="50" fill="url(#g)"/>`,
      `viewBox="0 0 200 100" width="200" height="100"`,
    );
    expect(r.warnings.join(" ")).toMatch(/ellittico/);
    expect(r.warnings.join(" ")).toMatch(/fuoco/);
  });

  it("href: gli stop e gli attributi si ereditano dal gradiente referenziato", () => {
    const { byName } = rectWith(
      `<linearGradient id="base" x1="0" y1="1" x2="1" y2="1"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="lime"/></linearGradient>` +
      `<linearGradient id="g" xlink:href="#base" x2="0.5"/>`,
    );
    const g = byName("r").fills[0].gradient!;
    expect(g.stops.length).toBe(2);
    near(g.y1, 1); near(g.x2, 0.5);
  });

  it("href ciclici non mandano in loop", () => {
    const { byName } = rectWith(`<linearGradient id="g" href="#h"/><linearGradient id="h" href="#g"/>`);
    expect(byName("r").fills[0].gradient).toBeUndefined();
  });

  it("stop: colore da classe/style, offset in %, ordine forzato crescente", () => {
    const g = rectWith(
      `<style>.s2{stop-color:#00ff00}</style><linearGradient id="g"><stop offset="50%" style="stop-color:#ff0000"/><stop offset="20%" class="s2"/><stop offset="2" stop-color="#0000ff"/></linearGradient>`,
    ).byName("r").fills[0].gradient!;
    expect(g.stops.map((s) => s.position)).toEqual([0.5, 0.5, 1]);
    expect(g.stops[1].color.g).toBe(1);
  });

  it("uno stop solo = colore pieno; nessuno stop = nessun riempimento; riferimento mancante = ripiego", () => {
    const one = rectWith(`<linearGradient id="g"><stop offset="0" stop-color="#ff0000" stop-opacity="0.5"/></linearGradient>`).byName("r").fills[0];
    expect(one.gradient).toBeUndefined();
    expect(one).toMatchObject({ r: 1, a: 0.5 });
    const none = rectWith(`<linearGradient id="g"/>`).byName("r").fills[0];
    expect(none.a).toBe(0);
    const missing = run(svg(`<rect id="r" width="1" height="1" fill="url(#nope) #00ff00"/><rect id="s" width="1" height="1" fill="url(#nope)"/>`));
    expect(missing.byName("r").fills[0]).toMatchObject({ g: 1 });
    expect(missing.byName("s").fills[0].a).toBe(0);
    expect(missing.r.warnings.join(" ")).toMatch(/non trovato/);
  });

  it("fill-opacity moltiplica l'alfa degli stop; il gradiente sul tratto funziona", () => {
    const { byName } = rectWith(
      `<linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`,
      `<rect id="r" width="50" height="50" fill="url(#g)" fill-opacity="0.5" stroke="url(#g)" stroke-width="4"/>`,
    );
    expect(byName("r").fills[0].gradient!.stops.map((s) => s.color.a)).toEqual([0.5, 0.5]);
    expect(byName("r").strokes[0].color.gradient).toBeDefined();
  });

  it("spreadMethod diverso da pad: avviso; pattern: avviso e grigio", () => {
    const a = rectWith(`<linearGradient id="g" spreadMethod="reflect"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`);
    expect(a.r.warnings.join(" ")).toMatch(/spreadMethod/);
    const b = run(svg(`<defs><pattern id="p" width="2" height="2"/></defs><rect id="r" width="5" height="5" fill="url(#p)"/>`));
    expect(b.r.warnings.join(" ")).toMatch(/pattern/);
    expect(b.byName("r").fills[0]).toMatchObject({ r: 0.5 });
  });

  it("gradiente su un path: objectBoundingBox rispetto alla bbox del path (non del viewport)", () => {
    const { byName } = rectWith(
      `<linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>`,
      `<path id="r" d="M40 40 L80 40 L80 60 L40 60 Z" fill="url(#g)"/>`,
    );
    const n = byName("r");
    near(modelT(n, 40, 50), 0); near(modelT(n, 80, 50), 1); near(modelT(n, 60, 50), 0.5);
  });
});

describe("importSvg: <use>", () => {
  it("istanzia un elemento di <defs> dentro un gruppo col nome dello use; x/y traslano il gruppo", () => {
    const { byName, nodes } = run(svg(`<defs><rect id="shape" width="10" height="10" fill="#ff0000"/></defs><use id="u" href="#shape" x="30" y="40"/>`));
    expect(byName("u")).toMatchObject({ kind: "group", x: 30, y: 40 });
    const inner = nodes.find((n) => n.parentId === byName("u").id)!;
    expect(inner).toMatchObject({ kind: "rect", name: "shape", x: 0, y: 0 });
    expect(inner.fills[0].r).toBe(1);
  });

  it("xlink:href, transform e istanze multiple dello stesso elemento", () => {
    const { nodes } = run(svg(`<defs><circle id="c" r="5"/></defs><use xlink:href="#c" transform="translate(10 10)"/><use href="#c" transform="translate(50 50) scale(2)"/>`));
    expect(nodes.filter((n) => n.kind === "ellipse").length).toBe(2);
    const big = nodes.filter((n) => n.kind === "ellipse")[1];
    near(big.width, 20);
  });

  it("lo stile dello <use> si eredita nel contenuto referenziato; il contenuto può sovrascrivere", () => {
    const { nodes } = run(svg(`<defs><g id="s"><rect width="1" height="1"/><rect width="1" height="1" fill="#00ff00"/></g></defs><use href="#s" fill="#ff0000"/>`));
    const rects = nodes.filter((n) => n.kind === "rect");
    expect(rects[0].fills[0]).toMatchObject({ r: 1, g: 0 });
    expect(rects[1].fills[0]).toMatchObject({ g: 1 });
  });

  it("riferimento mancante, esterno o ricorsivo: avviso e niente nodi", () => {
    const { r, nodes } = run(svg(
      `<defs><g id="loop"><use href="#loop"/><rect width="1" height="1"/></g></defs><use href="#nope"/><use href="https://x.example/a.svg#b"/><use href="#loop"/>`,
    ));
    expect(r.warnings.join(" ")).toMatch(/non esiste/);
    expect(r.warnings.join(" ")).toMatch(/esterno/);
    expect(r.warnings.join(" ")).toMatch(/ricorsivo/);
    expect(nodes.filter((n) => n.kind === "rect").length).toBe(1);
  });

  it("<symbol> con viewBox si adatta a width/height dello use", () => {
    const { nodes } = run(svg(`<defs><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs><use href="#s" width="50" height="50"/>`));
    const rect = nodes.find((n) => n.kind === "rect")!;
    near(rect.width, 50);
  });

  it("un use di un use: la catena si risolve", () => {
    const { nodes } = run(svg(`<defs><rect id="a" width="2" height="2"/><use id="b" href="#a" x="5"/></defs><use href="#b" y="7"/>`));
    expect(nodes.filter((n) => n.kind === "rect").length).toBe(1);
  });
});

describe("importSvg: testo", () => {
  const measure = (t: string) => t.length * 10;

  it("un nodo di testo con le proprietà del font; baseline -> top del box", () => {
    const { nodes } = run(svg(`<text x="10" y="50" font-size="20" font-family="Arial" font-weight="bold" fill="#ff0000">Ciao</text>`, `viewBox="0 0 200 100" width="200" height="100"`), { measureText: measure });
    const n = nodes[1];
    expect(n.kind).toBe("text");
    expect(n.text!.content).toBe("Ciao");
    expect(n.text!.style).toMatchObject({ fontFamily: "Arial", fontSize: 20, fontWeight: "700", align: "left" });
    expect(n.fills[0]).toMatchObject({ r: 1 });
    // ascent = (lineHeight-size)/2 + 0.8*size con interlinea 1.2: 0.9*20 = 18
    near(n.y, 50 - 18);
    near(n.x, 10);
    near(n.height, 24);
  });

  it("text-anchor middle/end: allineamento del box rispetto ad x", () => {
    const mid = run(svg(`<text x="100" y="50" font-size="20" text-anchor="middle">abcd</text>`, `viewBox="0 0 200 100" width="200" height="100"`), { measureText: measure }).nodes[1];
    expect(mid.text!.style.align).toBe("center");
    near(mid.x + mid.width / 2, 100);
    const end = run(svg(`<text x="100" y="50" font-size="20" text-anchor="end">abcd</text>`, `viewBox="0 0 200 100" width="200" height="100"`), { measureText: measure }).nodes[1];
    expect(end.text!.style.align).toBe("right");
    near(end.x + end.width, 100);
  });

  it("senza misuratore usa una stima ragionevole", () => {
    const n = run(svg(`<text x="0" y="20" font-size="10">abcdef</text>`)).nodes[1];
    expect(n.width).toBeGreaterThan(20);
    expect(n.width).toBeLessThan(120);
  });

  it("più <tspan> con y o dy diversi diventano righe; l'interlinea è un moltiplicatore", () => {
    const n = run(svg(`<text x="10" y="20" font-size="16"><tspan x="10">uno</tspan><tspan x="10" dy="24">due</tspan></text>`), { measureText: measure }).nodes[1];
    expect(n.text!.content).toBe("uno\ndue");
    near(n.text!.style.lineHeight, 1.5);
    const same = run(svg(`<text x="10" y="20"><tspan>uno </tspan><tspan fill="red">due</tspan></text>`), { measureText: measure }).nodes[1];
    expect(same.text!.content).toBe("uno due");
  });

  it("spazi bianchi compressi; xml:space=preserve li tiene", () => {
    const a = run(svg(`<text x="0" y="10">  a   b \n  c </text>`), { measureText: measure }).nodes[1];
    expect(a.text!.content).toBe("a b c");
    const b = run(svg(`<text x="0" y="10" xml:space="preserve">a  b</text>`), { measureText: measure }).nodes[1];
    expect(b.text!.content).toBe("a  b");
  });

  it("testo vuoto non produce nodo; textPath avvisa e rende il testo", () => {
    const { nodes } = run(svg(`<text x="0" y="10">   </text><text x="0" y="30"><textPath href="#p">su un tracciato</textPath></text><path id="p" d="M0 0L10 10" stroke="red"/>`), { measureText: measure });
    expect(nodes.filter((n) => n.kind === "text").length).toBe(1);
  });

  it("testo scalato e ruotato dalla matrice (similitudine)", () => {
    const n = run(svg(`<text x="10" y="40" font-size="10" transform="rotate(90) scale(2)">ab</text>`, `viewBox="0 0 100 100" width="100" height="100"`), { measureText: measure }).nodes[1];
    near(n.text!.style.fontSize, 20);
    near(n.rotation, 90);
  });
});

describe("importSvg: immagini incorporate", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("data URI -> nodo immagine (hash vuoto) + asset in sospeso con i byte", () => {
    const { r, nodes } = run(svg(`<image id="img" x="10" y="20" width="40" height="40" href="data:image/png;base64,${PNG}" preserveAspectRatio="none"/>`));
    const n = nodes[1];
    expect(n).toMatchObject({ kind: "image", name: "img", x: 10, y: 20, width: 40, height: 40 });
    expect(n.image).toEqual({ assetHash: "" });
    expect(r.assets.length).toBe(1);
    expect(r.assets[0]).toMatchObject({ nodeId: n.id, mime: "image/png", name: "img" });
    expect(r.assets[0].bytes.length).toBeGreaterThan(20);
    expect(imageSizeOf(r.assets[0].bytes)).toEqual({ width: 1, height: 1 });
  });

  it("preserveAspectRatio di default (meet): il box si riduce all'immagine e si centra", () => {
    const n = run(svg(`<image x="0" y="0" width="40" height="20" xlink:href="data:image/png;base64,${PNG}"/>`)).nodes[1];
    // 1x1 in 40x20 -> 20x20 centrata
    expect(n).toMatchObject({ x: 10, y: 0, width: 20, height: 20 });
  });

  it("dimensioni mancanti: dalle intestazioni del file", () => {
    const n = run(svg(`<image href="data:image/png;base64,${PNG}"/>`)).nodes[1];
    expect(n).toMatchObject({ width: 1, height: 1 });
  });

  it("immagine esterna o non leggibile: avviso, nessun nodo", () => {
    const { r, nodes } = run(svg(`<image width="5" height="5" href="https://x.example/a.png"/><image width="5" height="5" href="data:image/png;base64,@@@"/><rect id="ok" width="1" height="1"/>`));
    expect(nodes.map((n) => n.name)).toEqual(["SVG", "ok"]);
    expect(r.warnings.join(" ")).toMatch(/esterna/);
    expect(r.warnings.join(" ")).toMatch(/non leggibile/);
    expect(r.assets).toEqual([]);
  });

  it("imageSizeOf: GIF e JPEG", () => {
    expect(imageSizeOf(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0, 0, 0]))).toEqual({ width: 5, height: 7 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 20, 0, 30, 3, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSizeOf(jpeg)).toEqual({ width: 30, height: 20 });
    expect(imageSizeOf(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("importSvg: sanitizzazione", () => {
  it("script, gestori di eventi, foreignObject e href esterni non producono nulla e si segnalano", () => {
    const { r, nodes } = run(svg(
      `<script>alert(1)</script><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>` +
      `<rect id="ok" width="10" height="10" onclick="alert(2)" onmouseover="x()"/><a href="javascript:alert(3)"><rect id="linked" width="5" height="5"/></a>`,
    ).replace("<svg ", `<svg onload="alert(0)" `));
    expect(nodes.map((n) => n.name)).toEqual(["SVG", "ok", "Gruppo 1", "linked"]);
    expect(r.warnings).toContain("<script> rimosso");
    expect(r.warnings).toContain("<foreignObject> rimosso");
    // nessuna traccia di script/handler nel modello
    expect(JSON.stringify(nodes)).not.toMatch(/alert|onclick|javascript/);
  });

  it("riferimenti esterni nel paint, negli use, nelle immagini e nel CSS", () => {
    const { r } = run(svg(
      `<style>@import url("https://evil.example/x.css"); .a{fill:url(http://evil.example/p.svg#x)}</style>` +
      `<rect class="a" width="1" height="1"/><use href="http://evil.example/s.svg#i"/><image width="1" height="1" href="//evil.example/p.png"/>`,
    ));
    expect(r.warnings.join(" | ")).toMatch(/riferimento esterno a un paint/);
    expect(r.warnings.join(" | ")).toMatch(/@import/);
    expect(r.warnings.join(" | ")).toMatch(/<use> con riferimento esterno/);
    expect(r.warnings.join(" | ")).toMatch(/immagine esterna/);
  });

  it("feature non supportate: UN avviso ciascuna, con conteggio, e il rendering prosegue", () => {
    const { r, nodes } = run(svg(
      `<defs><filter id="f"/><clipPath id="c"/><mask id="m"/></defs>` +
      `<rect id="a" width="5" height="5" filter="url(#f)"/><rect id="b" width="5" height="5" filter="url(#f)"/><rect id="c2" width="5" height="5" clip-path="url(#c)" mask="url(#m)"/>` +
      `<rect id="d" width="5" height="5" style="mix-blend-mode:multiply"/><path id="e" d="M0 0L5 5" stroke="red" marker-end="url(#mk)"/>` +
      `<animate attributeName="x"/><animateTransform attributeName="transform"/>`,
    ));
    expect(nodes.length).toBe(6);
    expect(r.warnings).toContain("filtro non supportato: ignorato (2×)");
    expect(r.warnings).toContain("clip-path non supportato: ignorato");
    expect(r.warnings).toContain("maschera non supportato: ignorato");
    expect(r.warnings).toContain("blend mode non supportato: ignorato");
    expect(r.warnings).toContain("marker non supportato: ignorato");
    expect(r.warnings).toContain("animazione SMIL ignorata (2×)");
  });

  it("@keyframes CSS: avviso (le animazioni si ricostruiscono, non si importano)", () => {
    const { r } = run(svg(`<style>@keyframes spin{to{transform:rotate(360deg)}}</style><rect width="5" height="5"/>`));
    expect(r.warnings).toContain("animazioni CSS (@keyframes) ignorate");
  });

  it("entità XML: rifiutate; XML malformato e radice non SVG: errore chiaro", () => {
    expect(() => importSvg(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)).toThrow(/entità/);
    expect(() => importSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>`)).toThrow(SvgImportError);
    expect(() => importSvg(`<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>`)).toThrow(/non è un SVG/);
    expect(() => importSvg("")).toThrow(/vuoto/);
    expect(() => importSvg("   \n ")).toThrow(/vuoto/);
    expect(() => importSvg("non è xml")).toThrow(SvgImportError);
  });

  it("senza forme disegnabili: errore chiaro", () => {
    expect(() => importSvg(svg(`<defs><rect id="x" width="1" height="1"/></defs>`))).toThrow(/forme importabili/);
  });

  it("un SVG senza xmlns (scritto a mano) si legge lo stesso", () => {
    const r = importSvg(`<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>`, { newId: seq() });
    expect(r.nodeCount).toBe(2);
  });

  it("xlink:href senza xmlns:xlink dichiarato si legge lo stesso", () => {
    const r = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><rect id="a" width="5" height="5"/></defs><use xlink:href="#a"/></svg>`, { newId: seq() });
    expect(r.nodeCount).toBe(3);
  });
});

describe("importSvg: limiti", () => {
  it("oltre 5 MB: errore chiaro prima ancora di parsare", () => {
    const big = svg(`<rect width="1" height="1"/>`) + " ".repeat(MAX_SVG_BYTES);
    expect(() => importSvg(big)).toThrow(/supera 5 MB/);
    expect(() => importSvg(svg(`<rect width="1" height="1"/>`), { maxBytes: 20 })).toThrow(SvgImportError);
  });

  it("i byte contano, non i caratteri (UTF-8 multibyte)", () => {
    const s = svg(`<title>${"à".repeat(60)}</title><rect width="1" height="1"/>`);
    expect(() => importSvg(s, { maxBytes: s.length + 10 })).toThrow(/supera/);
  });

  it("oltre il massimo di nodi: errore chiaro", () => {
    const many = svg(Array.from({ length: 60 }, () => `<rect width="1" height="1"/>`).join(""));
    expect(() => importSvg(many, { maxNodes: 50 })).toThrow(/troppi elementi/);
    const ok = importSvg(many, { maxNodes: 61 });
    expect(ok.nodeCount).toBe(61);
  });

  it("il default è 5000 nodi", () => {
    const many = svg(Array.from({ length: 5001 }, () => `<rect width="1" height="1"/>`).join(""));
    expect(() => importSvg(many)).toThrow(/troppi elementi \(oltre 5000\)/);
  });

  it("una bomba di <use> (raddoppio a ogni livello) si ferma, in fretta", () => {
    let defs = `<g id="n0"><rect width="1" height="1"/></g>`;
    for (let i = 1; i <= 20; i++) defs += `<g id="n${i}"><use href="#n${i - 1}"/><use href="#n${i - 1}"/></g>`;
    const t0 = Date.now();
    expect(() => importSvg(svg(`<defs>${defs}</defs><use href="#n20"/>`))).toThrow(/troppi elementi/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("annidamento molto profondo: nessuno stack overflow", () => {
    const depth = 400;
    const nested = "<g>".repeat(depth) + `<rect width="1" height="1"/>` + "</g>".repeat(depth);
    let err: unknown = null;
    try {
      const r = importSvg(svg(`<rect id="shallow" width="2" height="2"/>` + nested));
      expect(r.warnings.join(" ")).toMatch(/annidamento/);
    } catch (e) {
      err = e;
    }
    expect(err === null || err instanceof SvgImportError).toBe(true);
  });

  it("un path enorme è troncato dal tetto sui comandi invece di inchiodare", () => {
    const d = "M0 0" + " l1 1".repeat(250_000);
    const r = importSvg(svg(`<path d="${d}" stroke="red"/>`));
    expect(r.warnings.join(" ")).toMatch(/dati non validi/);
    expect(r.nodeCount).toBe(2);
  });

  it("numeri patologici non producono NaN nel modello", () => {
    const { nodes } = run(svg(`<rect x="1e400" width="5" height="5"/><circle r="Infinity"/><path d="M0 0 L1e308 1e308 L-1e308 5"/>`));
    for (const n of nodes) for (const v of [n.x, n.y, n.width, n.height, n.rotation]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("importSvg: invarianti del modello vettoriale e round trip con l'export", () => {
  it("ogni nodo vettoriale ha la bbox locale (0,0)-(width,height) e il reducer lo accetta", () => {
    const fx = importSvg(fs.readFileSync(path.join(__dirname, "__fixtures__/illustration-nested.svg"), "utf8"), { newId: seq(), parentId: "page1" });
    const s = sceneFrom(fx);
    let vectors = 0;
    for (const n of s.nodes.values()) {
      if (n.kind !== "vector") continue;
      vectors++;
      const b = vectorBounds(n.vector!.subpaths);
      near(b.x, 0, 2); near(b.y, 0, 2);
      near(b.width, n.width, 2); near(b.height, n.height, 2);
    }
    expect(vectors).toBeGreaterThan(5);
  });

  // La geometria in uscita dall'export SVG deve coincidere con quella dello SVG
  // di partenza passato dalla sua matrice: è il test che le convenzioni (maniglie
  // relative, ancoraggi normalizzati, box) sono quelle giuste da entrambe le parti.
  function worldLeaves(r: ImportResult): NodeLite[] {
    const s = sceneFrom(r);
    const out: NodeLite[] = [];
    for (const n of s.nodes.values()) {
      if (n.kind === "group") continue;
      let x = n.x, y = n.y;
      let p = s.nodes.at(n.parentId);
      while (p) { x += p.x; y += p.y; p = s.nodes.at(p.parentId); }
      out.push({ ...n, x, y });
    }
    return out.sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1));
  }

  function samples(cmds: readonly PathCmd[]): [number, number][] {
    const pts: [number, number][] = [];
    let cur: [number, number] = [0, 0], start: [number, number] = [0, 0];
    for (const c of cmds) {
      if (c.t === "M") { cur = start = [c.x, c.y]; pts.push(cur); }
      else if (c.t === "L") {
        for (let i = 1; i <= 24; i++) pts.push([cur[0] + ((c.x - cur[0]) * i) / 24, cur[1] + ((c.y - cur[1]) * i) / 24]);
        cur = [c.x, c.y];
      } else if (c.t === "C") {
        for (let i = 1; i <= 48; i++) {
          const t = i / 48, u = 1 - t;
          pts.push([
            u * u * u * cur[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            u * u * u * cur[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
          ]);
        }
        cur = [c.x, c.y];
      } else {
        for (let i = 1; i <= 24; i++) pts.push([cur[0] + ((start[0] - cur[0]) * i) / 24, cur[1] + ((start[1] - cur[1]) * i) / 24]);
        cur = start;
      }
    }
    return pts;
  }

  // distanza massima fra i punti di A e la SPEZZATA B (e viceversa): la
  // distanza da un punto a un segmento, non al punto campionato più vicino
  // (che dipende dalla densità del campionamento e non dalla geometria).
  function hausdorff(a: [number, number][], b: [number, number][]): number {
    const seg = (p: [number, number], u: [number, number], v: [number, number]) => {
      const dx = v[0] - u[0], dy = v[1] - u[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l2));
      return Math.hypot(p[0] - (u[0] + t * dx), p[1] - (u[1] + t * dy));
    };
    const d = (p: [number, number], q: [number, number][]) => {
      let m = Infinity;
      for (let i = 1; i < q.length; i++) m = Math.min(m, seg(p, q[i - 1], q[i]));
      return m;
    };
    return Math.max(...a.map((p) => d(p, b)), ...b.map((p) => d(p, a)));
  }

  const measureStub = () => 10;

  it("import -> export SVG -> stessa geometria (archi, curve lisce, trasformazioni, gruppi)", () => {
    const d = "M10 10 L50 10 A20 20 0 0 1 70 30 C70 50 50 60 30 60 S10 40 10 30 Q20 20 10 10 Z";
    const tr = "translate(5 8) rotate(20) scale(1.5 1.1) skewX(10)";
    const src = svg(`<g transform="translate(3 4)"><path d="${d}" transform="${tr}" fill="#336699" stroke="#ff0000" stroke-width="2"/></g>`);
    const r = importSvg(src, { newId: seq(), parentId: "page1" });
    const leaves = worldLeaves(r);
    const exported = nodesToSvg(leaves, { x: -100, y: -100, width: 400, height: 400 }, measureStub);
    const paths = [...exported.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBe(1);
    const M = parseTransform(`translate(3 4) ${tr}`).matrix;
    const expected = samples(transformCmds(parsePathData(d).cmds, M));
    const actual = samples(parsePathData(paths[0]).cmds);
    expect(hausdorff(expected, actual)).toBeLessThan(0.01);
    // il tratto e il riempimento arrivano nel file
    expect(exported).toMatch(/stroke="rgb\(255,0,0\)"/);
    expect(exported).toMatch(/fill="rgb\(51,102,153\)"/);
    expect(exported).toMatch(/stroke-width="[0-9.]+"/);
  });

  it("round trip di un cerchio completo fatto di archi: tutti i punti a distanza r dal centro", () => {
    const r = importSvg(svg(`<path d="M20 50 a30 30 0 1 0 60 0 a30 30 0 1 0 -60 0 Z"/>`), { newId: seq(), parentId: "page1" });
    const exported = nodesToSvg(worldLeaves(r), { x: 0, y: 0, width: 100, height: 100 }, measureStub);
    const path = /<path d="([^"]+)"/.exec(exported)![1];
    for (const [x, y] of samples(parsePathData(path).cmds)) near(Math.hypot(x - 50, y - 50), 30, 1);
  });

  it("rect/ellisse/vettoriali con tratto: l'export li riscrive con le proprietà giuste", () => {
    const r = importSvg(svg(
      `<rect x="5" y="5" width="20" height="10" rx="2" fill="none" stroke="#00f" stroke-width="3"/>` +
      `<path d="M0 0L10 10" stroke="#0f0" stroke-linecap="round" stroke-dasharray="4 2"/>`,
    ), { newId: seq(), parentId: "page1" });
    const exported = nodesToSvg(worldLeaves(r), { x: 0, y: 0, width: 100, height: 100 }, measureStub);
    expect(exported).toMatch(/<rect[^>]*rx="2"[^>]*stroke="rgb\(0,0,255\)"[^>]*stroke-width="3"/);
    expect(exported).toMatch(/stroke-linecap="round"/);
    expect(exported).toMatch(/stroke-dasharray="4 2"/);
  });
});

describe("importSvg: le fixture", () => {
  const dir = path.join(__dirname, "__fixtures__");
  const load = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

  it("logo con gradienti", () => {
    const { r, byName, nodes } = run(load("logo-gradient.svg"), { measureText: measureStubFx });
    expect(r.size).toEqual({ width: 240, height: 240 });
    expect(nodes[0].name).toBe("Logo Aurora");
    for (const id of ["sky", "sun", "glow", "wave"]) expect(byName(id).fills.some((f) => f.gradient)).toBe(true);
    expect(byName("wordmark").kind).toBe("text");
    expect(r.warnings).toEqual([]);
  });

  it("icona con tratti e archi", () => {
    const { r, byName } = run(load("icon-strokes-arcs.svg"));
    expect(r.size).toEqual({ width: 240, height: 240 });
    expect(r.warnings).toEqual([]);
    expect(byName("pin").kind).toBe("vector");
    expect(byName("pin").meta?.["stroke.cap"]).toBe("round");
    expect(byName("pin").strokes[0].weight).toBeCloseTo(15, 3); // 1.5 * 10
    expect(byName("orbit").meta?.["stroke.dash"]).toBe("12,16");
    expect(byName("dot").kind).toBe("ellipse");
    // senza raggio e con giunto miter ESPLICITO il rect resta un rect (nessuna conversione)
    expect(byName("frame").kind).toBe("rect");
  });

  it("illustrazione con gruppi annidati, use, classi e trasformazioni", () => {
    const { r, byName, nodes } = run(load("illustration-nested.svg"));
    expect(r.warnings).toEqual([]);
    expect(byName("Nuvola sinistra").kind).toBe("group"); // inkscape:label
    expect(byName("house")).toMatchObject({ kind: "group", x: 40, y: 80 });
    expect(nodes.find((n) => n.parentId === byName("house").id && n.kind === "group" && n.name === "door")).toBeTruthy();
    expect(byName("hidden-stuff").visible).toBe(false);
    expect(byName("ghost").visible).toBe(false);
    expect(byName("ring").meta?.["vector.fillRule"]).toBe("evenodd");
    expect(byName("ring").vector!.subpaths.length).toBe(2);
    // la classe .wall del <style>
    const wall = nodes.find((n) => n.fills[0]?.r !== undefined && n.strokes.length > 0 && n.kind === "rect" && n.parentId === byName("house").id)!;
    near(wall.fills[0].r, 0xf4 / 255, 3);
    // 2 istanze di #star e 2 di #cloud
    expect(nodes.filter((n) => n.name === "star").length).toBe(2);
    expect(nodes.filter((n) => n.kind === "ellipse").length).toBeGreaterThanOrEqual(6);
  });

  it("file ostile: si importa ciò che è lecito, con un avviso per ogni cosa scartata", () => {
    const { r, byName, nodes } = run(load("hostile.svg"));
    expect(nodes.map((n) => n.name)).toEqual(expect.arrayContaining(["victim", "clipped", "dotted", "broken"]));
    expect(byName("victim").cornerRadius).toBe(8);
    for (const w of [
      "<script> rimosso", "<foreignObject> rimosso", "filtro non supportato: ignorato", "clip-path non supportato: ignorato",
      "maschera non supportato: ignorato", "blend mode non supportato: ignorato", "animazione SMIL ignorata",
    ]) expect(r.warnings).toContain(w);
    expect(r.warnings.join(" | ")).toMatch(/pattern non supportato/);
    expect(r.warnings.join(" | ")).toMatch(/riferimento esterno/);
    expect(JSON.stringify(nodes)).not.toMatch(/alert|steal|evil/);
    // il rect di larghezza 0 non è stato creato
    expect(nodes.filter((n) => n.kind === "rect").every((n) => n.width > 0)).toBe(true);
  });
});

function measureStubFx(t: string): number {
  return t.length * 12;
}
