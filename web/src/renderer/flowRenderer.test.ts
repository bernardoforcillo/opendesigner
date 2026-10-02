import { describe, it, expect, vi, afterEach } from "vitest";
import { drawFlows, drawKindIcon, FLOW_COLOR, type FlowOverlayState } from "./flowRenderer";
import { FLOW_KINDS } from "../flow/meta";
import { baseScene, flowOf, frame, transition, withFlows } from "../flow/testSupport";
import { nodesOf } from "../store/nodeMap";
import type { SceneState } from "../store/types";

// Il ctx è un doppio che conta i tratti: jsdom non ha un canvas 2D vero. Si
// prova COSA si disegna (quante frecce, tratteggio, culling, dpr), non i pixel:
// quelli si guardano nel browser.

function ctxMock(width = 1000, height = 800) {
  const fills: string[] = [];
  const texts: string[] = [];
  const dashes: number[][] = [];
  const raw = {
    canvas: { width, height },
    setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    bezierCurveTo: vi.fn(), arc: vi.fn(), stroke: vi.fn(), roundRect: vi.fn(),
    fill: vi.fn(function (this: { fillStyle: string }) { fills.push(this.fillStyle); }),
    fillRect: vi.fn(), strokeRect: vi.fn(),
    setLineDash: vi.fn((d: number[]) => dashes.push(d)),
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: vi.fn((t: string) => texts.push(t)),
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, textBaseline: "", textAlign: "", lineCap: "", globalAlpha: 1,
  };
  return { ctx: raw as unknown as CanvasRenderingContext2D, raw, fills, texts, dashes };
}

