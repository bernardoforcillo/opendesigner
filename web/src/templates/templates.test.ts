import { describe, expect, it } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { topLevelScreens } from "../flow/screens";
import { META_KEYS } from "../flow/meta";
import { TEMPLATES, templateById, templateOps } from "./catalog";
import type { Template } from "./catalog";
import { PALETTE, hexFill } from "./builder";

// Un generatore di id deterministico: i test non dipendono dal caso.
function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

function apply(t: Template): SceneState {
  const ops = templateOps(t, "doc", "page1", ids());
  return ops.reduce((s, op) => applyOp(s, op), emptyScene("doc", t.docName));
}

// Porta dell'analisi del server (internal/flow/analyze.go) sui soli problemi che
// un template NON deve avere: nessun ingresso, schermate irraggiungibili,
// vicoli ciechi, archi ambigui. La verifica contro il server vero è nello
// script di verifica nel browser; qui si tiene il contratto in test unitari.
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

describe("catalogo dei template", () => {
  it("ha almeno Vuoto, Onboarding, Login, Checkout e Dashboard SaaS, con id unici", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["blank", "onboarding", "auth", "checkout", "saas"]);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(templateById("auth")?.name).toBe("Login e registrazione");
    expect(templateById("nope")).toBeUndefined();
  });

  it("Vuoto non produce nessun Op", () => {
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

      it("applicato con applyOp dà le schermate e i flussi attesi", () => {
        const screens = topLevelScreens(scene, "page1");
        expect(screens).toHaveLength(expected[t.id].screens);
        expect(Object.keys(scene.flows)).toHaveLength(expected[t.id].flows);
        expect(Object.keys(scene.transitions).length).toBeGreaterThanOrEqual(expected[t.id].screens - 1);
      });

      it("schermate mobile 390 di larghezza, affiancate senza sovrapporsi", () => {
        const screens = topLevelScreens(scene, "page1").slice().sort((a, b) => a.x - b.x);
        for (const s of screens) expect(s.width).toBe(390);
        for (let i = 1; i < screens.length; i++) expect(screens[i].x).toBeGreaterThanOrEqual(screens[i - 1].x + screens[i - 1].width);
      });

      it("l'analisi dei flussi non trova ingressi mancanti, irraggiungibili, vicoli ciechi né archi ambigui", () => {
        for (const f of Object.values(scene.flows)) expect(issuesOf(scene, f.id)).toEqual([]);
      });

      it("ogni schermata dichiara la rotta (code.route), e le rotte sono distinte", () => {
        const routes = topLevelScreens(scene, "page1").map((s) => s.meta?.[META_KEYS.route]);
        expect(routes.every((r) => !!r && r!.startsWith("/"))).toBe(true);
        expect(new Set(routes).size).toBe(routes.length);
      });

      it("ogni hotspot sta DENTRO la schermata di partenza e ha test.id (o test.text) per Playwright", () => {
        for (const tr of Object.values(scene.transitions)) {
          if (!tr.elementId) continue;
          expect(isInside(scene, tr.elementId, tr.fromId)).toBe(true);
          const m = scene.nodes.at(tr.elementId)!.meta ?? {};
          expect(m[META_KEYS.testId] || m[META_KEYS.testText]).toBeTruthy();
        }
      });

      it("i test.id sono unici nel documento", () => {
        const all: string[] = [];
        for (const n of scene.nodes.values()) if (n.meta?.[META_KEYS.testId]) all.push(n.meta[META_KEYS.testId]);
        expect(new Set(all).size).toBe(all.length);
      });

      it("i figli stanno nel box della schermata e non hanno dimensioni nulle", () => {
        const screens = topLevelScreens(scene, "page1");
        for (const s of screens) {
          const walk = (parent: NodeLite) => {
            for (const c of scene.nodes.values()) {
              if (c.parentId !== parent.id) continue;
              expect(c.width, `${c.name} largo`).toBeGreaterThan(0);
              expect(c.height, `${c.name} alto`).toBeGreaterThan(0);
              expect(c.x, `${c.name} x`).toBeGreaterThanOrEqual(-0.5);
              expect(c.x + c.width, `${c.name} bordo destro`).toBeLessThanOrEqual(parent.width + 0.5);
              expect(c.y + c.height, `${c.name} bordo basso`).toBeLessThanOrEqual(parent.height + 0.5);
              walk(c);
            }
          };
          walk(s);
        }
      });

      it("è deterministico: stessi id in ingresso, stessi nodi in uscita", () => {
        expect([...apply(t).nodes.values()].map((n) => n.id)).toEqual([...scene.nodes.values()].map((n) => n.id));
      });

      it("gli Op portano il docId e sono nell'ordine nodi -> flussi -> transizioni", () => {
        const ops = templateOps(t, "doc-xyz", "page1", ids());
        expect(ops.every((o) => o.docId === "doc-xyz")).toBe(true);
        const kinds = ops.map((o) => o.kind.case);
        expect(kinds.lastIndexOf("createNode")).toBeLessThan(kinds.indexOf("setFlow"));
        expect(kinds.lastIndexOf("setFlow")).toBeLessThan(kinds.indexOf("setTransition"));
      });
    });
  }

  it("Checkout ha una decisione con due uscite con condizioni diverse", () => {
    const scene = apply(templateById("checkout")!);
    const decision = topLevelScreens(scene, "page1").find((s) => s.meta?.[META_KEYS.kind] === "decision")!;
    const out = Object.values(scene.transitions).filter((t) => t.fromId === decision.id);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((t) => t.guard)).size).toBe(2);
  });

  it("Login ha condizioni (guard) sulle uscite verso la dashboard", () => {
    const scene = apply(templateById("auth")!);
    const dash = topLevelScreens(scene, "page1").find((s) => s.name === "Dashboard")!;
    const into = Object.values(scene.transitions).filter((t) => t.toId === dash.id);
    expect(into.length).toBeGreaterThanOrEqual(2);
    expect(into.every((t) => t.guard !== "")).toBe(true);
  });

  it("hexFill converte l'esadecimale in componenti 0..1", () => {
    expect(hexFill("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hexFill(PALETTE.white)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});
