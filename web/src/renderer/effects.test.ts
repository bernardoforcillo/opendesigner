import { nodesOf } from "../store/nodeMap";
import { describe, it, expect, vi, afterEach } from "vitest";
import { drawScene, firstBlur, firstShadow } from "./canvasRenderer";
import { emptyScene } from "../store/types";
import type { EffectLite, NodeLite, SceneState } from "../store/types";

class FakePath2D { rect() {} roundRect() {} ellipse() {} }

function rectNode(effects?: EffectLite[], over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "n", parentId: "page1", orderKey: "a0", name: "n", visible: true, opacity: 1,
    x: 0, y: 0, width: 50, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...(effects ? { effects } : {}), ...over,
  };
}

function sceneOf(n: NodeLite): SceneState {
  const s = emptyScene("d", "t");
  return { ...s, nodes: nodesOf({ n }) };
}

// Registra lo stato d'ombra/filtro AL MOMENTO di fill e di stroke, e quanti
// save/restore sono rimasti aperti.
function recCtx(scale = 1) {
  const log: { at: string; shadowBlur: number; shadowColor: string; ox: number; oy: number; filter: string }[] = [];
  let depth = 0;
  const stack: Record<string, unknown>[] = [];
  const ctx: Record<string, unknown> = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", strokeStyle: "",
    lineWidth: 0, globalAlpha: 1, lineCap: "", lineJoin: "",
    shadowBlur: 0, shadowColor: "rgba(0, 0, 0, 0)", shadowOffsetX: 0, shadowOffsetY: 0, filter: "none",
    setTransform: () => {}, clearRect: () => {}, translate: () => {}, rotate: () => {}, transform: () => {},
    getTransform: () => ({ a: scale, b: 0 }),
    measureText: (s: string) => ({ width: s.length * 10 }),
    clip: () => {}, fillText: () => {}, strokeText: () => {},
    save: () => {
      depth++;
      stack.push({ shadowBlur: ctx.shadowBlur, shadowColor: ctx.shadowColor, shadowOffsetX: ctx.shadowOffsetX, shadowOffsetY: ctx.shadowOffsetY, filter: ctx.filter });
    },
    restore: () => { depth--; Object.assign(ctx, stack.pop()); },
  };
  const snap = (at: string) => log.push({
    at, shadowBlur: ctx.shadowBlur as number, shadowColor: ctx.shadowColor as string,
    ox: ctx.shadowOffsetX as number, oy: ctx.shadowOffsetY as number, filter: ctx.filter as string,
  });
  ctx.fill = () => snap("fill");
  ctx.stroke = () => snap("stroke");
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log, depth: () => depth, raw: ctx };
}

const cam = (zoom: number) => ({ x: 0, y: 0, zoom });
const shadow = (over: Partial<Extract<EffectLite, { kind: "dropShadow" }>> = {}): EffectLite => ({
  kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 2, offsetY: 4, blur: 6, ...over,
});

describe("effetti nel canvas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("un'ombra imposta shadow* in unità dispositivo (mondo * zoom)", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx(2); // zoom 2, dpr 1
    drawScene(r.ctx, sceneOf(rectNode([shadow()])), cam(2));
    expect(r.log[0]).toMatchObject({ at: "fill", shadowBlur: 12, ox: 4, oy: 8, shadowColor: "rgba(0, 0, 0, 0.5)" });
  });

  it("la scala viene dalla trasformazione del contesto, quindi include il dpr", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx(3); // es. zoom 1.5 * dpr 2
    drawScene(r.ctx, sceneOf(rectNode([shadow({ blur: 2, offsetX: 1, offsetY: 1 })])), cam(1.5));
    expect(r.log[0]).toMatchObject({ shadowBlur: 6, ox: 3, oy: 3 });
  });

  it("la sfocatura imposta filter blur(px)", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx(2);
    drawScene(r.ctx, sceneOf(rectNode([{ kind: "layerBlur", radius: 5 }])), cam(2));
    expect(r.log[0].filter).toBe("blur(10px)");
  });

  it("senza effetti non c'è nessun save/restore in più e nessuno stato sporco", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    drawScene(r.ctx, sceneOf(rectNode()), cam(1));
    expect(r.log[0]).toMatchObject({ shadowBlur: 0, filter: "none" });
    expect(r.depth()).toBe(0);
  });

  it("gli effetti non traboccano sul nodo successivo", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    const s = emptyScene("d", "t");
    s.nodes = s.nodes.set("a", rectNode([shadow()], { id: "a", orderKey: "a0" }));
    s.nodes = s.nodes.set("b", rectNode(undefined, { id: "b", orderKey: "a1" }));
    drawScene(r.ctx, s, cam(1));
    expect(r.log).toHaveLength(2);
    expect(r.log[0].shadowBlur).toBe(6);
    expect(r.log[1]).toMatchObject({ shadowBlur: 0, filter: "none" });
    expect(r.depth()).toBe(0);
  });

  it("con un riempimento il tratto non rifà l'ombra (niente doppio bordo scuro)", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    const n = rectNode([shadow()], { strokes: [{ color: { r: 1, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] });
    drawScene(r.ctx, sceneOf(n), cam(1));
    const fill = r.log.find((l) => l.at === "fill")!;
    const stroke = r.log.find((l) => l.at === "stroke")!;
    expect(fill.shadowColor).toBe("rgba(0, 0, 0, 0.5)");
    expect(stroke.shadowColor).toBe("transparent");
  });

  it("senza riempimento l'ombra viene dal tratto", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    const n = rectNode([shadow()], { fills: [], strokes: [{ color: { r: 1, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] });
    drawScene(r.ctx, sceneOf(n), cam(1));
    const stroke = r.log.find((l) => l.at === "stroke")!;
    expect(stroke.shadowColor).toBe("rgba(0, 0, 0, 0.5)");
  });
});

describe("firstShadow / firstBlur", () => {
  it("prendono il primo del loro tipo; una sfocatura nulla non conta", () => {
    const n = rectNode([
      { kind: "layerBlur", radius: 0 },
      shadow({ blur: 1 }), shadow({ blur: 9 }),
      { kind: "layerBlur", radius: 4 },
    ]);
    expect(firstShadow(n)).toMatchObject({ blur: 1 });
    expect(firstBlur(n)).toMatchObject({ radius: 4 });
    expect(firstShadow(rectNode())).toBeUndefined();
    expect(firstBlur(rectNode())).toBeUndefined();
  });
});

describe("frame senza riempimento", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("non si riempie (è trasparente); un rettangolo senza riempimento sì", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const frame = recCtx();
    drawScene(frame.ctx, sceneOf(rectNode(undefined, { kind: "frame", fills: [] })), cam(1));
    expect(frame.log.filter((l) => l.at === "fill")).toHaveLength(0);
    const rect = recCtx();
    drawScene(rect.ctx, sceneOf(rectNode(undefined, { fills: [] })), cam(1));
    expect(rect.log.filter((l) => l.at === "fill")).toHaveLength(1);
  });

  it("un frame CON riempimento si riempie", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    drawScene(r.ctx, sceneOf(rectNode(undefined, { kind: "frame" })), cam(1));
    expect(r.log.filter((l) => l.at === "fill")).toHaveLength(1);
  });
});
