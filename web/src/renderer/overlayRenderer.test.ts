import { describe, it, expect } from "vitest";
import {
  drawOverlay,
  selectionFrame,
  selectionWorldBounds,
  worldBoundsToScreen,
  handlePositions,
  HANDLE_SIZE,
  ROTATE_MARKER_OFFSET,
  ROTATE_MARKER_RADIUS,
  rotateMarkerPositions,
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
    x, y, width: w, height: h, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

const identityCam: Camera = { x: 0, y: 0, zoom: 1 };

// La geometria è estratta apposta per essere testabile senza ctx/DOM (non c'è
// jsdom/canvas in questo progetto, vedi renderer/canvasRenderer.test.ts).
describe("selectionWorldBounds", () => {
  it("returns null for an empty selection (nothing to draw)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    expect(selectionWorldBounds(s, [])).toBeNull();
  });

  it("returns null when the selection references ids no longer in the scene", () => {
    const s = emptyScene("d", "n");
    expect(selectionWorldBounds(s, ["ghost"])).toBeNull();
  });

  it("is the union of the bounds of the selected nodes (via unionBounds)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 50, 50));
    s.nodes = s.nodes.set("b", rect("b", 100, 100, 50, 50));
    expect(selectionWorldBounds(s, ["a", "b"])).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("ignores selected ids that no longer exist while keeping the rest", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 50, 50));
    expect(selectionWorldBounds(s, ["a", "ghost"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("puts a nested node's box where the node is drawn: MONDO, not local", () => {
    // page1 > g(100,50) > h(10,20) > k(3,4): il box di "k" nel mondo parte a
    // (113,74). Il bbox della selezione è disegnato in spazio schermo a partire
    // da qui: se restasse locale, la cornice comparirebbe lontanissima dal nodo.
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 100, 50, 400, 400), parentId: "page1" });
    s.nodes = s.nodes.set("h", { ...rect("h", 10, 20, 200, 200), parentId: "g" });
    s.nodes = s.nodes.set("k", { ...rect("k", 3, 4, 50, 50), parentId: "h" });
    expect(selectionWorldBounds(s, ["k"])).toEqual({ x: 113, y: 74, width: 50, height: 50 });
    // Unione di due nodi a profondità DIVERSE: entrambi in coordinate mondo.
    expect(selectionWorldBounds(s, ["g", "k"])).toEqual({ x: 100, y: 50, width: 400, height: 400 });
  });

  // Un gruppo non ha un box proprio: leggerlo darebbe un rettangolo 0x0
  // all'origine, cioè cornice e maniglie nell'angolo sbagliato dello schermo
  // per un gruppo che si vede benissimo (vedi store/groups.ts).
  it("for a group it is the union of its CHILDREN, translated by the group", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("c1", { ...rect("c1", 10, 10, 50, 50), parentId: "g" });
    s.nodes = s.nodes.set("c2", { ...rect("c2", 100, 0, 20, 20), parentId: "g" });
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 10, y: 0, width: 110, height: 60 });

    // Trascinato il gruppo, la cornice lo segue: la sua x/y è la traslazione
    // dei figli.
    s.nodes = s.nodes.set("g", { ...s.nodes.at("g"), x: 5, y: 7 });
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 15, y: 7, width: 110, height: 60 });
  });

  it("skips an empty group instead of framing its origin", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 300, 300, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 50, 50));
    expect(selectionWorldBounds(s, ["g"])).toBeNull();
    expect(selectionWorldBounds(s, ["a", "g"])).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  // Il renderer salta un nodo invisibile e tutto il suo sottoalbero
  // (canvasRenderer.ts): la cornice della selezione deve misurare LA STESSA
  // geometria, o cornice e maniglie si allungano su canvas vuoto -- la
  // divergenza vedi-vs-seleziona, presa dal lato dell'overlay.
  function groupWithHiddenChild() {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("c1", { ...rect("c1", 10, 10, 50, 50), parentId: "g", visible: false });
    s.nodes = s.nodes.set("c2", { ...rect("c2", 100, 0, 20, 20), parentId: "g" });
    return s;
  }

  it("a group frames only its VISIBLE children: a hidden one does not stretch the box", () => {
    const s = groupWithHiddenChild();
    // Con c1 (nascosto) dentro l'unione sarebbe {10,0,110,60}.
    expect(selectionWorldBounds(s, ["g"])).toEqual({ x: 100, y: 0, width: 20, height: 20 });
  });

  it("the 8 handles sit on the visible content, not around empty canvas", () => {
    const s = groupWithHiddenChild();
    const box = worldBoundsToScreen(selectionWorldBounds(s, ["g"])!, identityCam);
    const p = handlePositions(box);
    // Il box visibile è (100,0)-(120,20): ogni maniglia ci sta sopra.
    expect(p.nw).toEqual({ x: 100, y: 0 });
    expect(p.se).toEqual({ x: 120, y: 20 });
    expect(p.n).toEqual({ x: 110, y: 0 });
    expect(p.w).toEqual({ x: 100, y: 10 });
    // Nessuna maniglia sul figlio nascosto (che vive a sinistra, da x=10).
    for (const q of Object.values(p)) expect(q.x).toBeGreaterThanOrEqual(100);
  });

  it("a group whose children are ALL hidden behaves like an empty one: no frame at all", () => {
    const s = groupWithHiddenChild();
    s.nodes = s.nodes.set("c2", { ...s.nodes.at("c2"), visible: false });
    expect(selectionWorldBounds(s, ["g"])).toBeNull();
  });

  // STESSA regola, dal lato del CLIP di un frame: il renderer non disegna (né
  // clicca, né il marquee prende) un figlio oltre il box di un frame con
  // clipsContent. La cornice e le 8 maniglie devono misurare quella stessa
  // geometria, o compaiono -- e diventano AFFERRABILI -- su canvas vuoto fuori
  // dal frame.
  function frameWithOverflowingChild() {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("f", { ...rect("f", 10, 20, 100, 80), kind: "frame", clipsContent: true });
    s.nodes = s.nodes.set("c", { ...rect("c", 5, 5, 500, 500), parentId: "f" }); // mondo (15,25)-(515,525)
    return s;
  }

  it("clips an overflowing child's frame to the visible region inside the frame", () => {
    const s = frameWithOverflowingChild();
    // Solo la parte dentro f (10,20)-(110,100): (15,25)-(110,100).
    expect(selectionWorldBounds(s, ["c"])).toEqual({ x: 15, y: 25, width: 95, height: 75 });
  });

  it("keeps every one of the 8 handles inside the frame box, none on clipped-away canvas", () => {
    const s = frameWithOverflowingChild();
    const box = worldBoundsToScreen(selectionWorldBounds(s, ["c"])!, identityCam);
    const p = handlePositions(box);
    // Il frame arriva a (110,100): nessuna maniglia lo supera.
    for (const q of Object.values(p)) {
      expect(q.x).toBeLessThanOrEqual(110);
      expect(q.y).toBeLessThanOrEqual(100);
    }
    expect(p.se).toEqual({ x: 110, y: 100 });
  });

  it("is null for a child ENTIRELY outside a clipping frame: no frame, no grabbable handles", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("f", { ...rect("f", 0, 0, 100, 100), kind: "frame", clipsContent: true });
    s.nodes = s.nodes.set("c", { ...rect("c", 200, 200, 50, 50), parentId: "f" });
    expect(selectionWorldBounds(s, ["c"])).toBeNull();
  });

  it("does NOT clip when the frame's clipsContent is false: the child is framed whole", () => {
    const s = frameWithOverflowingChild();
    s.nodes = s.nodes.set("f", { ...s.nodes.at("f"), clipsContent: false });
    expect(selectionWorldBounds(s, ["c"])).toEqual({ x: 15, y: 25, width: 500, height: 500 });
  });
});

