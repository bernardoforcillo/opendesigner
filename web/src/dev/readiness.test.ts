import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { baseScene, child, flowOf, frame, transition, withFlows } from "../flow/testSupport";
import {
  assignRoutesOps, computeReadiness, exportedScreens, normalizeRoute, plannedRoutes, progressOf, setStartsOps,
  slugOf, suggestStart, type ReportLike,
} from "./readiness";

// The checklist is pure: scene + report -> rows. Every check has its "fine"
// case and its "broken" one; the blocker counts are those the
// interface shows in the badge.

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
    ["Empty cart", "empty-cart"],
    ["Café menu!", "cafe-menu"],
    ["  --  ", "screen"],
    ["", "screen"],
    ["Straße 2", "strasse-2"],
    ["日本語", "screen"],
  ])("slugOf(%j) = %j", (name, want) => expect(slugOf(name)).toBe(want));

  it.each([["", ""], ["  ", ""], ["login", "/login"], [" /login ", "/login"], ["/", "/"]])("normalizeRoute(%j) = %j", (a, b) =>
    expect(normalizeRoute(a)).toBe(b));
});

describe("exportedScreens", () => {
  it("takes the visible top-level frames; not the children, the masters, the notes nor loose shapes", () => {
    const s = sceneOf([
      frame("A", 0), frame("B", 400, 0, { visible: false }), frame("M", 800), frame("N", 1200, 0, { meta: { "flow.kind": "note" } }),
      child("btn", "A", 0, 0), child("loose", "page1", 0, 600),
    ], { components: { c1: { rootNodeId: "M", name: "Master" } } });
    expect(exportedScreens(s).map((n) => n.id)).toEqual(["A"]);
  });

  it("includes a non-frame top-level node if a flow references it", () => {
    const s = withFlows(sceneOf([frame("A", 0), child("loose", "page1", 0, 600)]), [flowOf("f", "A")], [transition("t", "f", "A", "loose")]);
    expect(exportedScreens(s).map((n) => n.id).sort()).toEqual(["A", "loose"]);
  });
});

describe("plannedRoutes", () => {
  const n = (id: string, name: string, route?: string): NodeLite => frame(id, 0, 0, { name, ...(route ? { meta: { "code.route": route } } : {}) });
  it.each<[string, NodeLite[], Record<string, string>]>([
    ["missing: /slug from the name", [n("a", "Login"), n("b", "Empty cart")], { a: "/login", b: "/empty-cart" }],
    ["good ones are left alone", [n("a", "Login", "/sign-in"), n("b", "Home")], { b: "/home" }],
    ["equal names: minimal suffix", [n("a", "Login"), n("b", "Login"), n("c", "Login")], { a: "/login", b: "/login-2", c: "/login-3" }],
    ["the first of a duplicate stays, the second changes", [n("a", "Home", "/x"), n("b", "Payment", "/x")], { b: "/payment" }],
    ["without a leading slash it counts the same", [n("a", "A", "x"), n("b", "B", "/x")], { b: "/b" }],
    ["avoids routes already taken by other screens", [n("a", "Home", "/login"), n("b", "Login")], { b: "/login-2" }],
    ["all fine: nothing", [n("a", "A", "/a"), n("b", "B", "/b")], {}],
  ])("%s", (_t, nodes, want) => {
    expect(Object.fromEntries(plannedRoutes(nodes))).toEqual(want);
  });
});

