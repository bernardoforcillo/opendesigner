import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { baseScene, child, flowOf, frame, transition, withFlows } from "../flow/testSupport";
import {
  assignRoutesOps, computeReadiness, exportedScreens, normalizeRoute, plannedRoutes, progressOf, setStartsOps,
  slugOf, suggestStart, type ReportLike,
} from "./readiness";

// La checklist è pura: scena + report -> righe. Ogni controllo ha il suo caso
// "a posto" e quello "rotto"; i conteggi dei bloccanti sono quelli che
// l'interfaccia mostra nel badge.

function sceneOf(nodes: NodeLite[], extra: Partial<SceneState> = {}): SceneState {
  return { ...emptyScene("doc", "t"), nodes: nodesOf(Object.fromEntries(nodes.map((n) => [n.id, n]))), ...extra };
}
const routed = (id: string, x: number, route: string, extra: Partial<NodeLite> = {}) =>
  frame(id, x, 0, { meta: { "code.route": route }, ...extra });
function rep(flowId: string, issues: Partial<ReportLike["issues"][number]>[] = []): ReportLike {
  return { flowId, issues: issues.map((i) => ({ kind: "dead_end", nodeId: "", transitionId: "", message: "m", ...i })) };
}
const item = (r: ReturnType<typeof computeReadiness>, id: string) => r.items.find((i) => i.id === id);

describe("slugOf / normalizeRoute", () => {
  it.each([
    ["Login", "login"],
    ["Carrello vuoto", "carrello-vuoto"],
    ["Città nuova!", "citta-nuova"],
    ["  --  ", "screen"],
    ["", "screen"],
    ["Straße 2", "strasse-2"],
    ["日本語", "screen"],
  ])("slugOf(%j) = %j", (name, want) => expect(slugOf(name)).toBe(want));

  it.each([["", ""], ["  ", ""], ["login", "/login"], [" /login ", "/login"], ["/", "/"]])("normalizeRoute(%j) = %j", (a, b) =>
    expect(normalizeRoute(a)).toBe(b));
});

describe("exportedScreens", () => {
  it("prende i frame di primo livello visibili; non i figli, i master, le note né le forme sciolte", () => {
    const s = sceneOf([
      frame("A", 0), frame("B", 400, 0, { visible: false }), frame("M", 800), frame("N", 1200, 0, { meta: { "flow.kind": "note" } }),
      child("btn", "A", 0, 0), child("loose", "page1", 0, 600),
    ], { components: { c1: { rootNodeId: "M", name: "Master" } } });
    expect(exportedScreens(s).map((n) => n.id)).toEqual(["A"]);
  });

  it("include un nodo di primo livello non-frame se un flusso lo referenzia", () => {
    const s = withFlows(sceneOf([frame("A", 0), child("loose", "page1", 0, 600)]), [flowOf("f", "A")], [transition("t", "f", "A", "loose")]);
    expect(exportedScreens(s).map((n) => n.id).sort()).toEqual(["A", "loose"]);
  });
});

describe("plannedRoutes", () => {
  const n = (id: string, name: string, route?: string): NodeLite => frame(id, 0, 0, { name, ...(route ? { meta: { "code.route": route } } : {}) });
  it.each<[string, NodeLite[], Record<string, string>]>([
    ["mancanti: /slug dal nome", [n("a", "Login"), n("b", "Carrello vuoto")], { a: "/login", b: "/carrello-vuoto" }],
    ["le buone non si toccano", [n("a", "Login", "/accedi"), n("b", "Home")], { b: "/home" }],
    ["nomi uguali: suffisso minimo", [n("a", "Login"), n("b", "Login"), n("c", "Login")], { a: "/login", b: "/login-2", c: "/login-3" }],
    ["la prima di un doppione resta, la seconda cambia", [n("a", "Home", "/x"), n("b", "Pagamento", "/x")], { b: "/pagamento" }],
    ["senza slash iniziale conta uguale", [n("a", "A", "x"), n("b", "B", "/x")], { b: "/b" }],
    ["evita le rotte già prese da altre schermate", [n("a", "Home", "/login"), n("b", "Login")], { b: "/login-2" }],
    ["tutto a posto: niente", [n("a", "A", "/a"), n("b", "B", "/b")], {}],
  ])("%s", (_t, nodes, want) => {
    expect(Object.fromEntries(plannedRoutes(nodes))).toEqual(want);
  });
});

