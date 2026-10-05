import { describe, expect, it } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { topLevelScreens } from "../flow/screens";
import { META_KEYS } from "../flow/meta";
import { TEMPLATES, templateById, templateOps } from "./catalog";
import type { Template } from "./catalog";
import { PALETTE, hexFill } from "./builder";

// A deterministic id generator: the tests do not depend on chance.
function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

function apply(t: Template): SceneState {
  const ops = templateOps(t, "doc", "page1", ids());
  return ops.reduce((s, op) => applyOp(s, op), emptyScene("doc", t.docName));
}

// Port of the server's analysis (internal/flow/analyze.go) restricted to the only problems
// a template must NOT have: no entry, unreachable screens,
// dead ends, ambiguous edges. Verification against the real server is in the
// browser verification script; here the contract is kept in unit tests.
function issuesOf(scene: SceneState, flowId: string): string[] {
  const flow = scene.flows[flowId];
  const trs = Object.values(scene.transitions).filter((t) => t.flowId === flowId);
  const out: string[] = [];
  if (trs.length === 0) return ["empty"];
  if (!flow.startId) return ["no_start"];
  const screens = new Set<string>();
  for (const t of trs) { screens.add(t.fromId); screens.add(t.toId); }
  const reach = new Set([flow.startId]);
  const stack = [flow.startId];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const t of trs.filter((x) => x.fromId === n)) if (!reach.has(t.toId)) { reach.add(t.toId); stack.push(t.toId); }
  }
  for (const s of screens) {
    if (!reach.has(s)) out.push(`unreachable:${scene.nodes.at(s)?.name}`);
    else if (!trs.some((t) => t.fromId === s) && scene.nodes.at(s)?.meta?.[META_KEYS.kind] !== "end") out.push(`dead_end:${scene.nodes.at(s)?.name}`);
  }
  const seen = new Set<string>();
  for (const t of trs) {
    const k = [t.fromId, t.trigger, t.elementId, t.guard].join("|");
    if (seen.has(k)) out.push(`ambiguous:${t.label}`);
    seen.add(k);
  }
  return out;
}

function isInside(scene: SceneState, id: string, ancestor: string): boolean {
  for (let cur = scene.nodes.at(id); cur; cur = scene.nodes.at(cur.parentId)) if (cur.id === ancestor) return true;
  return false;
}