describe("computeReadiness", () => {
  it("without screens: blocking, and the other rows do not invent problems", () => {
    const r = computeReadiness(emptyScene("d", "t"), {});
    expect(item(r, "screens")).toMatchObject({ state: "fail", blocking: true });
    expect(r.blockers).toBeGreaterThanOrEqual(1);
    expect(r.screens).toEqual([]);
  });

  it("missing routes: one row per screen, with 'Assign routes'", () => {
    const r = computeReadiness(baseScene(), null);
    const it_ = item(r, "routes")!;
    expect(it_).toMatchObject({ state: "fail", blocking: true, count: 3 });
    expect(it_.rows.map((x) => x.nodeId)).toEqual(["A", "B", "C"]);
    expect(it_.fix).toEqual({ kind: "assign-routes", label: "Assign routes" });
  });

  it("duplicate routes: reported, same fix; the unique ones pass", () => {
    const s = sceneOf([routed("A", 0, "/x"), routed("B", 400, "x"), routed("C", 800, "/c")]);
    const r = computeReadiness(s, null);
    expect(item(r, "routes")).toMatchObject({ state: "pass" });
    expect(item(r, "routes-unique")).toMatchObject({ state: "fail", count: 1, fix: { kind: "assign-routes" } });
  });

  it("no flow: blocking with 'Go to Flows'; with a flow without a start: 'Set the start'", () => {
    const base = sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b")]);
    expect(item(computeReadiness(base, null), "flows")).toMatchObject({ state: "fail", fix: { kind: "goto-flows" } });
    const noStart = withFlows(base, [flowOf("f", "")], [transition("t", "f", "A", "B")]);
    expect(item(computeReadiness(noStart, {}), "start")).toMatchObject({ state: "fail", count: 1, fix: { kind: "set-starts" } });
    // a start id that no longer exists counts as "not set"
    const ghost = withFlows(base, [flowOf("f", "GONE")], [transition("t", "f", "A", "B")]);
    expect(item(computeReadiness(ghost, {}), "start")?.state).toBe("fail");
    const ok = withFlows(base, [flowOf("f", "A")], [transition("t", "f", "A", "B", { label: "Avanti" })]);
    expect(item(computeReadiness(ok, {}), "start")?.state).toBe("pass");
  });

  it("without the server analysis the dependent checks are 'pending' and do NOT count as blocking", () => {
    const s = withFlows(sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b")]), [flowOf("f", "A")], [transition("t", "f", "A", "B", { label: "x" })]);
    const r = computeReadiness(s, null);
    expect(item(r, "analysis")?.state).toBe("pending");
    expect(r.blockers).toBe(0);
  });

  it("server issues: unreachable/dead_end/ambiguous block, no_exit/empty warn", () => {
    const s = withFlows(
      sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b"), routed("C", 800, "/c")]),
      [flowOf("f", "A")],
      [transition("t1", "f", "A", "B", { label: "x" })],
    );
    const r = computeReadiness(s, {
      f: rep("f", [
        { kind: "unreachable", nodeId: "C", message: "C is unreachable" },
        { kind: "dead_end", nodeId: "B" },
        { kind: "dead_end", transitionId: "t1" },
        { kind: "no_exit", nodeId: "" },
      ]),
    });
    expect(item(r, "issue:unreachable")).toMatchObject({ state: "fail", blocking: true, count: 1, fix: { kind: "select", nodeId: "C" } });
    expect(item(r, "issue:dead_end")).toMatchObject({ state: "fail", count: 2 });
    // the edge without a node falls back on the transition's starting screen
    expect(item(r, "issue:dead_end")!.rows.map((x) => x.nodeId)).toEqual(["B", "A"]);
    expect(item(r, "issue:ambiguous")).toMatchObject({ state: "pass" });
    expect(item(r, "issue:no_exit")).toMatchObject({ state: "warn", blocking: false });
    expect(r.blockers).toBe(3); // 1 unreachable + 2 dead ends; no_exit does not count
  });

  it("hotspot: a label is needed, or test.id / test.text on the element", () => {
    const base = sceneOf([
      routed("A", 0, "/a"), routed("B", 400, "/b"),
      child("b1", "A", 0, 0), child("b2", "A", 0, 40, { meta: { "test.id": "go" } }), child("b3", "A", 0, 80, { meta: { "test.text": "Avanti" } }),
    ]);
    const mk = (...ts: ReturnType<typeof transition>[]) => computeReadiness(withFlows(base, [flowOf("f", "A")], ts), {});
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b1" })), "hotspots")).toMatchObject({ state: "warn", count: 1, blocking: false });
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b1", label: "Go" })), "hotspots")?.state).toBe("pass");
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b2" })), "hotspots")?.state).toBe("pass");
    expect(item(mk(transition("t", "f", "A", "B", { elementId: "b3" })), "hotspots")?.state).toBe("pass");
    // a transition without an element or label is a nameless button in the hidden nav
    const bare = item(mk(transition("t", "f", "A", "B")), "hotspots")!;
    expect(bare).toMatchObject({ state: "warn", count: 1 });
    expect(bare.rows[0].nodeId).toBe("A");
  });

  it("a fully fine document: 0 blockers", () => {
    const s = withFlows(
      sceneOf([routed("A", 0, "/a"), routed("B", 400, "/b")]),
      [flowOf("f", "A")],
      [transition("t", "f", "A", "B", { label: "Avanti" })],
    );
    const r = computeReadiness(s, { f: rep("f") });
    expect(r.blockers).toBe(0);
    expect(r.items.every((i) => i.state === "pass")).toBe(true);
  });

  it("blockers are the sum of the wrong entities (3 routes + 1 flow without a start)", () => {
    const s = withFlows(baseScene(), [flowOf("f", "")], [transition("t", "f", "A", "B", { label: "x" })]);
    expect(computeReadiness(s, {}).blockers).toBe(3 + 1);
  });
});

describe("progressOf", () => {
  it("counts the states (default: planned)", () => {
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
  it("the source that nobody reaches", () => expect(suggestStart(s, s.flows.f, screens)).toBe("A"));
  it("a cycle: the first that exits (document order)", () => expect(suggestStart(s, s.flows.loop, screens)).toBe("B"));
  it("without transitions: the first screen", () => expect(suggestStart(s, s.flows.empty, screens)).toBe("A"));
  it("without screens: empty", () => expect(suggestStart(emptyScene("d", "t"), flowOf("x"), [])).toBe(""));
});

describe("fix ops", () => {
  it("assignRoutesOps: one setProps(meta) per screen, keeps the other keys, only the missing ones", () => {
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

  it("setStartsOps: only the flows without a start", () => {
    const s = withFlows(sceneOf([frame("A", 0), frame("B", 400)]), [flowOf("f1", "A"), flowOf("f2", "")], [transition("t", "f2", "B", "A")]);
    const ops = setStartsOps(s);
    expect(ops).toHaveLength(1);
    const v = ops[0].kind.value as { flow: { id: string; startId: string } };
    expect(ops[0].kind.case).toBe("setFlow");
    expect(v.flow).toMatchObject({ id: "f2", startId: "B" });
  });
});
