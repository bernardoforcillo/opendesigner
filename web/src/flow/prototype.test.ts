import { describe, it, expect } from "vitest";
import {
  applyEffect, back, backTo, canGoBack, entryScreen, evalGuard, follow, optionsFrom, parseEffect, startState,
  trail, truthy, varEntries,
} from "./prototype";
import { baseScene, flowOf, transition, withFlows } from "./testSupport";

describe("parseEffect", () => {
  it("separa su ; e , e legge k=v", () => {
    expect(parseEffect("cart=full; user=guest")).toEqual([["cart", "full"], ["user", "guest"]]);
    expect(parseEffect("a=1,b=2")).toEqual([["a", "1"], ["b", "2"]]);
  });

  it("toglie spazi e virgolette; il valore può essere vuoto", () => {
    expect(parseEffect(" cart = 'full' ; note=\"x y\"; empty=")).toEqual([["cart", "full"], ["note", "x y"], ["empty", ""]]);
  });

  it("ignora il testo libero che non è un'assegnazione", () => {
    expect(parseEffect("svuota il carrello")).toEqual([]);
    expect(parseEffect("due parole=1")).toEqual([]);
    expect(parseEffect("=1")).toEqual([]);
    expect(parseEffect("")).toEqual([]);
  });

  it("applyEffect non muta e restituisce lo stesso oggetto se non c'è nulla da fare", () => {
    const v = { a: "1" };
    expect(applyEffect(v, "b=2")).toEqual({ a: "1", b: "2" });
    expect(v).toEqual({ a: "1" });
    expect(applyEffect(v, "testo libero")).toBe(v);
  });
});

describe("truthy", () => {
  it("impostata e diversa da vuoto/false/0", () => {
    expect(truthy(undefined)).toBe(false);
    for (const f of ["", "false", "FALSE", "0", "  "]) expect(truthy(f)).toBe(false);
    for (const t of ["1", "true", "full", "no"]) expect(truthy(t)).toBe(true);
  });
});

describe("evalGuard", () => {
  const vars = { user: "guest", cart: "full", n: "0", flag: "true" };

  it("guardia vuota: sempre vera", () => {
    expect(evalGuard("", vars)).toEqual({ ok: true, parsed: true });
    expect(evalGuard("   ", {})).toEqual({ ok: true, parsed: true });
  });

  it("k=v e k!=v", () => {
    expect(evalGuard("user=guest", vars).ok).toBe(true);
    expect(evalGuard("user=admin", vars).ok).toBe(false);
    expect(evalGuard("user!=admin", vars).ok).toBe(true);
    expect(evalGuard("user!=guest", vars).ok).toBe(false);
    // una variabile non impostata non è uguale a niente (ed è diversa da tutto)
    expect(evalGuard("ghost=x", vars).ok).toBe(false);
    expect(evalGuard("ghost!=x", vars).ok).toBe(true);
    // == come sinonimo, spazi attorno
    expect(evalGuard("user == guest", vars).ok).toBe(true);
    expect(evalGuard("user = 'guest'", vars).ok).toBe(true);
  });

  it("k (truthy) e !k", () => {
    expect(evalGuard("flag", vars).ok).toBe(true);
    expect(evalGuard("n", vars).ok).toBe(false); // "0" non è truthy
    expect(evalGuard("ghost", vars).ok).toBe(false);
    expect(evalGuard("!ghost", vars).ok).toBe(true);
    expect(evalGuard("!flag", vars).ok).toBe(false);
  });

  it("&& richiede tutti i termini e dice quali mancano", () => {
    expect(evalGuard("user=guest && cart=full", vars).ok).toBe(true);
    const r = evalGuard("user=guest && cart=empty && ghost", vars);
    expect(r.ok).toBe(false);
    expect(r.parsed).toBe(true);
    expect(r.reason).toBe("Richiede cart=empty e ghost");
  });

  it("testo libero non valutabile: disabilitata COL MOTIVO, mai vera in silenzio", () => {
    for (const g of ["utente premium", "cart non vuoto", "total >= 3", "user=guest && boh boh", "a=1 &&"]) {
      const r = evalGuard(g, { a: "1", user: "guest" });
      expect(r.ok, g).toBe(false);
      expect(r.parsed, g).toBe(false);
      expect(r.reason, g).toContain("non valutabile");
    }
  });
});