// Il FRAME della selezione: un nodo solo porta la PROPRIA rotazione (e il suo
// box in coordinate MONDO), una selezione multipla è ASSE-ALLINEATA attorno ai
// box mondo dei nodi. La rotazione dei singoli nodi in una selezione MULTIPLA
// non gonfia più l'unione (il fix clip-aware di T1 su selectionWorldBounds ha
// la precedenza): il caso a un nodo, dove la rotazione conta, lo porta il
// campo `rotation` qui sotto.
describe("selectionFrame", () => {
  it("is null when there is nothing to frame", () => {
    const s = emptyScene("d", "n");
    expect(selectionFrame(s, [])).toBeNull();
    expect(selectionFrame(s, ["ghost"])).toBeNull();
  });

  it("a single node hands over its own bounds and its own rotation", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 10, 20, 100, 50), rotation: 30 });
    expect(selectionFrame(s, ["a"])).toEqual({
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      rotation: 30,
    });
  });

  it("a multiple selection is axis-aligned, around the nodes' world boxes", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 100, 50));
    s.nodes = s.nodes.set("b", rect("b", 100, 100, 50, 50));
    const f = selectionFrame(s, ["a", "b"])!;
    expect(f.rotation).toBe(0);
    expect(f.bounds).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  // Un'istanza, come un gruppo, non ha un box proprio: la sua cornice è quella
  // del contenuto del master (derivata, store/groups.ts), asse-allineata -- non
  // il rettangolo 0x0 all'origine che il suo box grezzo darebbe.
  it("frames a single instance by its derived content bounds, axis-aligned like a group", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("mr", { ...rect("mr", 10, 10, 50, 50), parentId: "components" });
    s.components["comp"] = { rootNodeId: "mr", name: "Comp" };
    s.nodes = s.nodes.set("i", { ...rect("i", 100, 100, 50, 50), kind: "instance", instance: { componentId: "comp", overrides: [] } });
    expect(selectionFrame(s, ["i"])).toEqual({ bounds: { x: 100, y: 100, width: 50, height: 50 }, rotation: 0 });
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
  // Le chiamate di trasformazione con i loro argomenti: servono al caso
  // ruotato, dove ciò che conta non è QUANTE volte si disegna ma ATTORNO A
  // COSA (il centro del riquadro, in px schermo).
  const xform: { op: string; args: number[] }[] = [];
  // Gli archi della maniglia di ROTAZIONE, con centro e raggio: è l'unico
  // disegno dell'overlay che non sia un rettangolo, e ciò che conta è DOVE
  // finisce (dentro la propria zona di presa, vedi selection/handles.test.ts).
  const arcs: { x: number; y: number; r: number }[] = [];
  // I SEGMENTI (moveTo + lineTo): le guide di snap sono l'unico disegno
  // dell'overlay fatto di rette, e ciò che conta è dove cominciano e finiscono.
  const segments: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let pen = { x: 0, y: 0 };
  const record = (op: string) => (...args: number[]) => { calls.push(op); xform.push({ op, args }); };
  const ctx: Record<string, unknown> = {
    canvas: { width, height },
    moveTo: (x: number, y: number) => { calls.push("moveTo"); pen = { x, y }; },
    lineTo: (x: number, y: number) => {
      calls.push("lineTo");
      segments.push({ x0: pen.x, y0: pen.y, x1: x, y1: y });
    },
    setTransform: (..._a: unknown[]) => { calls.push("setTransform"); },
    clearRect: (..._a: unknown[]) => { calls.push("clearRect"); },
    strokeRect: (..._a: unknown[]) => { calls.push("strokeRect"); },
    fillRect: (..._a: unknown[]) => { calls.push("fillRect"); },
    beginPath: () => { calls.push("beginPath"); },
    arc: (x: number, y: number, r: number, ..._a: number[]) => { calls.push("arc"); arcs.push({ x, y, r }); },
    stroke: () => { calls.push("stroke"); },
    save: record("save"),
    restore: record("restore"),
    translate: record("translate"),
    rotate: record("rotate"),
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, xform, arcs, segments };
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
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
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
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(10); // 9 selezione + 1 marquee
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(9); // 8 maniglie + 1 marquee
  });

  it("draws nothing for a group whose children are all hidden: it is an empty group", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("g", { ...rect("g", 0, 0, 0, 0), kind: "group" });
    s.nodes = s.nodes.set("c", { ...rect("c", 10, 10, 50, 50), parentId: "g", visible: false });
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["g"], null);
    expect(calls).not.toContain("strokeRect"); // né cornice né bordi delle maniglie
    expect(calls).not.toContain("fillRect");
  });

  it("HANDLE_SIZE is exported and used to size the handle squares (8px, constant regardless of zoom)", () => {
    expect(HANDLE_SIZE).toBe(8);
  });

  it("turns the whole selection frame -- border AND handles -- with the node's rotation", () => {
    const s = emptyScene("d", "n");
    // box (0,0) 100x50 -> centro schermo (50, 25) a camera identità
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls, xform } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    expect(xform.map((e) => e.op)).toEqual(["save", "translate", "rotate", "translate", "restore"]);
    expect(xform[1].args).toEqual([50, 25]);
    expect(xform[2].args[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(xform[3].args).toEqual([-50, -25]);
    // il riquadro e le 8 maniglie si disegnano come sempre: a ruotare è il
    // contesto, non la loro geometria
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8);
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9);
    // e la trasformazione è chiusa PRIMA di ogni altra cosa
    expect(calls.indexOf("restore")).toBeGreaterThan(calls.lastIndexOf("strokeRect"));
  });

  it("leaves the marquee out of the rotation", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], { x: 200, y: 200, width: 20, height: 20 });
    // le ultime due chiamate di disegno (fill + stroke del marquee) stanno DOPO
    // il restore: il rettangolo di selezione è sempre asse-allineato
    expect(calls.lastIndexOf("fillRect")).toBeGreaterThan(calls.indexOf("restore"));
    expect(calls.lastIndexOf("strokeRect")).toBeGreaterThan(calls.indexOf("restore"));
  });

  // La maniglia di rotazione ESISTE sullo schermo. Prima non si disegnava
  // affatto: il gesto c'era, ma l'unico modo di scoprirlo era passarci sopra
  // col mouse e notare il cursore.
  it("draws a rotate marker just outside each of the 4 corners", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0, 100, 50));
    const { ctx, calls, arcs } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    expect(calls.filter((c) => c === "arc")).toHaveLength(4);
    const d = ROTATE_MARKER_OFFSET;
    const at = (x: number, y: number) => arcs.some((a) => a.x === x && a.y === y && a.r === ROTATE_MARKER_RADIUS);
    expect(at(-d, -d)).toBe(true); // nw
    expect(at(100 + d, -d)).toBe(true); // ne
    expect(at(100 + d, 50 + d)).toBe(true); // se
    expect(at(-d, 50 + d)).toBe(true); // sw
    // e non è un quadratino: i rettangoli disegnati restano quelli di prima
    expect(calls.filter((c) => c === "fillRect")).toHaveLength(8);
    expect(calls.filter((c) => c === "strokeRect")).toHaveLength(9);
  });

  it("puts the markers exactly where rotateMarkerPositions says (one geometry, not two)", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 10, 20, 100, 50));
    const cam: Camera = { x: 7, y: 3, zoom: 2 };
    const { ctx, arcs } = fakeCtx(800, 600);
    drawOverlay(ctx, s, cam, ["a"], null);

    const expected = rotateMarkerPositions(worldBoundsToScreen({ x: 10, y: 20, width: 100, height: 50 }, cam));
    for (const p of Object.values(expected)) {
      expect(arcs.some((a) => a.x === p.x && a.y === p.y)).toBe(true);
    }
  });

  it("turns the markers with the frame, and closes the transform after them", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls, arcs } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);

    // disegnati nello spazio NON ruotato del frame (è il contesto a girare,
    // come per il riquadro e le maniglie)...
    expect(arcs).toHaveLength(4);
    expect(arcs.some((a) => a.x === -ROTATE_MARKER_OFFSET && a.y === -ROTATE_MARKER_OFFSET)).toBe(true);
    // ...e dentro il save/restore, non dopo
    expect(calls.indexOf("restore")).toBeGreaterThan(calls.lastIndexOf("arc"));
  });

  it("emits no transform for an unrotated selection", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, xform } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null);
    expect(xform).toEqual([]);
  });
});

