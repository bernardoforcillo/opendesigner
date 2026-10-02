import { describe, it, expect } from "vitest";
import { arrowLabel, arrowsInView, flowLayout, hitArrow, LABEL_HIT } from "./layout";
import { baseScene, flowOf, transition, withFlows } from "./testSupport";

const f1 = flowOf("f1", "A");

describe("flowLayout", () => {
  it("una freccia per transizione, fra i bounds mondo delle schermate", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B")]);
    const l = flowLayout(s);
    expect(l.arrows).toHaveLength(1);
    const a = l.byId.get("t1")!;
    // A: x 0..200, B: x 400..600, centri a metà altezza (150)
    expect(a.curve.p0).toEqual({ x: 200, y: 150 });
    expect(a.curve.p3).toEqual({ x: 400, y: 150 });
    expect(a.mid.x).toBeCloseTo(300);
    expect(a.guarded).toBe(false);
    expect(a.hotspot).toBeNull();
  });

  it("l'hotspot fa nascere la freccia dall'elemento, non dalla schermata", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B", { elementId: "btn" })]);
    const a = flowLayout(s).byId.get("t1")!;
    // btn: x 60..140, y 200..230 dentro A
    expect(a.hotspot).toEqual({ x: 60, y: 200, width: 80, height: 30 });
    expect(a.curve.p0).toEqual({ x: 140, y: 215 });
  });

  it("la guardia rende la freccia tratteggiata (guarded)", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B", { guard: "user=guest" })]);
    expect(flowLayout(s).byId.get("t1")!.guarded).toBe(true);
  });

  it("frecce sulla stessa coppia (anche in versi opposti) stanno su corsie diverse", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B"), transition("t2", "f1", "B", "A")]);
    const l = flowLayout(s);
    const a = l.byId.get("t1")!;
    const b = l.byId.get("t2")!;
    expect(a.curve.p0.y).not.toBe(b.curve.p0.y);
    // e le pillole non si sovrappongono nello stesso punto
    expect(a.mid).not.toEqual(b.mid);
  });

  it("transizioni verso nodi spariti non producono frecce", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "ghost")]);
    expect(flowLayout(s).arrows).toHaveLength(0);
  });

  it("è memoizzato su nodi e transizioni: stesso oggetto finché non cambiano", () => {
    const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B")]);
    expect(flowLayout(s)).toBe(flowLayout(s));
    // un cambio che non tocca né nodi né transizioni (es. il nome del flusso) lo riusa
    const renamed = { ...s, flows: { f1: { ...f1, name: "x" } } };
    expect(flowLayout(renamed)).toBe(flowLayout(s));
    const moved = { ...s, nodes: s.nodes.set("B", { ...s.nodes.at("B"), x: 900 }) };
    expect(flowLayout(moved)).not.toBe(flowLayout(s));
  });

  it("senza transizioni restituisce un layout vuoto", () => {
    expect(flowLayout(baseScene()).arrows).toEqual([]);
  });

  it("arrowLabel: l'etichetta, altrimenti l'innesco", () => {
    expect(arrowLabel({ label: " Accedi ", trigger: "click" })).toBe("Accedi");
    expect(arrowLabel({ label: "", trigger: "submit" })).toBe("submit");
  });
});

describe("arrowsInView (culling)", () => {
  const s = withFlows(baseScene(), [f1], [transition("t1", "f1", "A", "B"), transition("t2", "f1", "B", "C")]);
  const l = flowLayout(s);

  it("scarta le frecce fuori vista", () => {
    const view = { x: -50, y: 0, width: 600, height: 300 }; // vede A->B (x 200..400), non B->C (x 600..800)
    expect(arrowsInView(l, view, 0).map((a) => a.id)).toEqual(["t1"]);
    // con un margine abbastanza largo entra anche l'altra
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

  it("colpisce la freccia vicina entro la tolleranza", () => {
    expect(hitArrow(l, 250, 152, 6, pill)?.id).toBe("t1");
    expect(hitArrow(l, 250, 200, 6, pill)).toBeNull();
  });

  it("la pillola dell'etichetta conta come un colpo pieno anche lontano dal tratto", () => {
    // il punto medio è (300,150): 20px sopra è fuori tolleranza ma dentro la pillola (h = 11)
    expect(hitArrow(l, 300, 140, 2, pill)?.id).toBe("t1");
  });

  it("il filtro esclude le frecce di altri flussi", () => {
    expect(hitArrow(l, 700, 150, 6, pill)?.id).toBe("t2");
    expect(hitArrow(l, 700, 150, 6, pill, (a) => a.flowId === "f1")).toBeNull();
  });
});
