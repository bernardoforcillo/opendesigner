import { describe, it, expect } from "vitest";
import {
  applyEffect, back, backTo, canGoBack, applyVariants, closeOverlay, isGestureTrigger, restoreVariant, entryScreen, evalGuard, follow, optionsFrom, parseEffect, startState,
  trail, truthy, varEntries,
} from "@/flow/prototype";
import { baseScene, flowOf, transition, withFlows } from "@/flow/testSupport";

describe("parseEffect", () => {
  it("splits on ; and , and reads k=v", () => {
    expect(parseEffect("cart=full; user=guest")).toEqual([["cart", "full"], ["user", "guest"]]);
    expect(parseEffect("a=1,b=2")).toEqual([["a", "1"], ["b", "2"]]);
  });

  it("strips spaces and quotes; the value may be empty", () => {
    expect(parseEffect(" cart = 'full' ; note=\"x y\"; empty=")).toEqual([["cart", "full"], ["note", "x y"], ["empty", ""]]);
  });

  it("ignores free text that is not an assignment", () => {
    expect(parseEffect("empty the cart")).toEqual([]);
    expect(parseEffect("two words=1")).toEqual([]);
    expect(parseEffect("=1")).toEqual([]);
    expect(parseEffect("")).toEqual([]);
  });

  it("applyEffect does not mutate and returns the same object if there is nothing to do", () => {
    const v = { a: "1" };
    expect(applyEffect(v, "b=2")).toEqual({ a: "1", b: "2" });
    expect(v).toEqual({ a: "1" });
    expect(applyEffect(v, "free text")).toBe(v);
  });
});

describe("truthy", () => {
  it("set and different from empty/false/0", () => {
    expect(truthy(undefined)).toBe(false);
    for (const f of ["", "false", "FALSE", "0", "  "]) expect(truthy(f)).toBe(false);
    for (const t of ["1", "true", "full", "no"]) expect(truthy(t)).toBe(true);
  });
});

describe("evalGuard", () => {
  const vars = { user: "guest", cart: "full", n: "0", flag: "true" };

  it("empty guard: always true", () => {
    expect(evalGuard("", vars)).toEqual({ ok: true, parsed: true });
    expect(evalGuard("   ", {})).toEqual({ ok: true, parsed: true });
  });

  it("k=v e k!=v", () => {
    expect(evalGuard("user=guest", vars).ok).toBe(true);
    expect(evalGuard("user=admin", vars).ok).toBe(false);
    expect(evalGuard("user!=admin", vars).ok).toBe(true);
    expect(evalGuard("user!=guest", vars).ok).toBe(false);
    // an unset variable is not equal to anything (and is different from everything)
    expect(evalGuard("ghost=x", vars).ok).toBe(false);
    expect(evalGuard("ghost!=x", vars).ok).toBe(true);
    // == as a synonym, spaces around
    expect(evalGuard("user == guest", vars).ok).toBe(true);
    expect(evalGuard("user = 'guest'", vars).ok).toBe(true);
  });

  it("k (truthy) e !k", () => {
    expect(evalGuard("flag", vars).ok).toBe(true);
    expect(evalGuard("n", vars).ok).toBe(false); // "0" is not truthy
    expect(evalGuard("ghost", vars).ok).toBe(false);
    expect(evalGuard("!ghost", vars).ok).toBe(true);
    expect(evalGuard("!flag", vars).ok).toBe(false);
  });

  it("&& requires all the terms and says which are missing", () => {
    expect(evalGuard("user=guest && cart=full", vars).ok).toBe(true);
    const r = evalGuard("user=guest && cart=empty && ghost", vars);
    expect(r.ok).toBe(false);
    expect(r.parsed).toBe(true);
    expect(r.reason).toBe("Requires cart=empty and ghost");
  });

  it("unevaluable free text: disabled WITH THE REASON, never silently true", () => {
    for (const g of ["premium user", "cart not empty", "total >=", "a + 1 > ", "user=guest && huh huh", "a=1 &&", "a || ", "(a"]) {
      const r = evalGuard(g, { a: "1", user: "guest" });
      expect(r.ok, g).toBe(false);
      expect(r.parsed, g).toBe(false);
      expect(r.reason, g).toContain("cannot be evaluated");
    }
  });
});

