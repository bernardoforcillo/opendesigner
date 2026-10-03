import { describe, it, expect, beforeEach, vi } from "vitest";
import { drawScene } from "./canvasRenderer";
import { drawDash, perimeterOf, vectorDrawSubpaths } from "./animDraw";
import type { Camera } from "../canvas/camera";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { poseScene } from "../animation/pose";
import type { NodeLite, SceneState } from "../store/types";

// Il renderer con una scena DERIVATA dalla riproduzione (animation/pose.ts): scala
// e tratto che si disegna (campi transitori animScale/animDraw), e lo scarto fuori
// vista che non deve far sparire un nodo mentre la sua scala lo porta in vista.

class FakePath2D {
  ops: { op: string; args: unknown[] }[] = [];
  rect(...args: number[]) { this.ops.push({ op: "rect", args }); }
  roundRect(...args: unknown[]) { this.ops.push({ op: "roundRect", args }); }
  ellipse(...args: number[]) { this.ops.push({ op: "ellipse", args }); }
  addPath(p: unknown) { this.ops.push({ op: "addPath", args: [p] }); }
  moveTo(...args: number[]) { this.ops.push({ op: "moveTo", args }); }
  lineTo(...args: number[]) { this.ops.push({ op: "lineTo", args }); }
  bezierCurveTo(...args: number[]) { this.ops.push({ op: "bezierCurveTo", args }); }
  closePath() { this.ops.push({ op: "closePath", args: [] }); }
}

type Call = { op: string; args: unknown[] };
function recordingCtx() {
  const calls: Call[] = [];
  const rec = (op: string) => (...args: unknown[]) => { calls.push({ op, args }); };
  const fills: unknown[] = [];
  const strokes: { path: unknown; dash: number[] }[] = [];
  let dash: number[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1, strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform: () => {}, clearRect: () => {},
    save: rec("save"), restore: rec("restore"), translate: rec("translate"), rotate: rec("rotate"), scale: rec("scale"),
    transform: rec("transform"), clip: () => {},
    setLineDash: (d: number[]) => { dash = d; calls.push({ op: "setLineDash", args: [d] }); },
    fill: (p: unknown) => { fills.push(p); },
    stroke: (p: unknown) => { strokes.push({ path: p, dash }); },
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => {}, strokeText: () => {}, fillRect: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fills, strokes };
}
const CAM = { x: 0, y: 0, zoom: 1 } as Camera;

function node(id: string, parentId: string, x: number, y: number, w: number, h: number, over: Partial<NodeLite> = {}): NodeLite {
  return { ...child(id, parentId, x, y), width: w, height: h, fills: [{ r: 1, g: 0, b: 0, a: 1 }], ...over };
}
function sceneWith(nodes: Record<string, NodeLite>): SceneState {
  return { ...baseScene(), nodes: nodesWith(baseScene().nodes.delete("A").delete("B").delete("C").delete("btn").delete("loose"), nodes) };
}

beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });

