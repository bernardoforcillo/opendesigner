import { describe, it, expect } from "vitest";
import { kindOf, metaValue, META_KEYS, statusOf, withMeta, STATUS_COLORS } from "./meta";
import { frame } from "./testSupport";

describe("kindOf / statusOf", () => {
  it("default: schermata, pianificata", () => {
    expect(kindOf(frame("A", 0))).toBe("screen");
    expect(statusOf(frame("A", 0))).toBe("planned");
    expect(kindOf(undefined)).toBe("screen");
  });

  it("legge i valori noti e ignora quelli sconosciuti", () => {
    const n = frame("A", 0, 0, { meta: { "flow.kind": "decision", status: "tested" } });
    expect(kindOf(n)).toBe("decision");
    expect(statusOf(n)).toBe("tested");
    const odd = frame("B", 0, 0, { meta: { "flow.kind": "boh", status: "???" } });
    expect(kindOf(odd)).toBe("screen");
    expect(statusOf(odd)).toBe("planned");
  });

  it("i colori di stato: grigio / blu / verde", () => {
    expect(STATUS_COLORS.planned).toBe("#9ca3af");
    expect(STATUS_COLORS.implemented).toBe("#2f6fed");
    expect(STATUS_COLORS.tested).toBe("#16a34a");
  });

  it("metaValue restituisce stringa vuota se assente", () => {
    expect(metaValue(frame("A", 0), META_KEYS.route)).toBe("");
    expect(metaValue(frame("A", 0, 0, { meta: { "code.route": "/x" } }), META_KEYS.route)).toBe("/x");
  });
});

describe("withMeta (la mask meta SOSTITUISCE la mappa)", () => {
  it("conserva le altre chiavi, anche quelle sconosciute", () => {
    const n = frame("A", 0, 0, { meta: { "code.route": "/a", "altro.strumento": "1" } });
    expect(withMeta(n, "status", "tested")).toEqual({ "code.route": "/a", "altro.strumento": "1", status: "tested" });
  });

  it("un valore vuoto TOGLIE la chiave", () => {
    const n = frame("A", 0, 0, { meta: { "code.route": "/a", status: "tested" } });
    expect(withMeta(n, "code.route", "  ")).toEqual({ status: "tested" });
  });

  it("non muta il nodo di partenza", () => {
    const n = frame("A", 0, 0, { meta: { status: "tested" } });
    withMeta(n, "status", "planned");
    expect(n.meta).toEqual({ status: "tested" });
  });

  it("su un nodo senza meta parte da vuoto", () => {
    expect(withMeta(frame("A", 0), "test.id", "x")).toEqual({ "test.id": "x" });
  });
});
