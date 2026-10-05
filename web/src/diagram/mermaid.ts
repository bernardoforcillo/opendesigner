// Parser di un sottoinsieme di Mermaid: i FLOWCHART (`flowchart`/`graph`).
//
// Perché Mermaid: è il formato in cui un agente AI (o una persona) descrive già
// un diagramma in poche righe, e si incolla da README e issue. Qui ne leggiamo
// solo la parte che il canvas sa disegnare -- nodi con cinque forme, archi con
// tre stili, etichette, direzione -- e di tutto il resto (subgraph, classDef,
// style, click…) ignoriamo la riga invece di rifiutare l'intero diagramma.

export type DiagramDirection = "TD" | "BT" | "LR" | "RL";
export type DiagramShape = "rect" | "round" | "stadium" | "circle" | "diamond";
export type EdgeStyle = "solid" | "dotted" | "thick";

export interface DiagramNode {
  id: string;
  label: string;
  shape: DiagramShape;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
  /** Punta sul lato `to`. */
  arrowEnd: boolean;
  /** Punta sul lato `from` (`<-->`). */
  arrowStart: boolean;
}

export interface Diagram {
  direction: DiagramDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export class MermaidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MermaidError";
  }
}

export const MAX_DIAGRAM_NODES = 200;
export const MAX_DIAGRAM_EDGES = 400;

// Righe che si saltano: Mermaid le accetta, il canvas non ha dove metterle.
const IGNORED = /^(subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title)\b/;