describe("drawOverlay — guide di snap", () => {
  it("draws nothing extra when there is no active snap", () => {
    const s = emptyScene("d", "n");
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, []);
    expect(calls).not.toContain("lineTo");
  });

  it("draws a vertical guide as a segment in SCREEN space", () => {
    const s = emptyScene("d", "n");
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, [{ axis: "x", pos: 100, from: 20, to: 300 }]);
    // +0.5 come il resto dell'overlay: un tratto da 1px cade su un confine
    // netto invece di sbavare su due righe.
    expect(segments).toEqual([{ x0: 100.5, y0: 20, x1: 100.5, y1: 300 }]);
  });

  it("draws a horizontal guide the other way round", () => {
    const s = emptyScene("d", "n");
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, [{ axis: "y", pos: 40, from: 0, to: 200 }]);
    expect(segments).toEqual([{ x0: 0, y0: 40.5, x1: 200, y1: 40.5 }]);
  });

  it("passes through the camera: a zoomed guide lands where the camera puts it", () => {
    const s = emptyScene("d", "n");
    const cam: Camera = { x: 10, y: 5, zoom: 2 };
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, cam, [], null, [{ axis: "x", pos: 100, from: 20, to: 300 }]);
    // worldToScreen: world * zoom + cam
    expect(segments).toEqual([
      { x0: 100 * 2 + 10 + 0.5, y0: 20 * 2 + 5, x1: 100 * 2 + 10 + 0.5, y1: 300 * 2 + 5 },
    ]);
  });

  it("draws the guides OUTSIDE the frame's rotation — they are always axis-aligned", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", { ...rect("a", 0, 0, 100, 50), rotation: 90 });
    const { ctx, calls } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, ["a"], null, [{ axis: "x", pos: 10, from: 0, to: 50 }]);
    // Il segmento cade DOPO il restore del riquadro ruotato: una guida girata
    // di 90° non sarebbe più la retta su cui i bordi combaciano.
    expect(calls.lastIndexOf("lineTo")).toBeGreaterThan(calls.lastIndexOf("restore"));
  });

  it("draws one segment per guide", () => {
    const s = emptyScene("d", "n");
    const { ctx, segments } = fakeCtx(800, 600);
    drawOverlay(ctx, s, identityCam, [], null, [
      { axis: "x", pos: 0, from: 0, to: 10 },
      { axis: "x", pos: 5, from: 0, to: 10 },
      { axis: "y", pos: 7, from: 0, to: 10 },
    ]);
    expect(segments).toHaveLength(3);
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
    drawOverlay(ctx, scene, identityCam, [], null, [], null);
    expect(calls).not.toContain("bezierCurveTo");
    expect(calls).not.toContain("fillRect");
  });

  it("un'anteprima SENZA ancoraggi non disegna niente", () => {
    const { ctx, calls } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({ anchors: [] }));
    expect(calls).not.toContain("beginPath");
    expect(calls).not.toContain("fillRect");
  });

  it("un solo ancoraggio: nessun segmento, solo il suo quadratino", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({ anchors: [corner(10, 10)] }));
    expect(count("bezierCurveTo")).toBe(0); // niente da cui partire
    expect(count("fillRect")).toBe(1);
    expect(count("strokeRect")).toBe(1);
  });

  it("disegna una curva per segmento e un quadratino per ancoraggio", () => {
    const { ctx, count } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
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
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0), corner(50, 0), corner(50, 50)],
      closed: true,
    }));
    // 3 ancoraggi chiusi = 3 segmenti (2 + il ritorno), un solo tratto.
    expect(count("bezierCurveTo")).toBe(3);
    expect(count("stroke")).toBe(1);
  });

  it("il segmento di ritorno è disegnato dalla maniglia ENTRANTE del primo ancoraggio", () => {
    const { ctx, args } = penCtx();
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
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
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0), corner(50, 0)],
      closed: true,
    }));
    expect(count("bezierCurveTo")).toBe(2);
  });

  it("è disegnata in spazio SCHERMO: la camera converte ogni punto di controllo", () => {
    const cam: Camera = { x: 10, y: 20, zoom: 2 };
    const { ctx, args } = penCtx();
    drawOverlay(ctx, scene, cam, [], null, [], preview({
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
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
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
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
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
    drawOverlay(ctx, scene, identityCam, [], null, [], preview({
      anchors: [corner(0, 0)],
      active: 0,
    }));
    expect(count("lineTo")).toBe(0);
    expect(count("arc")).toBe(0);
  });

  it("convive con la selezione e col marquee senza cancellarli", () => {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set("a", rect("a", 0, 0));
    const { ctx, count } = penCtx();
    drawOverlay(ctx, s, identityCam, ["a"], { x: 0, y: 0, width: 10, height: 10 }, [],
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