describe("navigazione", () => {
  const flow = flowOf("f", "A");
  const s = withFlows(baseScene(), [flow], [
    transition("t1", "f", "A", "B", { label: "Advance", effect: "step=1" }),
    transition("t2", "f", "A", "C", { label: "Admin", guard: "user=admin" }),
    transition("t3", "f", "B", "C", { label: "Finish", effect: "done=true" }),
    transition("tHot", "f", "A", "B", { label: "Hot", elementId: "btn" }),
    transition("other", "other-flow", "A", "C"),
  ]);

  it("entryScreen: the flow's start, otherwise the first top-level frame", () => {
    expect(entryScreen(s, flow, "page1")).toBe("A");
    expect(entryScreen(s, flowOf("g", "B"), "page1")).toBe("B");
    // start empty or vanished: fall back to the first frame
    expect(entryScreen(s, flowOf("g", ""), "page1")).toBe("A");
    expect(entryScreen(s, flowOf("g", "ghost"), "page1")).toBe("A");
    expect(entryScreen(s, null, "page1")).toBe("A");
  });

  it("without any screen there is no starting state", () => {
    expect(startState({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), kind: "rect" }).set("B", { ...s.nodes.at("B"), kind: "rect" }).set("C", { ...s.nodes.at("C"), kind: "rect" }) }, null, "page1")).toBeNull();
  });

  it("optionsFrom: only the exits of the current screen in the flow, with enablement", () => {
    const st = startState(s, flow, "page1")!;
    const o = optionsFrom(s, "f", st);
    expect(o.map((x) => x.transition.id).sort()).toEqual(["t1", "t2", "tHot"]);
    const admin = o.find((x) => x.transition.id === "t2")!;
    expect(admin.enabled).toBe(false);
    expect(admin.reason).toBe("Requires user=admin");
    expect(o.find((x) => x.transition.id === "t1")!.enabled).toBe(true);
  });

  it("an arrival that no longer exists is disabled with the reason", () => {
    const broken = withFlows(baseScene(), [flow], [transition("t", "f", "A", "ghost")]);
    const o = optionsFrom(broken, "f", { screenId: "A", vars: {}, history: [] });
    expect(o[0].enabled).toBe(false);
    expect(o[0].reason).toContain("no longer exists");
  });

  it("follow: changes screen, applies the effect, records the history", () => {
    const st0 = startState(s, flow, "page1")!;
    const st1 = follow(s, st0, s.transitions.t1);
    expect(st1.screenId).toBe("B");
    expect(st1.vars).toEqual({ step: "1" });
    expect(st1.history).toEqual([{ screenId: "A", vars: {}, via: "t1" }]);
    const st2 = follow(s, st1, s.transitions.t3);
    expect(st2.vars).toEqual({ step: "1", done: "true" });
    expect(trail(st2)).toEqual(["A", "B", "C"]);
  });

  it("follow with an unmet guard does NOT move", () => {
    const st0 = startState(s, flow, "page1")!;
    expect(follow(s, st0, s.transitions.t2)).toBe(st0);
    const unlocked = follow(s, { ...st0, vars: { user: "admin" } }, s.transitions.t2);
    expect(unlocked.screenId).toBe("C");
  });

  it("back also restores the variables; backTo jumps to a breadcrumb", () => {
    const st0 = startState(s, flow, "page1")!;
    const st1 = follow(s, st0, s.transitions.t1);
    const st2 = follow(s, st1, s.transitions.t3);
    expect(canGoBack(st0)).toBe(false);
    expect(back(st0)).toBe(st0);
    const b = back(st2);
    expect(b.screenId).toBe("B");
    expect(b.vars).toEqual({ step: "1" });
    expect(b.history).toHaveLength(1);
    const root = backTo(st2, 0);
    expect(root.screenId).toBe("A");
    expect(root.vars).toEqual({});
    expect(root.history).toEqual([]);
    // out-of-range indices: no effect
    expect(backTo(st2, 5)).toBe(st2);
    expect(backTo(st2, -1)).toBe(st2);
  });

  it("varEntries sorts by name", () => {
    expect(varEntries({ b: "2", a: "1" })).toEqual([["a", "1"], ["b", "2"]]);
  });
});

