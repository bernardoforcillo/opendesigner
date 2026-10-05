import { describe, it, expect, vi, afterEach } from "vitest";
import { drawFlows, drawKindIcon, type FlowOverlayState } from "./flowRenderer";
import { themeColors } from "./themeColors";
import { FLOW_KINDS } from "../flow/meta";
import { baseScene, flowOf, frame, transition, withFlows } from "../flow/testSupport";
import { nodesOf } from "../store/nodeMap";
import type { SceneState } from "../store/types";

// The ctx is a double that counts strokes: jsdom has no real canvas 2D. What is
// drawn is tested (how many arrows, dashing, culling, dpr), not the pixels:
// those are looked at in the browser.

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
  it("draws one curve for every arrow of the current flow", () => {
    const { ctx, raw } = ctxMock();
    drawFlows(ctx, scene(), cam, ui(), "page1");
    // t1, t2 (f1); t3 belongs to f2 and is not shown
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(2);
  });

  it("showAllFlows adds the arrows of the other flows (dimmed)", () => {
    const { ctx, raw } = ctxMock();
    drawFlows(ctx, scene(), cam, ui({ showAllFlows: true }), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(3);
    // the dimmed ones are drawn with reduced alpha, and then it goes back to 1 (save/restore)
    expect(raw.save.mock.calls.length).toBe(raw.restore.mock.calls.length);
  });

  it("the guard dashes the arrow; the others stay solid", () => {
    const { ctx, dashes } = ctxMock();
    drawFlows(ctx, scene(), cam, ui(), "page1");
    expect(dashes.some((d) => d.length > 0)).toBe(true);
    // and the dashing is always restored
    expect(dashes.at(-1)).toEqual([]);
  });

  it("writes the arrows' label (or the trigger), but not below the minimum zoom", () => {
    const a = ctxMock();
    drawFlows(a.ctx, scene(), cam, ui(), "page1");
    expect(a.texts).toContain("Accedi");
    expect(a.texts).toContain("click");
    const b = ctxMock();
    drawFlows(b.ctx, scene(), { x: 0, y: 0, zoom: 0.1 }, ui(), "page1");
    expect(b.texts).not.toContain("Accedi");
  });

  it("culling: an arrow out of view is not drawn", () => {
    const { ctx, raw } = ctxMock(500, 800); // sees x 0..500: only A->B (x 200..400)
    drawFlows(ctx, scene(), { x: 0, y: 0, zoom: 1 }, ui(), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(1);
  });

  it("each screen's badge carries the name (the three screens, not the loose rectangle)", () => {
    const { ctx, texts } = ctxMock(1200, 800);
    drawFlows(ctx, scene(), cam, ui(), "page1");
    for (const n of ["A", "B", "C"]) expect(texts).toContain(n);
    expect(texts).not.toContain("loose");
  });

  it("the route appears next to the badge when there is room", () => {
    const s = scene();
    const withRoute = { ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), meta: { "code.route": "/home" }, width: 400 }) };
    const { ctx, texts } = ctxMock(1200, 800);
    drawFlows(ctx, withRoute, cam, ui(), "page1");
    expect(texts).toContain("/home");
  });

  it("the entry marker is green and only exists with a starting screen", () => {
    const withStart = ctxMock();
    drawFlows(withStart.ctx, scene(), cam, ui({ startId: "A" }), "page1");
    expect(withStart.fills).toContain(themeColors().ok);
    const without = ctxMock();
    drawFlows(without.ctx, scene(), cam, ui({ startId: "" }), "page1");
    // the "planned" status dot is gray, never green: no green fill
    expect(without.fills).not.toContain(themeColors().ok);
  });

  it("the status color follows meta.status (gray / blue / green)", () => {
    const s = scene();
    const tested = { ...s, nodes: s.nodes.set("B", { ...s.nodes.at("B"), meta: { status: "tested" } }) };
    const a = ctxMock();
    drawFlows(a.ctx, tested, cam, ui({ startId: "" }), "page1");
    expect(a.fills).toContain(themeColors().ok);
    expect(a.fills).toContain(themeColors().fgSubtle);
  });

  it("problems: arrow and screen in red", () => {
    const { ctx, raw } = ctxMock();
    const strokes: string[] = [];
    raw.stroke.mockImplementation(function (this: { strokeStyle: string }) { strokes.push(this.strokeStyle); });
    drawFlows(ctx, scene(), cam, ui({ issueNodeIds: new Set(["B"]), issueTransitionIds: new Set(["t1"]) }), "page1");
    expect(strokes).toContain(themeColors().danger);
    // without problems no red
    const clean = ctxMock();
    const s2: string[] = [];
    clean.raw.stroke.mockImplementation(function (this: { strokeStyle: string }) { s2.push(this.strokeStyle); });
    drawFlows(clean.ctx, scene(), cam, ui(), "page1");
    expect(s2).not.toContain(themeColors().danger);
  });

  it("the selected arrow is drawn last, in blue", () => {
    const { ctx, raw } = ctxMock();
    const widths: number[] = [];
    raw.stroke.mockImplementation(function (this: { lineWidth: number }) { widths.push(this.lineWidth); });
    drawFlows(ctx, scene(), cam, ui({ selectedTransitionId: "t1" }), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(2);
    expect(widths).toContain(3);
  });

  it("the hotspot is highlighted with a dashed box", () => {
    const s = scene();
    const hot = { ...s, transitions: { ...s.transitions, t1: { ...s.transitions.t1, elementId: "btn" } } };
    const base = ctxMock();
    drawFlows(base.ctx, scene(), cam, ui(), "page1");
    const withHot = ctxMock();
    drawFlows(withHot.ctx, hot, cam, ui(), "page1");
    expect(withHot.raw.strokeRect.mock.calls.length).toBeGreaterThan(base.raw.strokeRect.mock.calls.length);
  });

  it("the «Connect» rubber band: dashed curve from the starting point to the pointer", () => {
    const { ctx, raw, dashes } = ctxMock();
    drawFlows(ctx, withFlows(baseScene(), [], []), cam, ui({
      flowId: null, startId: "",
      connectPreview: { fromScreenId: "A", elementId: "", fromBounds: { x: 0, y: 0, width: 200, height: 300 }, x: 500, y: 100, targetId: "B" },
    }), "page1");
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(1);
    expect(dashes.some((d) => d.length > 0)).toBe(true);
  });

  it("respects the devicePixelRatio (setTransform scales by the dpr) and the view in CSS px", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { ctx, raw } = ctxMock(2000, 1600); // backing store 2x of a 1000x800 view
    drawFlows(ctx, scene(), cam, ui(), "page1");
    expect(raw.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    // the view is 1000x800 CSS px: A->B and B->C (x up to 800) are inside
    expect(raw.bezierCurveTo).toHaveBeenCalledTimes(2);
  });

  it("scene without flows or arrows: only the badges, no curve", () => {
    const { ctx, raw } = ctxMock();
    drawFlows(ctx, baseScene(), cam, ui({ flowId: null, startId: "" }), "page1");
    expect(raw.bezierCurveTo).not.toHaveBeenCalled();
  });

  it("very low zoom: no badges (illegible) and no exception", () => {
    const { ctx, texts } = ctxMock();
    expect(() => drawFlows(ctx, scene(), { x: 0, y: 0, zoom: 0.03 }, ui(), "page1")).not.toThrow();
    expect(texts).toEqual([]);
  });

  it("large document: with thousands of screens out of view it draws only the visible ones", () => {
    const big: Record<string, ReturnType<typeof frame>> = {};
    for (let i = 0; i < 3000; i++) big[`s${i}`] = frame(`s${i}`, i * 300);
    const s = withFlows({ ...baseScene(), nodes: nodesOf(big) }, [flowOf("f1", "s0")], []);
    const { ctx, texts } = ctxMock(1000, 800);
    drawFlows(ctx, s, cam, ui({ startId: "s0" }), "page1");
    // view 0..1000 (+ margin): at most a handful of badges, not 3000
    expect(texts.length).toBeLessThan(10);
    expect(texts).toContain("s0");
  });
});

describe("drawKindIcon", () => {
  it("draws every type without throwing", () => {
    for (const k of FLOW_KINDS) {
      const { ctx, raw } = ctxMock();
      expect(() => drawKindIcon(ctx, k, 10, 10, 5, themeColors().flow)).not.toThrow();
      expect(raw.save).toHaveBeenCalledTimes(1);
      expect(raw.restore).toHaveBeenCalledTimes(1);
    }
  });
});
