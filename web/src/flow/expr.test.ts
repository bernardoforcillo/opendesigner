import { describe, it, expect } from "vitest";
import { evalCondition, evalExpr, ExprError } from "./expr";
import { applyEffect, evalGuard, follow, guardFor, optionsFrom, parseAssignments, parseEffect, startState } from "./prototype";
import { baseScene, flowOf, transition, withFlows } from "./testSupport";

describe("evalExpr", () => {
  it.each<[string, Record<string, string>, string]>([
    ["1 + 2 * 3", {}, "7"],
    ["(1 + 2) * 3", {}, "9"],
    ["count + 1", { count: "4" }, "5"],
    ["count - 1", { count: "4" }, "3"],
    ["10 / 4", {}, "2.5"],
    ["10 % 4", {}, "2"],
    ["-count", { count: "4" }, "-4"],
    ["0.1 + 0.2", {}, "0.3"], // no floating point tails
    ["count + 1", {}, "1"], // an unset variable is 0 in arithmetic
    ["total * 1.5", { total: "10" }, "15"],
    ['"Hi " + name', { name: "Ana" }, "Hi Ana"],
    ["name + '!'", { name: "Ana" }, "Ana!"],
    ["a + b", { a: "2", b: "3" }, "5"],
    ["count > 2", { count: "3" }, "true"],
    ["count > 2 && count < 5", { count: "3" }, "true"],
    ["count < 1 || count > 2", { count: "0" }, "true"],
    ["!flag", { flag: "0" }, "true"],
    ["count == 3", { count: "3.0" }, "true"], // numbers compare as numbers
    ["name != 'Ana'", { name: "Bo" }, "true"],
    ["a < b", { a: "apple", b: "pear" }, "true"], // two words compare as text
  ])("%s -> %s", (src, vars, want) => expect(evalExpr(src, vars)).toBe(want));

  it.each(["", "1 +", "(1 + 2", "1 + * 2", "count +", "10 / 0", "5 % 0", "'open", "a b", "1 $ 2", "name * 2", "x > 'a'"])(
    "%j cannot be computed",
    (src) => expect(() => evalExpr(src, { name: "Ana", x: "1" })).toThrow(ExprError),
  );

  it("evalCondition reads the result as true / false", () => {
    expect(evalCondition("count >= 3", { count: "3" })).toBe(true);
    expect(evalCondition("count >= 3", {})).toBe(false);
    expect(evalCondition("flag", { flag: "yes" })).toBe(true);
    expect(evalCondition("n", { n: "0" })).toBe(false);
  });
});

describe("effects with expressions", () => {
  it("parses assignments and tells text from an expression", () => {
    expect(parseAssignments("cart=full; count = count + 1, name = 'a, b'")).toEqual([
      { key: "cart", rhs: "full", literal: true },
      { key: "count", rhs: "count + 1", literal: false },
      { key: "name", rhs: "'a, b'", literal: true },
    ]);
    expect(parseEffect("count = count + 1")).toEqual([["count", "count + 1"]]);
  });

  it("count = count + 1 counts, starting from nothing", () => {
    let v = applyEffect({}, "count = count + 1");
    expect(v).toEqual({ count: "1" });
    v = applyEffect(v, "count = count + 1");
    v = applyEffect(v, "count=count+1");
    expect(v.count).toBe("3");
  });

  it("assignments run in order and see each other", () => {
    expect(applyEffect({ a: "1" }, "a = a + 1; b = a * 10")).toEqual({ a: "2", b: "20" });
  });

  it("a right side that cannot be computed leaves the variable alone; the others still run", () => {
    const v = { name: "Ana", n: "1" };
    expect(applyEffect(v, "n = name * 2; ok = n + 1")).toEqual({ name: "Ana", n: "1", ok: "2" });
    expect(applyEffect(v, "n = 1 / 0")).toBe(v);
  });

  it("plain words stay text: `cart=full` does not read a variable called full", () => {
    expect(applyEffect({ full: "x" }, "cart=full")).toEqual({ full: "x", cart: "full" });
  });

  it("a comma inside quotes or parentheses is not a separator", () => {
    expect(applyEffect({}, 'msg = "a, b"; k = (1 + 2)')).toEqual({ msg: "a, b", k: "3" });
  });
});