describe("computeReadiness", () => {
  it("senza schermate: bloccante, e le altre righe non inventano problemi", () => {
    const r = computeReadiness(emptyScene("d", "t"), {});
    expect(item(r, "screens")).toMatchObject({ state: "fail", blocking: true });
    expect(r.blockers).toBeGreaterThanOrEqual(1);
    expect(r.screens).toEqual([]);
  });

  it("rotte mancanti: una riga per schermata, con 'Assegna le rotte'", () => {
    const r = computeReadiness(baseScene(), null);
    const it_ = item(r, "routes")!;
    expect(it_).toMatchObject({ state: "fail", blocking: true, count: 3 });
    expect(it_.rows.map((x) => x.nodeId)).toEqual(["A", "B", "C"]);
    expect(it_.fix).toEqual({ kind: "assign-routes", label: "Assegna le rotte" });
  });

  it("rotte duplicate: segnalate, stessa correzione; quelle uniche passano", () => {
    const s = sceneOf([routed("A", 0, "/x"), routed("B", 400, "x"), routed("C", 800, "/c")]);
    const r = computeReadiness(s, null);
    expect(item(r, "routes")).toMatchObject({ state: "pass" });
    expect(item(r, "routes-unique")).toMatchObject({ state: "fail", count: 1, fix: { kind: "assign-routes" } });
  });

  it("nessun flusso: bloccante con 'Vai ai Flussi'; con un flusso senza inizio: 'Imposta l'inizio'", () => {
    const base = sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b")]);
    expect(item(computeReadiness(base, null), "flows")).toMatchObject({ state: "fail", fix: { kind: "goto-flows" } });
    const noStart = withFlows(base, [flowOf("f", "")], [transition("t", "f", "A", "B")]);
    expect(item(computeReadiness(noStart, {}), "start")).toMatchObject({ state: "fail", count: 1, fix: { kind: "set-starts" } });
    // un id di inizio che non esiste più vale come "non impostato"
    const ghost = withFlows(base, [flowOf("f", "GONE")], [transition("t", "f", "A", "B")]);
    expect(item(computeReadiness(ghost, {}), "start")?.state).toBe("fail");
    const ok = withFlows(base, [flowOf("f", "A")], [transition("t", "f", "A", "B", { label: "Avanti" })]);
    expect(item(computeReadiness(ok, {}), "start")?.state).toBe("pass");
  });

  it("senza analisi del server i controlli dipendenti sono 'pending' e NON contano come bloccanti", () => {
    const s = withFlows(sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b")]), [flowOf("f", "A")], [transition("t", "f", "A", "B", { label: "x" })]);
    const r = computeReadiness(s, null);
    expect(item(r, "analysis")?.state).toBe("pending");
    expect(r.blockers).toBe(0);
  });

  it("i problemi del server: unreachable/dead_end/ambiguous bloccano, no_exit/empty avvisano", () => {
    const s = withFlows(
      sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b"), routed("C", 800, "/c")]),
      [flowOf("f", "A")],
      [transition("t1", "f", "A", "B", { label: "x" })],
    );
    const r = computeReadiness(s, {
      f: rep("f", [
        { kind: "unreachable", nodeId: "C", message: "C non si raggiunge" },
        { kind: "dead_end", nodeId: "B" },
        { kind: "dead_end", transitionId: "t1" },
        { kind: "no_exit", nodeId: "" },
      ]),
    });
    expect(item(r, "issue:unreachable")).toMatchObject({ state: "fail", blocking: true, count: 1, fix: { kind: "select", nodeId: "C" } });
    expect(item(r, "issue:dead_end")).toMatchObject({ state: "fail", count: 2 });
    // l'arco senza nodo ricade sulla schermata di partenza della transizione
    expect(item(r, "issue:dead_end")!.rows.map((x) => x.nodeId)).toEqual(["B", "A"]);
    expect(item(r, "issue:ambiguous")).toMatchObject({ state: "pass" });
    expect(item(r, "issue:no_exit")).toMatchObject({ state: "warn", blocking: false });
    expect(r.blockers).toBe(3); // 1 irraggiungibile + 2 vicoli ciechi; no_exit non conta
  });

  it("hotspot: serve etichetta, oppure test.id / test.text sull'elemento", () => {
    const base = sceneOf([
      routed("A", 0, "/a"), routed("B", 400, "/b"),
      child("b1", "A", 0, 0), child("b2", "A", 0, 40, { meta: { "test.id": "go" } }), child("b3", "A", 0, 80, { meta: { "test.text": "Avanti" } }),
    ]);
    const mk = (...ts: ReturnType<typeof transition>[]) => computeReadiness(withFlows(base, [flowOf("f", "A")], ts), {});
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b1" })), "hotspots")).toMatchObject({ state: "warn", count: 1, blocking: false });
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b1", label: "Vai" })), "hotspots")?.state).toBe("pass");
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b2" })), "hotspots")?.state).toBe("pass");
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b3" })), "hotspots")?.state).toBe("pass");
    // una transizione senza elemento né etichetta è un bottone senza nome nel nav nascosto
    const bare = item(mk(transition("t", "f", "A", "B")), "hotspots")!;
    expect(bare).toMatchObject({ state: "warn", count: 1 });
    expect(bare.rows[0].nodeId).toBe("A");
  });

  it("un documento tutto a posto: 0 bloccanti", () => {
    const s = withFlows(
      sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b")]),
      [flowOf("f", "A")],
      [transition("t", "f", "A", "B", { label: "Avanti" })],
    );
    const r = computeReadiness(s, { f: rep("f") });
    expect(r.blockers).toBe(0);
    expect(r.items.every((i) => i.state === "pass")).toBe(true);
  });

  it("i bloccanti sono la somma delle entità sbagliate (3 rotte + 1 flusso senza inizio)", () => {
    const s = withFlows(baseScene(), [flowOf("f", "")], [transition("t", "f", "A", "B", { label: "x" })]);
    expect(computeReadiness(s, {}).blockers).toBe(3 + 1);
  });
});

describe("progressOf", () => {
  it("conta gli stati (default: planned)", () => {
    const ns = [frame("a", 0, 0, { meta: { status: "tested" } }), frame("b", 1, 0, { meta: { status: "implemented" } }), frame("c", 2), frame("d", 3, 0, { meta: { status: "boh" } })];
    expect(progressOf(ns)).toEqual({ planned: 2, implemented: 1, tested: 1, total: 4 });
  });
});

describe("suggestStart", () => {
  const s = withFlows(
    sceneOf([frame("A", 0), frame("B", 400), frame("C", 800)]),
    [flowOf("f"), flowOf("loop"), flowOf("empty")],
    [
      transition("t1", "f", "B", "C"), transition("t2", "f", "A", "B"),
      transition("t3", "loop", "B", "C"), transition("t4", "loop", "C", "B"),
    ],
  );
  const screens = exportedScreens(s);
  it("la sorgente che nessuno raggiunge", () => expect(suggestStart(s, s.flows.f, screens)).toBe("A"));
  it("un ciclo: la prima che esce (ordine del documento)", () => expect(suggestStart(s, s.flows.loop, screens)).toBe("B"));
  it("senza transizioni: la prima schermata", () => expect(suggestStart(s, s.flows.empty, screens)).toBe("A"));
  it("senza schermate: vuoto", () => expect(suggestStart(emptyScene("d", "t"), flowOf("x"), [])).toBe(""));
});

describe("ops delle correzioni", () => {
  it("assignRoutesOps: un setProps(meta) per schermata, conserva le altre chiavi, solo le mancanti", () => {
    const s = sceneOf([
      frame("A", 0, 0, { name: "Login", meta: { status: "tested" } }), frame("B", 400, 0, { name: "Home", meta: { "code.route": "/home" } }), frame("C", 800, 0, { name: "Login" }),
    ]);
    const ops = assignRoutesOps(s);
    expect(ops).toHaveLength(2);
    const metas = ops.map((o) => {
      expect(o.kind.case).toBe("setProps");
      const v = o.kind.value as { id: string; patch: { meta: Record<string, string> }; mask: { paths: string[] } };
      expect(v.mask.paths).toEqual(["meta"]);
      return [v.id, v.patch.meta] as const;
    });
    expect(metas).toEqual([["A", { status: "tested", "code.route": "/login" }], ["C", { "code.route": "/login-2" }]]);
    expect(assignRoutesOps(sceneOf([routed("A", 0, "/a")]))).toEqual([]);
  });

  it("setStartsOps: solo i flussi senza inizio", () => {
    const s = withFlows(sceneOf([frame("A", 0), frame("B", 400)]), [flowOf("f1", "A"), flowOf("f2", "")], [transition("t", "f2", "B", "A")]);
    const ops = setStartsOps(s);
    expect(ops).toHaveLength(1);
    const v = ops[0].kind.value as { flow: { id: string; startId: string } };
    expect(ops[0].kind.case).toBe("setFlow");
    expect(v.flow).toMatchObject({ id: "f2", startId: "B" });
  });
});
