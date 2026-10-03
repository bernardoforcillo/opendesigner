import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { orderKeyBetween } from "../store/orderKey";
import { toPbNode } from "../store/types";
import type { FillLite, FlowLite, NodeLite, StrokeLite, TextStyleLite, TransitionLite } from "../store/types";
import { makeCreateNodeOp, makeSetFlowOp, makeSetTransitionOp } from "../tools/ops";
import { META_KEYS } from "../flow/meta";
import type { FlowKind } from "../flow/meta";

// IL MINI-LINGUAGGIO DEI TEMPLATE. Un template è una funzione che disegna
// schermate con poche primitive (titolo, campo, bottone, scheda...) e produce un
// BuiltTemplate: nodi + flussi + transizioni, PURI DATI. Da lì in poi:
//
//   - `templateOps` li traduce in Op (gli stessi builder dei tool: createNode,
//     setFlow, setTransition) da mandare a un documento appena creato;
//   - `TemplatePreview` li disegna in miniatura nella galleria.
//
// Niente di questo tocca lo store né la rete: si testa applicando gli Op a una
// scena con `applyOp` e verificando l'analisi dei flussi (templates.test.ts).

export const SCREEN_W = 390;
export const SCREEN_H = 844;
/** Spazio fra due schermate affiancate sulla tavola. */
export const SCREEN_GAP = 120;

// La tavolozza dei CONTENUTI (non dell'interfaccia dell'editor): sono i colori
// del disegno che finisce nel documento e nel codice esportato.
export const PALETTE = {
  bg: "#ffffff",
  bgSoft: "#f4f6fa",
  ink: "#111827",
  muted: "#6b7280",
  line: "#d5dae3",
  accent: "#2563eb",
  accentSoft: "#e3ecff",
  ok: "#0f9d6a",
  okSoft: "#dff6ec",
  warn: "#d97706",
  danger: "#dc2626",
  white: "#ffffff",
} as const;

