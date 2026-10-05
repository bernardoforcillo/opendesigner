import { FONT_SIZE, layoutDiagram, textHeight, textWidth, type Layout, type PlacedEdge, type PlacedNode, type Pt } from "./layout";
import { parseMermaid, type Diagram } from "./mermaid";

// Un diagramma disposto -> un documento SVG.
//
// Si passa dall'SVG e non da op scritti a mano perché l'importer (svg/importSvg)
// sa già fare tutto ciò che serve -- forme, vettori, testo, gruppo radice,
// un solo gesto di undo -- e lo stesso SVG si può anche salvare o incollare.
// Il prezzo: i `marker` non sono supportati dall'importer, quindi le punte
// delle frecce sono triangoli veri, non marker.

const INK = "#1f2937";
const NODE_FILL = "#eef2ff";
const NODE_STROKE = "#4f46e5";
const EDGE = "#475569";
const BG = "#ffffff";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (v: number) => String(Math.round(v * 100) / 100 + 0);

function textSvg(label: string, cx: number, cy: number, fill: string): string {
  const rows = label.split("\n");
  const lh = FONT_SIZE * 1.3;
  const top = cy - (rows.length * lh) / 2;
  return rows
    .map((row, i) => `<text x="${n2(cx)}" y="${n2(top + lh * i + lh / 2 + FONT_SIZE * 0.35)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="${FONT_SIZE}" fill="${fill}">${esc(row)}</text>`)
    .join("");
}

function nodeSvg(n: PlacedNode): string {
  const attrs = `fill="${NODE_FILL}" stroke="${NODE_STROKE}" stroke-width="1.5"`;
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  let shape: string;
  switch (n.shape) {
    case "diamond":
      shape = `<path d="M${n2(cx)} ${n2(n.y)} L${n2(n.x + n.width)} ${n2(cy)} L${n2(cx)} ${n2(n.y + n.height)} L${n2(n.x)} ${n2(cy)} Z" ${attrs}/>`;
      break;
    case "circle":
      shape = `<ellipse cx="${n2(cx)}" cy="${n2(cy)}" rx="${n2(n.width / 2)}" ry="${n2(n.height / 2)}" ${attrs}/>`;
      break;
    case "stadium":
      shape = `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.width)}" height="${n2(n.height)}" rx="${n2(n.height / 2)}" ${attrs}/>`;
      break;
    case "round":
      shape = `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.width)}" height="${n2(n.height)}" rx="12" ${attrs}/>`;
      break;
    default:
      shape = `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.width)}" height="${n2(n.height)}" rx="4" ${attrs}/>`;
  }
  return `<g>${shape}${textSvg(n.label, cx, cy, INK)}</g>`;
}

/** Triangolo con la punta in `tip`, rivolto lungo `from -> tip`. */
function arrowHead(tip: Pt, from: Pt, size: number): string {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const wing = (s: number): Pt => ({ x: tip.x - size * Math.cos(a) + s * (size / 2.2) * Math.sin(a), y: tip.y - size * Math.sin(a) - s * (size / 2.2) * Math.cos(a) });
  const l = wing(1);
  const r = wing(-1);
  return `<path d="M${n2(tip.x)} ${n2(tip.y)} L${n2(l.x)} ${n2(l.y)} L${n2(r.x)} ${n2(r.y)} Z" fill="${EDGE}"/>`;
}

function edgeSvg(e: PlacedEdge): string {
  const pts = e.points.map((p) => ({ ...p }));
  const size = e.style === "thick" ? 13 : 10;
  const last = pts.length - 1;
  // La linea si ferma alla base della punta, così non la buca.
  const pull = (end: number, other: number) => {
    const dx = pts[end].x - pts[other].x;
    const dy = pts[end].y - pts[other].y;
    const len = Math.hypot(dx, dy);
    if (len > size) {
      pts[end] = { x: pts[end].x - (dx / len) * (size - 1), y: pts[end].y - (dy / len) * (size - 1) };
    }
  };
  const tipEnd = e.points[last];
  const tipStart = e.points[0];
  if (e.arrowEnd) pull(last, last - 1);
  if (e.arrowStart) pull(0, 1);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${n2(p.x)} ${n2(p.y)}`).join(" ");
  const width = e.style === "thick" ? 3 : 1.5;
  const dash = e.style === "dotted" ? ` stroke-dasharray="2 5" stroke-linecap="round"` : "";
  let svg = `<g><path d="${d}" fill="none" stroke="${EDGE}" stroke-width="${width}"${dash} stroke-linejoin="round"/>`;
  if (e.arrowEnd) svg += arrowHead(tipEnd, e.points[last - 1], size);
  if (e.arrowStart) svg += arrowHead(tipStart, e.points[1], size);
  if (e.label && e.labelAt) {
    const w = textWidth(e.label) + 12;
    const h = textHeight(e.label) + 6;
    svg += `<rect x="${n2(e.labelAt.x - w / 2)}" y="${n2(e.labelAt.y - h / 2)}" width="${n2(w)}" height="${n2(h)}" rx="4" fill="${BG}" stroke="${EDGE}" stroke-opacity="0.35"/>`;
    svg += textSvg(e.label, e.labelAt.x, e.labelAt.y, INK);
  }
  return svg + "</g>";
}

export function layoutToSvg(l: Layout): string {
  const body = [...l.edges.map(edgeSvg), ...l.nodes.map(nodeSvg)].join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(l.width)}" height="${n2(l.height)}" viewBox="0 0 ${n2(l.width)} ${n2(l.height)}">\n${body}\n</svg>`;
}

export function diagramToSvg(d: Diagram): string {
  return layoutToSvg(layoutDiagram(d));
}

/** Testo Mermaid -> SVG pronto per `importSvgAt`. Lancia MermaidError. */
export function mermaidToSvg(source: string): string {
  return diagramToSvg(parseMermaid(source));
}
