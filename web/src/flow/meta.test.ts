import { describe, it, expect } from "vitest";
import { kindOf, metaValue, META_KEYS, statusOf, withMeta, STATUS_COLORS } from "./meta";
import { frame } from "./testSupport";

describe("kindOf / statusOf", () => {
  it("default: screen, planned", () => {
    expect(kindOf(frame("A", 0))).toBe("screen");
    expect(statusOf(frame("A", 0))).toBe("planned");
    expect(kindOf(undefined)).toBe("screen");
  });

  it("reads the known values and ignores the unknown ones", () => {
    const n = frame("A", 0, 0, { meta: { "flow.kind": "decision", status: "tested" } });
    expect(kindOf(n)).toBe("decision");
    expect(statusOf(n)).toBe("tested");
    const odd = frame("B", 0, 0, { meta: { "flow.kind": "boh", status: "???" } });
    expect(kindOf(odd)).toBe("screen");
    expect(statusOf(odd)).toBe("planned");
  });

  it("the status colors: gray / blue / green", () => {
    expect(STATUS_COLORS.planned).toBe("#9ca3af");
    expect(STATUS_COLORS.implemented).toBe("#2f6fed");
    expect(STATUS_COLORS.tested).toBe("#16a34a");
  });

  it("metaValue returns an empty string if absent", () => {
    expect(metaValue(frame("A", 0), META_KEYS.route)).toBe("");
    expect(metaValue(frame("A", 0, 0, { meta: { "code.route": "/x" } }), META_KEYS.route)).toBe("/x");
  });
});

describe("withMeta (the meta mask REPLACES the map)", () => {
  it("keeps the other keys, even the unknown ones", () => {
    const n = frame("A", 0, 0, { meta: { "code.route": "/a", "other.tool": "1" } });
    expect(withMeta(n, "status", "tested")).toEqual({ "code.route": "/a", "other.tool": "1", status: "tested" });
  });

  it("an empty value REMOVES the key", () => {
    const n = frame("A", 0, 0, { meta: { "code.route": "/a", status: "tested" } });
    expect(withMeta(n, "code.route", "  ")).toEqual({ status: "tested" });
  });

  it("does not mutate the starting node", () => {
    const n = frame("A", 0, 0, { meta: { status: "tested" } });
    withMeta(n, "status", "planned");
    expect(n.meta).toEqual({ status: "tested" });
  });

  it("on a node without meta it starts from empty", () => {
    expect(withMeta(frame("A", 0), "test.id", "x")).toEqual({ "test.id": "x" });
  });
});