export function hexFill(hex: string): FillLite {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

/** Quello che un template produce: dati, nessun effetto. */
export interface BuiltTemplate {
  nodes: NodeLite[];
  flows: FlowLite[];
  transitions: TransitionLite[];
}

export type IdGen = () => string;

interface TextOpts {
  size?: number; weight?: string; color?: string; align?: "left" | "center" | "right"; name?: string;
  /** Altezza del box: di default una riga. */
  h?: number;
}

export interface BoxOpts {
  fill?: string | null; radius?: number; stroke?: string; name?: string;
  meta?: Record<string, string>;
}

const LINE_H = 1.3;

/**
 * Il costruttore: tiene i nodi in ordine di inserimento (padre prima dei
 * figli, come richiede il server) e dà a ciascuno una order key crescente
 * dentro il proprio parent.
 */
export class DocBuilder {
  readonly nodes: NodeLite[] = [];
  readonly flows: FlowLite[] = [];
  readonly transitions: TransitionLite[] = [];
  private lastKey = new Map<string, string>();

  constructor(readonly pageId: string, readonly newId: IdGen) {}

  built(): BuiltTemplate {
    return { nodes: this.nodes, flows: this.flows, transitions: this.transitions };
  }

  /** Aggiunge un nodo come ULTIMO figlio del parent. */
  add(n: Omit<NodeLite, "orderKey" | "visible" | "opacity" | "rotation" | "strokes" | "cornerRadius" | "clipsContent" | "fills"> & Partial<NodeLite>): NodeLite {
    const key = orderKeyBetween(this.lastKey.get(n.parentId) ?? null, null);
    this.lastKey.set(n.parentId, key);
    const node: NodeLite = {
      visible: true, opacity: 1, rotation: 0, fills: [], strokes: [], cornerRadius: 0, clipsContent: false,
      ...n, orderKey: key,
    };
    this.nodes.push(node);
    return node;
  }

  /** Una schermata: un frame 390x844 figlio della pagina, con rotta e tipo. */
  screen(name: string, col: number, row: number, opts: { route: string; kind?: FlowKind; h?: number; bg?: string; testId?: string }): Screen {
    const meta: Record<string, string> = { [META_KEYS.route]: opts.route, [META_KEYS.status]: "planned" };
    if (opts.kind && opts.kind !== "screen") meta[META_KEYS.kind] = opts.kind;
    if (opts.testId) meta[META_KEYS.testId] = opts.testId;
    const node = this.add({
      id: this.newId(), parentId: this.pageId, name, kind: "frame",
      x: col * (SCREEN_W + SCREEN_GAP), y: row * (SCREEN_H + SCREEN_GAP), width: SCREEN_W, height: opts.h ?? SCREEN_H,
      fills: [hexFill(opts.bg ?? PALETTE.bg)], clipsContent: true, meta,
    });
    return new Screen(this, node);
  }

  flow(name: string, startId: string, description = ""): FlowLite {
    const f: FlowLite = { id: this.newId(), name, description, startId };
    this.flows.push(f);
    return f;
  }

  /** Un arco del flusso: `elementId` è l'hotspot (il bottone) dentro `from`. */
  link(flow: FlowLite, from: string, to: string, o: { label?: string; trigger?: string; elementId?: string; guard?: string; effect?: string } = {}): TransitionLite {
    const t: TransitionLite = {
      id: this.newId(), flowId: flow.id, fromId: from, toId: to, label: o.label ?? "",
      trigger: o.trigger ?? "click", elementId: o.elementId ?? "", guard: o.guard ?? "", effect: o.effect ?? "",
    };
    this.transitions.push(t);
    return t;
  }
}

/** Le primitive di disegno dentro una schermata. Coordinate locali alla schermata. */
export class Screen {
  constructor(private readonly b: DocBuilder, readonly node: NodeLite) {}
  get id(): string { return this.node.id; }
  get w(): number { return this.node.width; }

  text(content: string, x: number, y: number, w: number, o: TextOpts = {}, parentId = this.node.id): NodeLite {
    const size = o.size ?? 15;
    const style: TextStyleLite = { fontFamily: "Inter, sans-serif", fontSize: size, fontWeight: o.weight ?? "400", lineHeight: LINE_H, align: o.align ?? "left" };
    return this.b.add({
      id: this.b.newId(), parentId, name: o.name ?? content.slice(0, 32), kind: "text",
      x, y, width: w, height: o.h ?? Math.ceil(size * LINE_H),
      fills: [hexFill(o.color ?? PALETTE.ink)], text: { content, style },
    });
  }

  /** Un rettangolo o, con `radius`, una scheda/pillola. */
  box(x: number, y: number, w: number, h: number, o: BoxOpts = {}, parentId = this.node.id): NodeLite {
    const strokes: StrokeLite[] = o.stroke ? [{ color: hexFill(o.stroke), weight: 1, align: "inside" }] : [];
    return this.b.add({
      id: this.b.newId(), parentId, name: o.name ?? "Riquadro", kind: "rect", cornerRadius: o.radius ?? 0,
      x, y, width: w, height: h, fills: o.fill === null ? [] : [hexFill(o.fill ?? PALETTE.bgSoft)], strokes, meta: o.meta,
    });
  }

  circle(x: number, y: number, d: number, fill: string, name = "Cerchio"): NodeLite {
    return this.b.add({ id: this.b.newId(), parentId: this.node.id, name, kind: "ellipse", x, y, width: d, height: d, fills: [hexFill(fill)] });
  }

  /**
   * Un frame con auto layout orizzontale e UN figlio testo centrato in
   * verticale: la forma di bottoni, campi e righe. Essere un frame (e non un
   * rettangolo con un testo sopra) rende il codice esportato un vero elemento
   * con dentro il testo, e lo rende l'hotspot giusto per i flussi.
   */
  private pill(name: string, x: number, y: number, w: number, h: number, label: string, o: {
    fill: string | null; stroke?: string; radius: number; color: string; weight?: string; size?: number;
    align: "left" | "center"; padX: number; meta?: Record<string, string>;
  }): NodeLite {
    const size = o.size ?? 15;
    const frame = this.b.add({
      id: this.b.newId(), parentId: this.node.id, name, kind: "frame", cornerRadius: o.radius,
      x, y, width: w, height: h, fills: o.fill ? [hexFill(o.fill)] : [],
      strokes: o.stroke ? [{ color: hexFill(o.stroke), weight: 1, align: "inside" }] : [],
      autoLayout: {
        direction: "horizontal", spacing: 0, paddingLeft: o.padX, paddingRight: o.padX, paddingTop: 0, paddingBottom: 0,
        mainAlign: o.align === "center" ? "center" : "start", crossAlign: "center", hugWidth: false, hugHeight: false,
      },
      meta: o.meta,
    });
    this.text(label, 0, 0, w - 2 * o.padX, { size, weight: o.weight, color: o.color, align: o.align, name: `${name} — testo` }, frame.id);
    return frame;
  }

  /**
   * Un bottone. Ritorna il suo id: è l'`elementId` dell'arco che parte da lì.
   * `testId` finisce in `test.id` (+ `test.text` con l'etichetta) così il
   * Playwright generato lo trova con getByTestId.
   */
  button(label: string, x: number, y: number, w: number, testId: string, variant: "primary" | "secondary" | "link" = "primary", h = 48): string {
    const meta = { [META_KEYS.testId]: testId, [META_KEYS.testText]: label };
    if (variant === "link") {
      // Un link è solo testo: il box è l'hotspot.
      const t = this.text(label, x, y, w, { size: 14, weight: "500", color: PALETTE.accent, align: "center", name: `Link ${label}`, h });
      t.meta = meta;
      return t.id;
    }
    const primary = variant === "primary";
    return this.pill(`Bottone ${label}`, x, y, w, h, label, {
      fill: primary ? PALETTE.accent : PALETTE.white, stroke: primary ? undefined : PALETTE.line, radius: 12,
      color: primary ? PALETTE.white : PALETTE.ink, weight: "600", align: "center", padX: 16, meta,
    }).id;
  }

  /** Un campo di testo con etichetta sopra. Ritorna l'id del campo. */
  input(label: string, placeholder: string, x: number, y: number, w: number, testId: string, h = 48): string {
    this.text(label, x, y, w, { size: 13, weight: "500", color: PALETTE.muted, name: `Etichetta ${label}` });
    return this.pill(`Campo ${label}`, x, y + 22, w, h, placeholder, {
      fill: PALETTE.white, stroke: PALETTE.line, radius: 10, color: PALETTE.muted, align: "left", padX: 14,
      meta: { [META_KEYS.testId]: testId },
    }).id;
  }

  /** Una riga cliccabile (scheda con titolo e sottotitolo). Ritorna il suo id. */
  row(title: string, subtitle: string, x: number, y: number, w: number, testId: string, h = 64): string {
    const frame = this.b.add({
      id: this.b.newId(), parentId: this.node.id, name: `Riga ${title}`, kind: "frame", cornerRadius: 12,
      x, y, width: w, height: h, fills: [hexFill(PALETTE.white)], strokes: [{ color: hexFill(PALETTE.line), weight: 1, align: "inside" }],
      meta: { [META_KEYS.testId]: testId, [META_KEYS.testText]: title },
    });
    this.circle2(frame.id, 14, (h - 36) / 2, 36, PALETTE.accentSoft);
    this.text(title, 64, h / 2 - 20, w - 84, { size: 15, weight: "600", name: `${title} — titolo` }, frame.id);
    this.text(subtitle, 64, h / 2 + 2, w - 84, { size: 13, color: PALETTE.muted, name: `${title} — dettaglio` }, frame.id);
    return frame.id;
  }

  private circle2(parentId: string, x: number, y: number, d: number, fill: string): NodeLite {
    return this.b.add({ id: this.b.newId(), parentId, name: "Icona", kind: "ellipse", x, y, width: d, height: d, fills: [hexFill(fill)] });
  }

  /** Una scheda statistica (etichetta piccola + numero grande). */
  stat(label: string, value: string, x: number, y: number, w: number, h = 84): void {
    const frame = this.b.add({
      id: this.b.newId(), parentId: this.node.id, name: `Statistica ${label}`, kind: "frame", cornerRadius: 12,
      x, y, width: w, height: h, fills: [hexFill(PALETTE.bgSoft)],
    });
    this.text(label, 14, 14, w - 28, { size: 12, color: PALETTE.muted, name: `${label} — etichetta` }, frame.id);
    this.text(value, 14, 36, w - 28, { size: 26, weight: "700", name: `${label} — valore` }, frame.id);
  }

  /** Barra superiore: titolo centrato. */
  header(title: string): void {
    this.box(0, 0, this.w, 96, { fill: PALETTE.white, name: "Barra" });
    this.text(title, 24, 56, this.w - 48, { size: 17, weight: "600", align: "center", name: "Titolo barra" });
    this.box(0, 95, this.w, 1, { fill: PALETTE.line, name: "Filo barra" });
  }

  /** Un segno di spunta in un cerchio: l'illustrazione delle schermate "fatto". */
  badge(cx: number, y: number, d: number, fill: string, glyph: string): void {
    this.circle(cx - d / 2, y, d, fill, "Illustrazione");
    this.text(glyph, cx - d / 2, y + d / 2 - (d * 0.5 * LINE_H) / 2, d, { size: Math.round(d * 0.5), weight: "700", color: PALETTE.white, align: "center", name: "Glifo", h: Math.ceil(d * 0.5 * LINE_H) });
  }
}

/**
 * Gli Op che trasformano un BuiltTemplate in un documento: prima i nodi (il
 * padre precede sempre il figlio), poi i flussi, poi le transizioni (che
 * referenziano nodi e flussi già esistenti). `docId` va stampato su ogni Op:
 * i builder di tools/ops.ts lo leggono dalla scena APERTA, che qui, dalla Home,
 * non c'è.
 */
export function builtToOps(built: BuiltTemplate, docId: string): Op[] {
  const ops: Op[] = [
    ...built.nodes.map((n) => makeCreateNodeOp(toPbNode(n))),
    ...built.flows.map((f) => makeSetFlowOp(f)),
    ...built.transitions.map((t) => makeSetTransitionOp(t)),
  ];
  for (const op of ops) op.docId = docId;
  return ops;
}