describe("guards with expressions", () => {
  const vars = { count: "3", user: "guest", paid: "true", total: "40" };

  it("compares numbers", () => {
    expect(evalGuard("count >= 3", vars).ok).toBe(true);
    expect(evalGuard("count > 3", vars).ok).toBe(false);
    expect(evalGuard("total <= 50 && total > 10", vars).ok).toBe(true);
    expect(evalGuard("count + 1 > 3", vars).ok).toBe(true);
    expect(evalGuard("ghost < 1", vars).ok).toBe(true); // unset is 0
  });

  it("|| takes the alternative that holds, and says what was missing when none does", () => {
    expect(evalGuard("user=admin || paid", vars).ok).toBe(true);
    const r = evalGuard("user=admin || count > 5", vars);
    expect(r).toMatchObject({ ok: false, parsed: true, reason: "Requires user=admin or count > 5" });
    expect(evalGuard("user=admin && paid || count == 3", vars).ok).toBe(true);
  });

  it("the plain forms keep their meaning: a word on the right is text, not a variable", () => {
    expect(evalGuard("user=guest", { user: "guest", guest: "no" }).ok).toBe(true);
    expect(evalGuard("count = 3", { count: "3.0" }).ok).toBe(true);
    expect(evalGuard("count != 3", { count: "3.0" }).ok).toBe(false);
  });

  it("|| and && inside quotes or parentheses are not split", () => {
    expect(evalGuard("msg = 'a || b'", { msg: "a || b" }).ok).toBe(true);
    expect(evalGuard("(count > 1 && count < 9) == true", vars).ok).toBe(true);
  });

  it("a term it cannot read makes the whole guard unevaluable", () => {
    for (const g of ["count >", "count > 1 || huh huh", "(count"]) {
      expect(evalGuard(g, vars), g).toMatchObject({ ok: false, parsed: false });
    }
  });
});

describe("if / else on one hotspot", () => {
  const flow = flowOf("f", "A");
  const sceneWith = (...ts: ReturnType<typeof transition>[]) => withFlows(baseScene(), [flow], ts);
  const chain = sceneWith(
    transition("big", "f", "A", "B", { label: "Pay", elementId: "btn", guard: "total > 100" }),
    transition("mid", "f", "A", "C", { label: "Pay", elementId: "btn", guard: "total > 50 && total <= 100" }),
    transition("small", "f", "A", "A", { label: "Pay", elementId: "btn", guard: "else" }),
  );
  const at = (s: ReturnType<typeof sceneWith>, vars: Record<string, string>) => ({ ...startState(s, flow, "page1")!, vars });
  const enabled = (s: ReturnType<typeof sceneWith>, vars: Record<string, string>) =>
    optionsFrom(s, "f", at(s, vars)).filter((o) => o.enabled).map((o) => o.transition.id);

  it("exactly one branch holds: if, else if (a condition that does not overlap), else", () => {
    expect(enabled(chain, { total: "150" })).toEqual(["big"]);
    expect(enabled(chain, { total: "70" })).toEqual(["mid"]);
    expect(enabled(chain, { total: "10" })).toEqual(["small"]);
    expect(enabled(chain, {})).toEqual(["small"]); // nothing set: nothing holds, so the else does
  });

  it("the else says which condition it gave way to", () => {
    const st = at(chain, { total: "150" });
    expect(guardFor(chain, st, chain.transitions.small)).toMatchObject({ ok: false, reason: "Not when total > 100" });
  });

  it("the branches that do not apply are superseded, not locked: the player does not draw them", () => {
    const opts = optionsFrom(chain, "f", at(chain, { total: "70" }));
    expect(opts.filter((o) => o.superseded).map((o) => o.transition.id).sort()).toEqual(["big", "small"]);
    expect(opts.find((o) => o.transition.id === "mid")!.superseded).toBeUndefined();
  });

  it("a hotspot with nothing enabled keeps its locked branches visible (and says why)", () => {
    const s = sceneWith(transition("only", "f", "A", "B", { elementId: "btn", guard: "paid" }));
    const o = optionsFrom(s, "f", at(s, {}))[0];
    expect(o.enabled).toBe(false);
    expect(o.superseded).toBeUndefined();
  });

  it("following the else applies its effect; following a branch that does not apply does nothing", () => {
    const withEffects = sceneWith(
      transition("hi", "f", "A", "B", { elementId: "btn", guard: "n >= 3", effect: "n = 0" }),
      transition("lo", "f", "A", "C", { elementId: "btn", guard: "else", effect: "n = n + 1" }),
    );
    let st = at(withEffects, {});
    st = follow(withEffects, st, withEffects.transitions.lo);
    expect(st).toMatchObject({ screenId: "C", vars: { n: "1" } });
    const stay = at(withEffects, { n: "5" });
    expect(follow(withEffects, stay, withEffects.transitions.lo)).toBe(stay);
    expect(follow(withEffects, stay, withEffects.transitions.hi)).toMatchObject({ screenId: "B", vars: { n: "0" } });
  });

  it("an else only looks at the same screen, trigger and hotspot", () => {
    const s = sceneWith(
      transition("other", "f", "A", "B", { elementId: "loose", guard: "x" }), // another element
      transition("els", "f", "A", "C", { elementId: "btn", guard: "else" }),
    );
    expect(enabled(s, { x: "1" })).toContain("els");
  });
});