// Delimitatori di forma, dal più lungo: `((` va provato prima di `(`.
const SHAPES: { open: string; close: string; shape: DiagramShape }[] = [
  { open: "(((", close: ")))", shape: "circle" },
  { open: "((", close: "))", shape: "circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "[(", close: ")]", shape: "rect" },
  { open: "[[", close: "]]", shape: "rect" },
  { open: "{{", close: "}}", shape: "diamond" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
  { open: ">", close: "]", shape: "rect" },
];

function unquote(s: string): string {
  let t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  // <br/> è il ritorno a capo di Mermaid; le altre entità HTML restano testo.
  return t.replace(/<br\s*\/?>/gi, "\n").replace(/&quot;/g, '"').trim();
}

interface Cursor {
  s: string;
  i: number;
}

const skipWs = (c: Cursor) => {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++;
};

/** Legge `id` e, se c'è, la forma con la sua etichetta. */
function readNode(c: Cursor): DiagramNode | null {
  skipWs(c);
  const m = /^[A-Za-z0-9_À-￿][\wÀ-￿-]*/.exec(c.s.slice(c.i));
  if (!m) return null;
  // Un identificatore non include un trattino che apre un arco (`A--B`).
  let id = m[0];
  const dash = id.search(/-(?=[-.>=]|$)/);
  if (dash > 0) id = id.slice(0, dash);
  if (dash === 0) return null;
  c.i += id.length;
  for (const sh of SHAPES) {
    if (!c.s.startsWith(sh.open, c.i)) continue;
    // L'etichetta può essere tra virgolette e contenere i delimitatori.
    let j = c.i + sh.open.length;
    let end = -1;
    if (c.s[j] === '"') {
      const q = c.s.indexOf('"', j + 1);
      if (q >= 0 && c.s.startsWith(sh.close, q + 1)) end = q + 1;
    }
    if (end < 0) end = c.s.indexOf(sh.close, j);
    if (end < 0) throw new MermaidError(`forma non chiusa dopo "${id}"`);
    const label = unquote(c.s.slice(j, end));
    c.i = end + sh.close.length;
    return { id, label: label === "" ? id : label, shape: sh.shape };
  }
  return { id, label: id, shape: "rect" };
}

interface EdgeTok {
  style: EdgeStyle;
  arrowEnd: boolean;
  arrowStart: boolean;
  label?: string;
}

const closeKind = (t: string): EdgeTok => ({
  style: t.startsWith("=") ? "thick" : t.includes(".") ? "dotted" : "solid",
  arrowEnd: t.endsWith(">"),
  arrowStart: false,
});

/** Legge un arco (`-->`, `-.->`, `==>`, `---`, `-- testo -->`, `-->|testo|`…). */
function readEdge(c: Cursor): EdgeTok | null {
  skipWs(c);
  const rest = c.s.slice(c.i);
  // Forma con testo in mezzo: `-- sì -->`, `== no ==>`, `-. forse .->`.
  const mid = /^(--|==|-\.)\s+(.+?)\s+(-{2,}>?|={2,}>?|\.+-+>?)(?=\s|$|[A-Za-z0-9_])/.exec(rest);
  if (mid && !/^[-=.]/.test(mid[2])) {
    c.i += mid[0].length;
    return { ...closeKind(mid[3]), label: unquote(mid[2]) };
  }
  const m = /^(<)?(-\.+-|-{2,}|={2,})([>xo])?/.exec(rest);
  if (!m) return null;
  c.i += m[0].length;
  const tok = closeKind(m[2] + (m[3] === ">" ? ">" : ""));
  const out: EdgeTok = { ...tok, arrowEnd: m[3] === ">" || m[3] === "x" || m[3] === "o", arrowStart: m[1] === "<" };
  // Etichetta dopo l'arco: `-->|testo|`.
  if (rest[m[0].length] === "|") {
    const end = c.s.indexOf("|", c.i + 1);
    if (end < 0) throw new MermaidError("etichetta dell'arco non chiusa");
    out.label = unquote(c.s.slice(c.i + 1, end));
    c.i = end + 1;
  }
  return out;
}

export function parseMermaid(source: string): Diagram {
  const text = source.replace(/^﻿/, "");
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  let direction: DiagramDirection = "TD";
  let sawHeader = false;

  const touch = (n: DiagramNode, explicit: boolean) => {
    const prev = nodes.get(n.id);
    // La prima dichiarazione con una forma o un'etichetta vince su un
    // riferimento nudo (`A --> B` poi `B[Fine]`).
    if (!prev) {
      if (nodes.size >= MAX_DIAGRAM_NODES) throw new MermaidError(`troppi nodi (massimo ${MAX_DIAGRAM_NODES})`);
      nodes.set(n.id, n);
    } else if (explicit && (n.shape !== "rect" || n.label !== n.id)) {
      nodes.set(n.id, n);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // `;` separa istruzioni sulla stessa riga, salvo dentro le virgolette.
    const stmts = rawLine.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    for (let stmt of stmts) {
      stmt = stmt.replace(/%%.*$/, "").trim();
      if (stmt === "") continue;
      const head = /^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i.exec(stmt);
      if (head) {
        sawHeader = true;
        const d = (head[2] ?? "TD").toUpperCase();
        direction = d === "TB" ? "TD" : (d as DiagramDirection);
        continue;
      }
      if (/^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline)\b/.test(stmt)) {
        throw new MermaidError("per ora si leggono solo i flowchart (flowchart o graph)");
      }
      if (IGNORED.test(stmt)) continue;

      const cur: Cursor = { s: stmt, i: 0 };
      let prev: DiagramNode[] = [];
      let first = readNode(cur);
      if (!first) throw new MermaidError(`riga non riconosciuta: "${stmt.slice(0, 40)}"`);
      touch(first, true);
      prev = [first];
      for (;;) {
        skipWs(cur);
        if (cur.i >= cur.s.length) break;
        // `A & B --> C`: gruppi di nodi sul lato dell'arco.
        if (cur.s[cur.i] === "&") {
          cur.i++;
          const n = readNode(cur);
          if (!n) throw new MermaidError(`dopo "&" manca un nodo: "${stmt.slice(0, 40)}"`);
          touch(n, true);
          prev.push(n);
          continue;
        }
        const e = readEdge(cur);
        if (!e) throw new MermaidError(`riga non riconosciuta: "${stmt.slice(0, 40)}"`);
        let next = [] as DiagramNode[];
        const n0 = readNode(cur);
        if (!n0) throw new MermaidError(`dopo l'arco manca un nodo: "${stmt.slice(0, 40)}"`);
        touch(n0, true);
        next.push(n0);
        for (;;) {
          skipWs(cur);
          if (cur.s[cur.i] !== "&") break;
          cur.i++;
          const n = readNode(cur);
          if (!n) throw new MermaidError(`dopo "&" manca un nodo: "${stmt.slice(0, 40)}"`);
          touch(n, true);
          next.push(n);
        }
        for (const a of prev) {
          for (const b of next) {
            if (edges.length >= MAX_DIAGRAM_EDGES) throw new MermaidError(`troppi archi (massimo ${MAX_DIAGRAM_EDGES})`);
            edges.push({
              from: a.id, to: b.id, label: e.label === "" ? undefined : e.label,
              style: e.style, arrowEnd: e.arrowEnd, arrowStart: e.arrowStart,
            });
          }
        }
        prev = next;
        first = n0;
      }
    }
  }
  if (nodes.size === 0) throw new MermaidError(sawHeader ? "il diagramma non ha nodi" : "nessun nodo trovato");
  return { direction, nodes: [...nodes.values()], edges };
}
