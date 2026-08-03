import { describe, it, expect } from "vitest";
import {
  drawOverlay,
  selectionWorldBounds,
  worldBoundsToScreen,
  handlePositions,
  HANDLE_SIZE,
  PEN_ANCHOR_SIZE,
  PEN_ANCHOR_GRAB_PX,
} from "./overlayRenderer";
import { emptyScene } from "../store/types";
import type { AnchorLite, NodeLite } from "../store/types";
import type { PenPreview } from "../store/vectorGeometry";
import type { Camera } from "../canvas/camera";

function rect(id: string, x: number, y: number, w = 50, h = 50): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: w, height: h, rotation: 0, fills: [], kind: "rect", cornerRadius: 0,
  };
}

const identityCam: Camera = { x: 0, y: 0, zoom: 1 };

// La geometria è estratta apposta per essere testabile senza ctx/DOM (non c'è
// jsdom/canvas in questo progetto, vedi renderer/canvasRenderer.test.ts).
describe("selectionWorldBounds", () => {
  it("returns null for an empty selection (nothing to draw)", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    expect(selectionWorldBounds(s, [])).toBeNull();
  });

  it("returns null when the selection references ids no longer in the scene", () => {
    const s = emptyScene("d", "n");
    expect(selectionWorldBounds(s, ["ghost"])).toBeNull();
  });

  it("is the union of the bounds of the selected nodes (via unionBounds)", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, 50, 50);
    s.nodes["b"] = rect("b", 100, 100, 50, 50);
    expect(selectionWorldBounds(s, ["a", "b"])).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("ignores selected ids that no longer exist while keeping the rest", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, 50, 50);
    expect(selectionWorldBounds(s, ["a", "ghost"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
});

describe("worldBoundsToScreen", () => {
  it("scales and offsets bounds by the camera, matching worldToScreen on both corners", () => {
    const cam: Camera = { x: 10, y: 20, zoom: 2 };
    expect(worldBoundsToScreen({ x: 0, y: 0, width: 50, height: 50 }, cam))
      .toEqual({ x: 10, y: 20, width: 100, height: 100 });
  });

  it("is the identity at zoom 1 / camera at origin", () => {
    expect(worldBoundsToScreen({ x: 5, y: 5, width: 10, height: 10 }, identityCam))
      .toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });
});

describe("handlePositions", () => {
  it("places the 8 handles at the corners and edge midpoints of the box", () => {
    const positions = handlePositions({ x: 0, y: 0, width: 100, height: 50 });
    expect(positions.nw).toEqual({ x: 0, y: 0 });
    expect(positions.n).toEqual({ x: 50, y: 0 });
    expect(positions.ne).toEqual({ x: 100, y: 0 });
    expect(positions.e).toEqual({ x: 100, y: 25 });
    expect(positions.se).toEqual({ x: 100, y: 50 });
    expect(positions.s).toEqual({ x: 50, y: 50 });
    expect(positions.sw).toEqual({ x: 0, y: 50 });
    expect(positions.w).toEqual({ x: 0, y: 25 });
    expect(Object.keys(positions)).toHaveLength(8);
  });
});

// ctx finto che registra solo i NOMI delle chiamate: smoke test per verificare
// che drawOverlay invochi le API canvas attese senza crashare, senza dover
// verificare i pixel esatti (nessun canvas reale in Node qui).
function fakeCtx(width: number, height: number) {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {
    canvas: { width, height },
    setTransform: (..._a: unknown[]) => { calls.push("setTransform"); },
    clearRect: (..._a: unknown[]) => { calls.push("clearRect"); },
    strokeRect: (..._a: unknown[]) => { calls.push("strokeRect"); },
    fillRect: (..._a: unknown[]) => { calls.push("fillRect"); },
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("drawOverlay smoke test", () => {
  it("clears the canvas but draws nothing else when there is no selection and no marquee", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null);
    expect(calls).toContain("clearRect");
    expect(calls).not.toContain("strokeRect");
    expect(calls).not.toContain("fillRect");
  });

  it("draws the bbox border and 8 handle squares when there is a selection", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8); // una per maniglia
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9); // 1 bbox + 8 bordi maniglia
  });

  it("draws nothing for a selection whose ids no longer exist in the scene", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["ghost"], null);
    expect(calls).not.toContain("strokeRect");
    expect(calls).not.toContain("fillRect");
  });

  it("draws the marquee rectangle (fill + stroke) when set, even without a selection", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], { x: 0, y: 0, width: 50, height: 50 });
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(1);
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(1);
  });

  it("draws both the selection bbox/handles and the marquee together", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(10); // 9 selezione + 1 marquee
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(9); // 8 maniglie + 1 marquee
  });

  it("HANDLE_SIZE is exported and used to size the handle squares (8px, constant regardless of zoom)", () => {
    expect(HANDLE_SIZE).toBe(8);
  });
});

