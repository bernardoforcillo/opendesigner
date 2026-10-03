import { describe, it, expect, vi } from "vitest";
import { drawScene } from "./canvasRenderer";
import { hasRealStroke, vectorStyleOf } from "./vectorStyle";
import type { Camera } from "../canvas/camera";
import { emptyScene, type NodeLite } from "../store/types";

// Lo stile extra dei nodi vettoriali (import SVG): capi/giunti/tratteggio e
// regola di riempimento in `meta`, tratto vero da `strokes`.

class FakePath2D {
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  closePath() {}
  rect() {}
  addPath() {}
}

function node(over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "v", parentId: "page1", orderKey: "a0", name: "v", visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "vector", cornerRadius: 0, clipsContent: false,
    vector: {
      subpaths: [{
        closed: true,
        anchors: [
          { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
          { x: 10, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
          { x: 10, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 },
        ],
      }],
    },
    ...over,
  };
}

// Un contesto che registra le assegnazioni alle proprietà e le chiamate.
function recorder() {
  const calls: { fn: string; args: unknown[]; state: Record<string, unknown> }[] = [];
  const state: Record<string, unknown> = {};
  const target = {
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save() {}, restore() {}, translate() {}, rotate() {}, transform() {}, setTransform() {}, clip() {},
    fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    setLineDash(v: number[]) { state.dash = v; calls.push({ fn: "setLineDash", args: [v], state: { ...state } }); },
    fill(...args: unknown[]) { calls.push({ fn: "fill", args, state: { ...state } }); },
    stroke(...args: unknown[]) { calls.push({ fn: "stroke", args, state: { ...state } }); },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  } as Record<string, unknown>;
  const ctx = new Proxy(target, {
    set(t, k, v) { state[String(k)] = v; t[String(k)] = v; return true; },
    get(t, k) { return String(k) in t ? t[String(k)] : () => {}; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function draw(n: NodeLite) {
  vi.stubGlobal("Path2D", FakePath2D);
  try {
    const s = emptyScene("d", "n");
    s.nodes = s.nodes.set(n.id, n);
    const r = recorder();
    drawScene(r.ctx, s, { x: 0, y: 0, zoom: 1 } as Camera);
    return r.calls;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("vectorStyleOf", () => {
  it("senza meta: i default storici (even-odd lo decide il renderer, filo acceso)", () => {
    expect(vectorStyleOf({})).toEqual({
      fillRule: null, hairline: true, cap: "butt", join: "miter", miter: 10, dash: [], dashOffset: 0,
    });
  });
  it("legge tutte le chiavi e ignora i valori sconosciuti", () => {
    expect(vectorStyleOf({
      meta: {
        "vector.fillRule": "nonzero", "vector.hairline": "0", "stroke.cap": "round", "stroke.join": "bevel",
        "stroke.miter": "7", "stroke.dash": "4,2", "stroke.dashOffset": "3",
      },
    })).toEqual({ fillRule: "nonzero", hairline: false, cap: "round", join: "bevel", miter: 7, dash: [4, 2], dashOffset: 3 });
    expect(vectorStyleOf({ meta: { "vector.fillRule": "boh", "stroke.cap": "x", "stroke.join": "y", "stroke.miter": "abc", "stroke.dash": "a,b" } }))
      .toEqual({ fillRule: null, hairline: true, cap: "butt", join: "miter", miter: 10, dash: [], dashOffset: 0 });
  });
  it("un tratteggio di soli zeri non esiste", () => {
    expect(vectorStyleOf({ meta: { "stroke.dash": "0,0" } }).dash).toEqual([]);
  });
  it("hasRealStroke: serve un peso positivo", () => {
    const s = { color: { r: 0, g: 0, b: 0, a: 1 }, align: "center" as const };
    expect(hasRealStroke({ strokes: [] })).toBe(false);
    expect(hasRealStroke({ strokes: [{ ...s, weight: 0 }] })).toBe(false);
    expect(hasRealStroke({ strokes: [{ ...s, weight: 2 }] })).toBe(true);
  });
});

describe("drawVector con stile", () => {
  it("la regola di riempimento viene dai meta (nonzero) e di default è even-odd", () => {
    const a = draw(node()).find((c) => c.fn === "fill")!;
    expect(a.args[1]).toBe("evenodd");
    const b = draw(node({ meta: { "vector.fillRule": "nonzero" } })).find((c) => c.fn === "fill")!;
    expect(b.args[1]).toBe("nonzero");
  });

  it("senza tratto vero il filo da 1.5px resta (il pen tool lo vuole)", () => {
    const strokes = draw(node()).filter((c) => c.fn === "stroke");
    expect(strokes.length).toBe(1);
    expect(strokes[0].state.lineWidth).toBeCloseTo(1.5, 6);
    expect(strokes[0].state.lineCap).toBe("round");
  });

  it("vector.hairline=0 toglie il filo: un path riempito di un SVG non si gonfia", () => {
    expect(draw(node({ meta: { "vector.hairline": "0" } })).filter((c) => c.fn === "stroke")).toEqual([]);
  });

  it("con un tratto vero: peso in unità mondo, colore proprio, capi/giunti/miter/tratteggio dai meta", () => {
    const calls = draw(node({
      strokes: [{ color: { r: 0, g: 0, b: 1, a: 0.5 }, weight: 3, align: "center" }],
      meta: {
        "vector.hairline": "0", "stroke.cap": "round", "stroke.join": "bevel", "stroke.miter": "4",
        "stroke.dash": "6,2", "stroke.dashOffset": "1",
      },
    }));
    const strokes = calls.filter((c) => c.fn === "stroke");
    expect(strokes.length).toBe(1);
    expect(strokes[0].state).toMatchObject({
      lineWidth: 3, lineCap: "round", lineJoin: "bevel", miterLimit: 4, lineDashOffset: 1,
      strokeStyle: "rgba(0, 0, 255, 0.5)",
    });
    expect(strokes[0].state.dash).toEqual([6, 2]);
    // e il tratteggio non resta attivo per il nodo dopo
    expect(calls.filter((c) => c.fn === "setLineDash").pop()!.args[0]).toEqual([]);
  });

  it("il tratto vero NON dipende dallo zoom (è in unità mondo, come il peso di un rect)", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    try {
      const s = emptyScene("d", "n");
      s.nodes = s.nodes.set("v", node({ strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }], meta: { "vector.hairline": "0" } }));
      for (const zoom of [0.5, 1, 4]) {
        const r = recorder();
        drawScene(r.ctx, s, { x: 0, y: 0, zoom } as Camera);
        expect(r.calls.find((c) => c.fn === "stroke")!.state.lineWidth).toBe(2);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("più tratti: uno per tratto, nell'ordine", () => {
    const calls = draw(node({
      strokes: [
        { color: { r: 1, g: 0, b: 0, a: 1 }, weight: 6, align: "center" },
        { color: { r: 0, g: 1, b: 0, a: 1 }, weight: 2, align: "center" },
      ],
    }));
    const strokes = calls.filter((c) => c.fn === "stroke");
    expect(strokes.map((c) => c.state.lineWidth)).toEqual([6, 2]);
  });
});