describe("overlays", () => {
  const sc = () => withFlows(baseScene(), [flowOf("f1", "A")], [
    transition("o", "f1", "A", "B", { animation: "overlay", effect: "open=1" }),
    transition("x", "f1", "B", "C", { label: "Next" }),
  ]);
  const o = (t: string) => sc().transitions[t];

  it("opens the target over the screen, which stays", () => {
    const s = sc();
    const st = follow(s, startState(s, null, null)!, o("o"));
    expect(st.screenId).toBe("A");
    expect(st.overlay).toBe("B");
    expect(st.vars.open).toBe("1");
  });

  it("answers with the overlay's own exits while it is open", () => {
    const s = sc();
    const st = follow(s, startState(s, null, null)!, o("o"));
    expect(optionsFrom(s, "f1", st).map((x) => x.transition.id)).toEqual(["x"]);
  });

  it("an exit of the overlay leaves the overlay and goes to the target", () => {
    const s = sc();
    const st = follow(s, follow(s, startState(s, null, null)!, o("o")), o("x"));
    expect(st.screenId).toBe("C");
    expect(st.overlay).toBeUndefined();
  });

  it("closing keeps the screen and the variables; back restores the overlay", () => {
    const s = sc();
    const open = follow(s, startState(s, null, null)!, o("o"));
    expect(closeOverlay(open)).toMatchObject({ screenId: "A", vars: { open: "1" } });
    expect(closeOverlay(open).overlay).toBeUndefined();
    const next = follow(s, open, o("x"));
    expect(back(next).overlay).toBe("B");
    expect(back(open).overlay).toBeUndefined();
  });

  it("knows the gesture triggers", () => {
    expect(["hover", "drag", "scroll"].every(isGestureTrigger)).toBe(true);
    expect(isGestureTrigger("click")).toBe(false);
  });
});

describe("component state changes", () => {
  const sc = () => {
    const b = baseScene();
    const m = (id: string) => ({ ...b.nodes.at("btn")!, id, parentId: "components", kind: "group" as const });
    const scene = withFlows(
      { ...b, nodes: b.nodes.set("btn", { ...b.nodes.at("btn")!, instance: { componentId: "c1", overrides: [] } }).set("m1", m("m1")).set("m2", m("m2")) },
      [flowOf("f1", "A")],
      [transition("v", "f1", "A", "m2", { elementId: "btn", trigger: "hover", animation: "set-variant", effect: "hot=1" })],
    );
    scene.componentSets = { s: { id: "s", name: "Button", axes: [{ name: "State", options: ["default", "hover"] }] } };
    scene.components = {
      c1: { rootNodeId: "m1", name: "Button", setId: "s", variant: { State: "default" }, properties: [] },
      c2: { rootNodeId: "m2", name: "Button hover", setId: "s", variant: { State: "hover" }, properties: [] },
    };
    return scene;
  };

  it("switches the instance's variant without leaving the screen or adding a step to the path", () => {
    const s = sc();
    const st = follow(s, startState(s, null, null)!, s.transitions.v);
    expect(st.screenId).toBe("A");
    expect(st.variants).toEqual({ btn: { State: "hover" } });
    expect(st.vars.hot).toBe("1");
    expect(st.history).toHaveLength(0);
  });

  it("draws the chosen variant on the instance, and puts it back", () => {
    const s = sc();
    const st = follow(s, startState(s, null, null)!, s.transitions.v);
    expect(applyVariants(s, st.variants).nodes.at("btn")!.instance!.variantProps).toEqual({ State: "hover" });
    expect(applyVariants(s, undefined)).toBe(s);
    const back = restoreVariant(st, "btn", undefined);
    expect(back.variants).toBeUndefined();
    expect(restoreVariant(st, "btn", { State: "pressed" }).variants).toEqual({ btn: { State: "pressed" } });
  });

  it("Back returns to the variants of the earlier step", () => {
    const s = sc();
    s.transitions.go = transition("go", "f1", "A", "B");
    const withVariant = follow(s, startState(s, null, null)!, s.transitions.v);
    const moved = follow(s, withVariant, s.transitions.go);
    expect(back(moved).variants).toEqual({ btn: { State: "hover" } });
  });
});