describe("scala animata (animScale)", () => {
  it("un nodo scalato si disegna attorno al proprio centro, nello stesso save/restore", () => {
    const s = sceneWith({ r: node("r", "page1", 10, 20, 100, 50) });
    const p = poseScene(s, new Map([["r", { scale: 2 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    const ops = f.calls.map((c) => c.op);
    expect(ops.slice(0, 5)).toEqual(["save", "translate", "rotate", "scale", "translate"]);
    expect(f.calls[1].args).toEqual([60, 45]);
    expect(f.calls[3].args).toEqual([2, 2]);
    expect(f.calls[4].args).toEqual([-60, -45]);
    expect(f.fills).toHaveLength(1);
    // save e restore in pari
    expect(ops.filter((o) => o === "save").length).toBe(ops.filter((o) => o === "restore").length);
  });

  it("una scena ferma NON emette scale (nessun costo in più)", () => {
    const s = sceneWith({ r: node("r", "page1", 10, 20, 100, 50) });
    const f = recordingCtx();
    drawScene(f.ctx, s, CAM);
    expect(f.calls.some((c) => c.op === "scale")).toBe(false);
  });

  it("i figli di un frame scalato scendono con la scala nella matrice", () => {
    const s = sceneWith({
      fr: node("fr", "page1", 0, 0, 200, 100, { kind: "frame", fills: [] }),
      c: node("c", "fr", 10, 10, 20, 20),
    });
    const p = poseScene(s, new Map([["fr", { scale: 3 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    const t = f.calls.find((c) => c.op === "transform")!.args as number[];
    // scala 3 attorno al centro (100,50): a=d=3, e = 100-300 = -200, f = 50-150 = -100
    expect(t).toEqual([3, 0, 0, 3, -200, -100]);
  });
});

describe("scarto fuori vista con scale animate", () => {
  // La vista è 800x600; il rettangolo sta a x 900..1000: fuori. Scala 12 attorno a (950,25) -> copre la vista.
  const outside = () => sceneWith({ r: node("r", "page1", 900, 0, 100, 50) });

  it("fuori vista e fermo: scartato", () => {
    const f = recordingCtx();
    drawScene(f.ctx, outside(), CAM);
    expect(f.fills).toHaveLength(0);
  });

  it("con la scala che lo porta in vista: disegnato (niente scarto per i nodi scalati)", () => {
    const p = poseScene(outside(), new Map([["r", { scale: 12 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.fills).toHaveLength(1);
  });

  it("senza il marcatore la stessa scena verrebbe scartata (il bypass è il marcatore, non altro)", () => {
    const p = poseScene(outside(), new Map([["r", { scale: 12 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, { ...p, anim: undefined }, CAM);
    expect(f.fills).toHaveLength(0);
  });

  it("i discendenti e gli antenati di un nodo scalato non si scartano", () => {
    const s = sceneWith({
      fr: node("fr", "page1", 900, 0, 100, 100, { kind: "frame", fills: [], clipsContent: false }),
      c: node("c", "fr", 0, 0, 50, 50),
      far: node("far", "page1", 5000, 5000, 10, 10), // un fratello lontano e fermo resta scartato
    });
    const p = poseScene(s, new Map([["fr", { scale: 12 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.fills).toHaveLength(1); // il figlio c: nessun riempimento per il frame (senza fills) né per `far`
  });

  it("la scala animata di un nodo dentro un frame tiene vivo anche l'antenato", () => {
    const s = sceneWith({
      fr: node("fr", "page1", 900, 0, 100, 100, { kind: "frame", fills: [{ r: 0, g: 0, b: 1, a: 1 }], clipsContent: false }),
      c: node("c", "fr", 0, 0, 50, 50),
    });
    const p = poseScene(s, new Map([["c", { scale: 40 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    // frame (antenato, non scalato ma con un figlio scalato) e figlio: entrambi disegnati
    expect(f.fills).toHaveLength(2);
  });
});

describe("tratto che si disegna (animDraw)", () => {
  it("rect con tratto: tratteggio = frazione del perimetro, poi ripristinato", () => {
    const s = sceneWith({ r: node("r", "page1", 0, 0, 100, 50, { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] }) });
    const p = poseScene(s, new Map([["r", { draw: 0.25 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.strokes).toHaveLength(1);
    expect(f.strokes[0].dash).toEqual([300 * 0.25, 301]); // perimetro 2*(100+50)
    expect(f.calls.filter((c) => c.op === "setLineDash").map((c) => c.args[0])).toEqual([[75, 301], []]);
  });

  it("draw = 1 non tratteggia", () => {
    const s = sceneWith({ r: node("r", "page1", 0, 0, 100, 50, { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] }) });
    const p = poseScene(s, new Map([["r", { draw: 1 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.calls.some((c) => c.op === "setLineDash")).toBe(false);
  });

  const vec = (draw: number) => {
    const s = sceneWith({
      v: node("v", "page1", 0, 0, 100, 0, {
        kind: "vector",
        vector: { subpaths: [
          { closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] },
          { closed: false, anchors: [{ x: 0, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 50, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 }] },
        ] },
      }),
    });
    return poseScene(s, new Map([["v", { draw }]]));
  };

  it("vettoriale: ogni contorno per la frazione della PROPRIA lunghezza, senza riempimento", () => {
    const f = recordingCtx();
    drawScene(f.ctx, vec(0.5), CAM);
    expect(f.fills).toHaveLength(0);
    expect(f.strokes.map((s) => s.dash.map((n) => Math.round(n)))).toEqual([[50, 101], [25, 51]]);
    expect(f.calls.at(-1)).toBeDefined();
  });

  it("vettoriale a draw = 1: il disegno normale (riempimento e tratto)", () => {
    const f = recordingCtx();
    drawScene(f.ctx, vec(1), CAM);
    expect(f.calls.some((c) => c.op === "setLineDash")).toBe(false);
  });

  it("le misure: perimetri e lunghezze", () => {
    expect(perimeterOf({ kind: "rect", width: 100, height: 50, cornerRadius: 0 })).toBe(300);
    expect(perimeterOf({ kind: "frame", width: 100, height: 50, cornerRadius: 20 })).toBe(300); // il frame è a spigoli vivi
    // un rettangolo stondato è più corto dello spigolo vivo: 300 - 8r + 2πr
    expect(perimeterOf({ kind: "rect", width: 100, height: 50, cornerRadius: 10 })).toBeCloseTo(300 - 80 + 20 * Math.PI, 6);
    // il raggio non supera metà del lato corto: un "pill"
    expect(perimeterOf({ kind: "rect", width: 100, height: 50, cornerRadius: 999 })).toBeCloseTo(300 - 8 * 25 + 50 * Math.PI, 6);
    // cerchio: 2πr
    expect(perimeterOf({ kind: "ellipse", width: 100, height: 100, cornerRadius: 0 })).toBeCloseTo(100 * Math.PI, 6);
    expect(drawDash(200, 0.5)).toEqual([100, 201]);
    expect(drawDash(200, 5)).toEqual([200, 201]); // limitato a 1
    expect(drawDash(200, -1)).toEqual([0, 201]);
    const lens = vectorDrawSubpaths(vec(0.5).nodes.at("v")).map((s) => Math.round(s.length));
    expect(lens).toEqual([100, 50]);
  });
});