const cam = { x: 0, y: 0, zoom: 1 };
const noIds: ReadonlySet<string> = new Set();
function ui(over: Partial<FlowOverlayState> = {}): FlowOverlayState {
  return {
    flowId: "f1", startId: "A", showAllFlows: false, selectedTransitionId: null, hoverTransitionId: null,
    connectPreview: null, issueNodeIds: noIds, issueTransitionIds: noIds, ...over,
  };
}
function scene(): SceneState {
  return withFlows(baseScene(), [flowOf("f1", "A"), flowOf("f2")], [
    transition("t1", "f1", "A", "B", { label: "Accedi" }),
    transition("t2", "f1", "B", "C", { guard: "x=1" }),
    transition("t3", "f2", "A", "C"),
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe("drawFlows", () => {
  it("disegna una curva per ogni freccia del flusso corrente", () => {
    const { ctx, raw } = ctxMock();
    drawFlows(ctx, scene(), cam, ui(), "page1");
    // t1, t2 (f1); t3 è di f2 e non si mostra
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(2);
  });

  it("showAllFlows aggiunge le frecce degli altri flussi (attenuate)", () => {
    const { ctx, raw } = ctxMock();
    drawFlows(ctx, scene(), cam, ui({ showAllFlows: true }), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(3);
    // le attenuate si disegnano con alpha ridotta, e poi si torna a 1 (save/restore)
    expect(raw.save.mock.calls.length).toBe(raw.restore.mock.calls.length);
  });

  it("la guardia tratteggia la freccia; le altre restano continue", () => {
    const { ctx, dashes } = ctxMock();
    drawFlows(ctx, scene(), cam, ui(), "page1");
    expect(dashes.some((d) => d.length > 0)).toBe(true);
    // e il tratteggio viene sempre ripristinato
    expect(dashes.at(-1)).toEqual([]);
  });

  it("scrive l'etichetta delle frecce (o l'innesco), ma non sotto lo zoom minimo", () => {
    const a = ctxMock();
    drawFlows(a.ctx, scene(), cam, ui(), "page1");
    expect(a.texts).toContain("Accedi");
    expect(a.texts).toContain("click");
    const b = ctxMock();
    drawFlows(b.ctx, scene(), { x: 0, y: 0, zoom: 0.1 }, ui(), "page1");
    expect(b.texts).not.toContain("Accedi");
  });

  it("culling: una freccia fuori dalla vista non si disegna", () => {
    const { ctx, raw } = ctxMock(500, 800); // vede x 0..500: solo A->B (x 200..400)
    drawFlows(ctx, scene(), { x: 0, y: 0, zoom: 1 }, ui(), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(1);
  });

  it("il badge di ogni schermata porta il nome (le tre schermate, non il rettangolo sciolto)", () => {
    const { ctx, texts } = ctxMock(1200, 800);
    drawFlows(ctx, scene(), cam, ui(), "page1");
    for (const n of ["A", "B", "C"]) expect(texts).toContain(n);
    expect(texts).not.toContain("loose");
  });

  it("la route compare accanto al badge quando c'è spazio", () => {
    const s = scene();
    const withRoute = { ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "code.route": "/home" }, width: 400 }) };
    const { ctx, texts } = ctxMock(1200, 800);
    drawFlows(ctx, withRoute, cam, ui(), "page1");
    expect(texts).toContain("/home");
  });

  it("il marcatore d'ingresso è verde e c'è solo con una schermata di partenza", () => {
    const withStart = ctxMock();
    drawFlows(withStart.ctx, scene(), cam, ui({ startId: "A" }), "page1");
    expect(withStart.fills).toContain("#16a34a");
    const without = ctxMock();
    drawFlows(without.ctx, scene(), cam, ui({ startId: "" }), "page1");
    // il pallino di stato "pianificata" è grigio, mai verde: nessun riempimento verde
    expect(without.fills).not.toContain("#16a34a");
  });

  it("il colore di stato segue meta.status (grigio / blu / verde)", () => {
    const s = scene();
    const tested = { ...s, nodes: s.nodes.set("B", { ...s.nodes.at("B"), meta: { status: "tested" } }) };
    const a = ctxMock();
    drawFlows(a.ctx, tested, cam, ui({ startId: "" }), "page1");
    expect(a.fills).toContain("#16a34a");
    expect(a.fills).toContain("#9ca3af");
  });

  it("i problemi: freccia e schermata in rosso", () => {
    const { ctx, raw } = ctxMock();
    const strokes: string[] = [];
    raw.stroke.mockImplementation(function (this: { strokeStyle: string }) { strokes.push(this.strokeStyle); });
    drawFlows(ctx, scene(), cam, ui({ issueNodeIds: new Set(["B"]), issueTransitionIds: new Set(["t1"]) }), "page1");
    expect(strokes).toContain("#dc2626");
    // senza problemi niente rosso
    const clean = ctxMock();
    const s2: string[] = [];
    clean.raw.stroke.mockImplementation(function (this: { strokeStyle: string }) { s2.push(this.strokeStyle); });
    drawFlows(clean.ctx, scene(), cam, ui(), "page1");
    expect(s2).not.toContain("#dc2626");
  });

  it("la freccia selezionata si disegna per ultima, in blu", () => {
    const { ctx, raw } = ctxMock();
    const widths: number[] = [];
    raw.stroke.mockImplementation(function (this: { lineWidth: number }) { widths.push(this.lineWidth); });
    drawFlows(ctx, scene(), cam, ui({ selectedTransitionId: "t1" }), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(2);
    expect(widths).toContain(3);
  });

  it("l'hotspot si evidenzia con un riquadro tratteggiato", () => {
    const s = scene();
    const hot = { ...s, transitions: { ...s.transitions, t1: { ...s.transitions.t1, elementId: "btn" } } };
    const base = ctxMock();
    drawFlows(base.ctx, scene(), cam, ui(), "page1");
    const withHot = ctxMock();
    drawFlows(withHot.ctx, hot, cam, ui(), "page1");
    expect(withHot.raw.strokeRect.mock.calls.length).toBeGreaterThan(base.raw.strokeRect.mock.calls.length);
  });

  it("il rubber band di «Collega»: curva tratteggiata dal punto di partenza al puntatore", () => {
    const { ctx, raw, dashes } = ctxMock();
    drawFlows(ctx, withFlows(baseScene(), [], []), cam, ui({
      flowId: null, startId: "",
      connectPreview: { fromScreenId: "A", elementId: "", fromBounds: { x: 0, y: 0, width: 200, height: 300 }, x: 500, y: 100, targetId: "B" },
    }), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(1);
    expect(dashes.some((d) => d.length > 0)).toBe(true);
  });

  it("rispetta il devicePixelRatio (setTransform scala del dpr) e la vista in CSS px", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { ctx, raw } = ctxMock(2000, 1600); // backing store 2x di una vista 1000x800
    drawFlows(ctx, scene(), cam, ui(), "page1");
    expect(raw.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    // la vista è 1000x800 CSS px: A->B e B->C (x fino a 800) stanno dentro
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(2);
  });

  it("scena senza flussi né frecce: solo i badge, nessuna curva", () => {
    const { ctx, raw } = ctxMock();
    drawFlows(ctx, baseScene(), cam, ui({ flowId: null, startId: "" }), "page1");
    expect(raw.bezierCurveTo).not.toHaveBeenCalled();
  });

  it("zoom bassissimo: niente badge (illeggibili) e nessuna eccezione", () => {
    const { ctx, texts } = ctxMock();
    expect(() => drawFlows(ctx, scene(), { x: 0, y: 0, zoom: 0.03 }, ui(), "page1")).not.toThrow();
    expect(texts).toEqual([]);
  });

  it("documento grande: con migliaia di schermate fuori vista disegna solo quelle visibili", () => {
    const big: Record<string, ReturnType<typeof frame>> = {};
    for (let i = 0; i < 3000; i++) big[`s${i}`] = frame(`s${i}`, i * 300);
    const s = withFlows({ ...baseScene(), nodes: nodesOf(big) }, [flowOf("f1", "s0")], []);
    const { ctx, texts } = ctxMock(1000, 800);
    drawFlows(ctx, s, cam, ui({ startId: "s0" }), "page1");
    // vista 0..1000 (+ margine): al massimo una manciata di badge, non 3000
    expect(texts.length).toBeLessThan(10);
    expect(texts).toContain("s0");
  });
});

describe("drawKindIcon", () => {
  it("disegna ogni tipo senza lanciare", () => {
    for (const k of FLOW_KINDS) {
      const { ctx, raw } = ctxMock();
      expect(() => drawKindIcon(ctx, k, 10, 10, 5, FLOW_COLOR)).not.toThrow();
      expect(raw.save).toHaveBeenCalledTimes(1);
      expect(raw.restore).toHaveBeenCalledTimes(1);
    }
  });
});