// --- il path in corso del PEN TOOL ------------------------------------------

// Come fakeCtx, ma registra anche gli ARGOMENTI: l'anteprima del pen tool è
// fatta di curve, e "ha chiamato bezierCurveTo" non basta a dire che le ha
// disegnate nel posto giusto.
function penCtx() {
  const calls: string[] = [];
  const args: Record<string, unknown[][]> = {};
  const rec = (name: string) => (...a: unknown[]) => {
    calls.push(name);
    (args[name] ??= []).push(a);
  };
  const ctx: Record<string, unknown> = {
    canvas: { width: 800, height: 600 },
    setTransform: rec("setTransform"),
    clearRect: rec("clearRect"),
    strokeRect: rec("strokeRect"),
    fillRect: rec("fillRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    bezierCurveTo: rec("bezierCurveTo"),
    arc: rec("arc"),
    stroke: rec("stroke"),
    fill: rec("fill"),
    setLineDash: rec("setLineDash"),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  const count = (name: string) => calls.filter((c) => c === name).length;
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, args, count };
}

const corner = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const preview = (p: Partial<PenPreview> & Pick<PenPreview, "anchors">): PenPreview => ({
  next: null, active: null, closed: false, ...p,
});

describe("drawOverlay: l'anteprima del pen tool", () => {
  const scene = emptyScene("d", "n");

  it("senza anteprima non disegna nessun path (l'overlay resta quello di M1)", () => {
    const { ctx, calls } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, null);
    expect(calls).not.toContain("bezierCurveTo");
    expect(calls).not.toContain("fillRect");
  });

  it("un'anteprima SENZA ancoraggi non disegna niente", () => {
    const { ctx, calls } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({ anchors: [] }));
    expect(calls).not.toContain("beginPath");
    expect(calls).not.toContain("fillRect");
  });

  it("un solo ancoraggio: nessun segmento, solo il suo quadratino", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({ anchors: [corner(10, 10)] }));
    expect(count("bezierCurveTo")).toBe(0); // niente da cui partire
    expect(count("fillRect")).toBe(1);
    expect(count("strokeRect")).toBe(1);
  });

  it("disegna una curva per segmento e un quadratino per ancoraggio", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [corner(0, 0), corner(50, 0), corner(50, 50)],
    }));
    expect(count("bezierCurveTo")).toBe(2); // 3 ancoraggi = 2 segmenti
    expect(count("stroke")).toBe(1); // un solo tratto per tutto il contorno
    expect(count("fillRect")).toBe(3);
  });

  // Il segmento di ritorno (ultimo -> primo) esiste in anteprima appena il
  // puntatore preme sul primo ancoraggio: è quello che il trascinamento di
  // chiusura sta modellando, e senza disegnarlo l'utente tirerebbe una maniglia
  // di cui non vede la curva.
  it("un'anteprima CHIUSA disegna anche il segmento di ritorno, ultimo -> primo", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [corner(0, 0), corner(50, 0), corner(50, 50)],
      closed: true,
    }));
    // 3 ancoraggi chiusi = 3 segmenti (2 + il ritorno), un solo tratto.
    expect(count("bezierCurveTo")).toBe(3);
    expect(count("stroke")).toBe(1);
  });

  it("il segmento di ritorno è disegnato dalla maniglia ENTRANTE del primo ancoraggio", () => {
    const { ctx, args } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [
        // La entrante del primo è ciò che il trascinamento di chiusura tira.
        { x: 0, y: 0, inX: -20, inY: 10, outX: 0, outY: 0 },
        corner(50, 0),
      ],
      closed: true,
      active: 0,
    }));
    // Ultima curva: c1 = uscente dell'ultimo ancoraggio (nulla, quindi
    // l'ancoraggio stesso), c2 = entrante del PRIMO (-20,10 rispetto a lui),
    // arrivo = il primo ancoraggio.
    expect(args["bezierCurveTo"].at(-1)).toEqual([50, 0, -20, 10, 0, 0]);
  });

  it("due ancoraggi chiusi percorrono A->B->A: il ritorno c'è comunque", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [corner(0, 0), corner(50, 0)],
      closed: true,
    }));
    expect(count("bezierCurveTo")).toBe(2);
  });

  it("è disegnata in spazio SCHERMO: la camera converte ogni punto di controllo", () => {
    const cam: Camera = { x: 10, y: 20, zoom: 2 };
    const { ctx, args } = penCtx();
    drawOverlay(ctx, scene, cam, [], null, preview({
      // Il secondo ancoraggio ha una maniglia entrante: il suo punto di
      // controllo deve passare dalla camera come tutti gli altri.
      anchors: [corner(0, 0), { x: 50, y: 0, inX: -10, inY: 0, outX: 0, outY: 0 }],
    }));
    expect(args["moveTo"][0]).toEqual([10, 20]); // mondo (0,0)
    // c1 = uscente del primo (nulla, quindi l'ancoraggio stesso), c2 =
    // entrante del secondo (mondo 40,0), arrivo = mondo (50,0).
    expect(args["bezierCurveTo"][0]).toEqual([10, 20, 90, 20, 110, 20]);
  });

  it("il segmento PENDENTE segue il cursore ed è tratteggiato", () => {
    const { ctx, count, args } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [corner(0, 0)],
      next: { x: 60, y: 20 },
    }));
    expect(count("bezierCurveTo")).toBe(1);
    // Il punto d'arrivo non ha maniglia: il secondo controllo cade su di lui.
    expect(args["bezierCurveTo"][0]).toEqual([0, 0, 60, 20, 60, 20]);
    // Tratteggio acceso e SPENTO: lasciarlo acceso sporcherebbe il prossimo
    // disegno dell'overlay (i quadratini qui sotto, e il frame successivo).
    expect(args["setLineDash"].map((a) => a[0])).toEqual([[4, 3], []]);
  });

  it("mostra le maniglie del solo ancoraggio ATTIVO, e solo quelle esistenti", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [
        { x: 0, y: 0, inX: -10, inY: 0, outX: 10, outY: 0 },
        { x: 50, y: 0, inX: -5, inY: 0, outX: 5, outY: 0 },
      ],
      active: 0,
    }));
    // Due bastoncini e due pallini per l'ancoraggio 0. Quelle dell'ancoraggio 1
    // NON si disegnano: è geometria già decisa, e mostrarle tutte
    // trasformerebbe l'anteprima in una ragnatela.
    expect(count("lineTo")).toBe(2);
    expect(count("arc")).toBe(2);
    expect(count("fill")).toBe(2);
  });

  it("un ancoraggio attivo d'ANGOLO non disegna maniglie a lunghezza zero", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, preview({
      anchors: [corner(0, 0)],
      active: 0,
    }));
    expect(count("lineTo")).toBe(0);
    expect(count("arc")).toBe(0);
  });

  it("convive con la selezione e col marquee senza cancellarli", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0);
    const { ctx, count } = penCtx();
    drawOverlay(ctx, s, identityCam, ["a"], { x: 0, y: 0, width: 10, height: 10 },
      preview({ anchors: [corner(200, 200)] }));
    // 8 maniglie + 1 marquee + 1 ancoraggio del pen
    expect(count("fillRect")).toBe(10);
    // 1 bbox + 8 bordi maniglia + 1 marquee + 1 ancoraggio del pen
    expect(count("strokeRect")).toBe(11);
  });

  it("le misure dell'ancoraggio sono px SCHERMO e la presa è più generosa del disegno", () => {
    // Stessa relazione delle maniglie di resize (8px disegnati, 6px di raggio
    // di presa): il bersaglio non è mai più piccolo di quello che si vede.
    expect(PEN_ANCHOR_SIZE).toBe(6);
    expect(PEN_ANCHOR_GRAB_PX).toBeGreaterThanOrEqual(PEN_ANCHOR_SIZE / 2);
  });
});