describe("template catalog", () => {
  it("has at least Blank, Onboarding, Login, Checkout and SaaS Dashboard, with unique ids", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["blank", "onboarding", "auth", "checkout", "saas"]);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(templateById("auth")?.name).toBe("Login and sign-up");
    expect(templateById("nope")).toBeUndefined();
  });

  it("Blank produces no Op", () => {
    expect(templateOps(templateById("blank")!, "doc", "page1")).toEqual([]);
  });

  const expected: Record<string, { screens: number; flows: number }> = {
    onboarding: { screens: 3, flows: 1 },
    auth: { screens: 4, flows: 1 },
    checkout: { screens: 5, flows: 1 },
    saas: { screens: 3, flows: 1 },
  };

  for (const t of TEMPLATES.filter((x) => x.id !== "blank")) {
    describe(t.name, () => {
      const scene = apply(t);

      it("applied with applyOp gives the expected screens and flows", () => {
        const screens = topLevelScreens(scene, "page1");
        expect(screens).toHaveLength(expected[t.id].screens);
        expect(Object.keys(scene.flows)).toHaveLength(expected[t.id].flows);
        expect(Object.keys(scene.transitions).length).toBeGreaterThanOrEqual(expected[t.id].screens - 1);
      });

      it("mobile screens 390 wide, side by side without overlapping", () => {
        const screens = topLevelScreens(scene, "page1").slice().sort((a, b) => a.x - b.x);
        for (const s of screens) expect(s.width).toBe(390);
        for (let i = 1; i < screens.length; i++) expect(screens[i].x).toBeGreaterThanOrEqual(screens[i - 1].x + screens[i - 1].width);
      });

      it("flow analysis finds no missing entries, unreachable screens, dead ends or ambiguous edges", () => {
        for (const f of Object.values(scene.flows)) expect(issuesOf(scene, f.id)).toEqual([]);
      });

      it("every screen declares its route (code.route), and the routes are distinct", () => {
        const routes = topLevelScreens(scene, "page1").map((s) => s.meta?.[META_KEYS.route]);
        expect(routes.every((r) => !!r && r!.startsWith("/"))).toBe(true);
        expect(new Set(routes).size).toBe(routes.length);
      });

      it("every hotspot sits INSIDE the starting screen and has test.id (or test.text) for Playwright", () => {
        for (const tr of Object.values(scene.transitions)) {
          if (!tr.elementId) continue;
          expect(isInside(scene, tr.elementId, tr.fromId)).toBe(true);
          const m = scene.nodes.at(tr.elementId)!.meta ?? {};
          expect(m[META_KEYS.testId] || m[META_KEYS.testText]).toBeTruthy();
        }
      });

      it("test.ids are unique in the document", () => {
        const all: string[] = [];
        for (const n of scene.nodes.values()) if (n.meta?.[META_KEYS.testId]) all.push(n.meta[META_KEYS.testId]);
        expect(new Set(all).size).toBe(all.length);
      });

      it("children sit within the screen's box and have no null dimensions", () => {
        const screens = topLevelScreens(scene, "page1");
        for (const s of screens) {
          const walk = (parent: NodeLite) => {
            for (const c of scene.nodes.values()) {
              if (c.parentId !== parent.id) continue;
              expect(c.width, `${c.name} width`).toBeGreaterThan(0);
              expect(c.height, `${c.name} height`).toBeGreaterThan(0);
              expect(c.x, `${c.name} x`).toBeGreaterThanOrEqual(-0.5);
              expect(c.x + c.width, `${c.name} right edge`).toBeLessThanOrEqual(parent.width + 0.5);
              expect(c.y + c.height, `${c.name} bottom edge`).toBeLessThanOrEqual(parent.height + 0.5);
              walk(c);
            }
          };
          walk(s);
        }
      });

      it("is deterministic: same ids in, same nodes out", () => {
        expect([...apply(t).nodes.values()].map((n) => n.id)).toEqual([...scene.nodes.values()].map((n) => n.id));
      });

      it("the Ops carry the docId and are in the order nodes -> flows -> transitions", () => {
        const ops = templateOps(t, "doc-xyz", "page1", ids());
        expect(ops.every((o) => o.docId === "doc-xyz")).toBe(true);
        const kinds = ops.map((o) => o.kind.case);
        expect(kinds.lastIndexOf("createNode")).toBeLessThan(kinds.indexOf("setFlow"));
        expect(kinds.lastIndexOf("setFlow")).toBeLessThan(kinds.indexOf("setTransition"));
      });
    });
  }

  it("Checkout has a decision with two exits with different conditions", () => {
    const scene = apply(templateById("checkout")!);
    const decision = topLevelScreens(scene, "page1").find((s) => s.meta?.[META_KEYS.kind] === "decision")!;
    const out = Object.values(scene.transitions).filter((t) => t.fromId === decision.id);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((t) => t.guard)).size).toBe(2);
  });

  it("Login has conditions (guard) on the exits to the dashboard", () => {
    const scene = apply(templateById("auth")!);
    const dash = topLevelScreens(scene, "page1").find((s) => s.name === "Dashboard")!;
    const into = Object.values(scene.transitions).filter((t) => t.toId === dash.id);
    expect(into.length).toBeGreaterThanOrEqual(2);
    expect(into.every((t) => t.guard !== "")).toBe(true);
  });

  it("hexFill converts hexadecimal into 0..1 components", () => {
    expect(hexFill("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hexFill(PALETTE.white)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});
