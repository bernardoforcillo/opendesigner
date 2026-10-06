import { describe, it, expect } from "vitest";
import { arrowLabel, arrowsInView, flowLayout, hitArrow, LABEL_HIT } from "./layout";
import { baseScene, flowOf, transition, withFlows } from "./testSupport";

const f1 = flowOf("f1", "A");

describe("flowLayout", () => {
  it("one arrow per transition, between the screens' world bounds", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B")]);
    const l = flowLayout(s);
    expect(l.arrows).toHaveLength(1);
    const a = l.byId.get("t1")!;
    // A: x 0..200, B: x 400..600, centers at mid height (150)
    expect(a.curve.p0).toEqual({ x: 200, y: 150 });
    expect(a.curve.p3).toEqual({ x: 400, y: 150 });
    expect(a.mid.x).toBeCloseTo(300);
    expect(a.guarded).toBe(false);
    expect(a.hotspot).toBeNull();
  });

  it("the hotspot makes the arrow be born from the element, not from the screen", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B", { elementId: "btn" })]);
    const a = flowLayout(s).byId.get("t1")!;
    // btn: x 60..140, y 200..230 inside A
    expect(a.hotspot).toEqual({ x: 60, y: 200, width: 80, height: 30 });
    expect(a.curve.p0).toEqual({ x: 140, y: 215 });
  });

  it("the guard makes the arrow dashed (guarded)", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B", { guard: "user=guest" })]);
    expect(flowLayout(s).byId.get("t1")!.guarded).toBe(true);
  });

  it("arrows on the same pair (even in opposite directions) sit on different lanes", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B"), transition("t2", "f1", "B", "A")]);
    const l = flowLayout(s);
    const a = l.byId.get("t1")!;
    const b = l.byId.get("t2")!;
    expect(a.curve.p0.y).not.toBe(b.curve.p0.y);
    // and the pills do not overlap at the same point
    expect(a.mid).not.toEqual(b.mid);
  });

  it("transitions to vanished nodes produce no arrows", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "ghost")]);
    expect(flowLayout(s).arrows).toHaveLength(0);
  });

  it("is memoized on nodes and transitions: the same object as long as they do not change", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B")]);
    expect(flowLayout(s)).toBe(flowLayout(s));
    // a change that touches neither nodes nor transitions (e.g. the flow name) reuses it
    const renamed = { ...s, flows: { f1: { ...f1, name: "x" } } };
    expect(flowLayout(renamed)).toBe(flowLayout(s));
    const moved = { ...s, nodes: s.nodes.set("B", { ...s.nodes.at("B"), x: 900 }) };
    expect(flowLayout(moved)).not.toBe(flowLayout(s));
  });

  it("without transitions it returns an empty layout", () => {
    expect(flowLayout(baseScene()).arrows).toEqual([]);
  });

  it("arrowLabel: the label, otherwise the trigger", () => {
    expect(arrowLabel({ label: " Accedi ", trigger: "click" })).toBe("Accedi");
    expect(arrowLabel({ label: "", trigger: "submit" })).toBe("submit");
  });
});

describe("arrowsInView (culling)", () => {
  const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B"), transition("t2", "f1", "B", "C")]);
  const l = flowLayout(s);

  it("discards arrows out of view", () => {
    const view = { x: -50, y: 0, width: 600, height: 300 }; // sees A->B (x 200..400), not B->C (x 600..800)
    expect(arrowsInView(l, view, 0).map((a) => a.id)).toEqual(["t1"]);
    // with a wide enough margin the other one comes in too
    expect(arrowsInView(l, view, 300).map((a) => a.id).sort()).toEqual(["t1", "t2"]);
  });
});

describe("hitArrow", () => {
  const s = withFlows(baseScene(), [f1, flowOf("f2")], [
    transition("t1", "f1", "A", "B"),
    transition("t2", "f2", "B", "C"),
  ]);
  const l = flowLayout(s);
  const pill = { w: LABEL_HIT.w, h: LABEL_HIT.h };

  it("hits the nearby arrow within the tolerance", () => {
    expect(hitArrow(l, 250, 152, 6, pill)?.id).toBe("t1");
    expect(hitArrow(l, 250, 200, 6, pill)).toBeNull();
  });

  it("the label pill counts as a full hit even far from the stroke", () => {
    // the midpoint is (300,150): 20px above is outside the tolerance but inside the pill (h = 11)
    expect(hitArrow(l, 300, 140, 2, pill)?.id).toBe("t1");
  });

  it("the filter excludes the arrows of other flows", () => {
    expect(hitArrow(l, 700, 150, 6, pill)?.id).toBe("t2");
    expect(hitArrow(l, 700, 150, 6, pill, (a) => a.flowId === "f1")).toBeNull();
  });
});