describe("navigazione", () => {
  const flow = flowOf("f", "A");
  const s = withFlows(baseScene(), [flow], [
    transition("t1", "f", "A", "B", { label: "Avanti", effect: "step=1" }),
    transition("t2", "f", "A", "C", { label: "Admin", guard: "user=admin" }),
    transition("t3", "f", "B", "C", { label: "Fine", effect: "done=true" }),
    transition("tHot", "f", "A", "B", { label: "Hot", elementId: "btn" }),
    transition("other", "altro", "A", "C"),
  ]);

  it("entryScreen: lo start del flusso, altrimenti il primo frame di primo livello", () => {
    expect(entryScreen(s, flow, "page1")).toBe("A");
    expect(entryScreen(s, flowOf("g", "B"), "page1")).toBe("B");
    // start vuoto o sparito: ripiego sul primo frame
    expect(entryScreen(s, flowOf("g", ""), "page1")).toBe("A");
    expect(entryScreen(s, flowOf("g", "ghost"), "page1")).toBe("A");
    expect(entryScreen(s, null, "page1")).toBe("A");
  });

  it("senza nessuna schermata non c'è stato di partenza", () => {
    expect(startState({ ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), kind: "rect" }).set("B", { ...s.nodes.at("B"), kind: "rect" }).set("C", { ...s.nodes.at("C"), kind: "rect" }) }, null, "page1")).toBeNull();
  });

  it("optionsFrom: solo le uscite della schermata corrente nel flusso, con l'abilitazione", () => {
    const st = startState(s, flow, "page1")!;
    const o = optionsFrom(s, "f", st);
    expect(o.map((x) => x.transition.id).sort()).toEqual(["t1", "t2", "tHot"]);
    const admin = o.find((x) => x.transition.id === "t2")!;
    expect(admin.enabled).toBe(false);
    expect(admin.reason).toBe("Richiede user=admin");
    expect(o.find((x) => x.transition.id === "t1")!.enabled).toBe(true);
  });

  it("un arrivo che non esiste più è disabilitato col motivo", () => {
    const broken = withFlows(baseScene(), [flow], [transition("t", "f", "A", "ghost")]);
    const o = optionsFrom(broken, "f", { screenId: "A", vars: {}, history: [] });
    expect(o[0].enabled).toBe(false);
    expect(o[0].reason).toContain("non esiste");
  });

  it("follow: cambia schermata, applica l'effetto, registra la cronologia", () => {
    const st0 = startState(s, flow, "page1")!;
    const st1 = follow(s, st0, s.transitions.t1);
    expect(st1.screenId).toBe("B");
    expect(st1.vars).toEqual({ step: "1" });
    expect(st1.history).toEqual([{ screenId: "A", vars: {}, via: "t1" }]);
    const st2 = follow(s, st1, s.transitions.t3);
    expect(st2.vars).toEqual({ step: "1", done: "true" });
    expect(trail(st2)).toEqual(["A", "B", "C"]);
  });

  it("follow con guardia non soddisfatta NON si muove", () => {
    const st0 = startState(s, flow, "page1")!;
    expect(follow(s, st0, s.transitions.t2)).toBe(st0);
    const unlocked = follow(s, { ...st0, vars: { user: "admin" } }, s.transitions.t2);
    expect(unlocked.screenId).toBe("C");
  });

  it("back ripristina anche le variabili; backTo salta a una briciola", () => {
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
    // indici fuori intervallo: nessun effetto
    expect(backTo(st2, 5)).toBe(st2);
    expect(backTo(st2, -1)).toBe(st2);
  });

  it("varEntries ordina per nome", () => {
    expect(varEntries({ b: "2", a: "1" })).toEqual([["a", "1"], ["b", "2"]]);
  });
});