describe("ordered if / else if / else chains (Transition.order)", () => {
  const flow = flowOf("f", "A");
  // The conditions OVERLAP on purpose (>= 50 and >= 100): only the order tells them apart.
  const chain = withFlows(baseScene(), [flow], [
    transition("big", "f", "A", "B", { label: "Pay", elementId: "btn", guard: "total >= 100", order: 1 }),
    transition("mid", "f", "A", "C", { label: "Pay", elementId: "btn", guard: "total >= 50", order: 2 }),
    transition("small", "f", "A", "A", { label: "Pay", elementId: "btn", guard: "else", order: 3 }),
  ]);
  const on = (s: typeof chain, vars: Record<string, string>) =>
    optionsFrom(s, "f", { ...startState(s, flow, "page1")!, vars }).filter((o) => o.enabled).map((o) => o.transition.id).sort();

  it("the first branch whose guard holds applies, later overlapping ones give way", () => {
    expect(on(chain, { total: "150" })).toEqual(["big"]);
    expect(on(chain, { total: "70" })).toEqual(["mid"]);
    expect(on(chain, { total: "10" })).toEqual(["small"]);
  });

  it("the branch that gave way says which one took the click", () => {
    const st = { ...startState(chain, flow, "page1")!, vars: { total: "150" } };
    expect(guardFor(chain, st, chain.transitions.mid)).toMatchObject({ ok: false, reason: "Not when total >= 100" });
  });

  it("the order, not the id, decides: swapping the numbers swaps the winner", () => {
    const swapped = withFlows(baseScene(), [flow], [
      transition("big", "f", "A", "B", { elementId: "btn", guard: "total >= 100", order: 2 }),
      transition("mid", "f", "A", "C", { elementId: "btn", guard: "total >= 50", order: 1 }),
    ]);
    expect(on(swapped, { total: "150" })).toEqual(["mid"]);
  });

  it("an unguarded branch always holds, so it shadows the ones after it", () => {
    const s = withFlows(baseScene(), [flow], [
      transition("a", "f", "A", "B", { elementId: "btn", guard: "x", order: 1 }),
      transition("always", "f", "A", "C", { elementId: "btn", order: 2 }),
      transition("never", "f", "A", "A", { elementId: "btn", guard: "y", order: 3 }),
    ]);
    expect(on(s, { y: "1" })).toEqual(["always"]);
    expect(on(s, { x: "1", y: "1" })).toEqual(["a"]);
  });

  it("transitions without an order stay independent of the chain (and of each other)", () => {
    const s = withFlows(baseScene(), [flow], [
      transition("c1", "f", "A", "B", { elementId: "btn", guard: "x", order: 1 }),
      transition("c2", "f", "A", "C", { elementId: "btn", guard: "x", order: 2 }),
      transition("free", "f", "A", "A", { elementId: "btn", guard: "x" }),
    ]);
    expect(on(s, { x: "1" })).toEqual(["c1", "free"]);
  });

  it("a chain only looks at its own screen, trigger and hotspot", () => {
    const s = withFlows(baseScene(), [flow], [
      transition("first", "f", "A", "B", { elementId: "loose", guard: "x", order: 1 }),
      transition("second", "f", "A", "C", { elementId: "btn", guard: "x", order: 2 }),
    ]);
    expect(on(s, { x: "1" })).toEqual(["first", "second"]);
  });

  it("following a branch that gave way does nothing; the winner applies its effect", () => {
    const s = withFlows(baseScene(), [flow], [
      transition("hi", "f", "A", "B", { elementId: "btn", guard: "n >= 1", effect: "n = 0", order: 1 }),
      transition("lo", "f", "A", "C", { elementId: "btn", guard: "n >= 0", effect: "n = n + 1", order: 2 }),
    ]);
    const st = { ...startState(s, flow, "page1")!, vars: { n: "5" } };
    expect(follow(s, st, s.transitions.lo)).toBe(st);
    expect(follow(s, st, s.transitions.hi)).toMatchObject({ screenId: "B", vars: { n: "0" } });
  });
});
