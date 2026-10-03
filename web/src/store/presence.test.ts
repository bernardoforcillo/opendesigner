import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { PresenceEventSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyPresenceEvent, peerColor, type Peers } from "./presence";

const update = (clientId: string, over: Record<string, unknown> = {}) =>
  create(PresenceEventSchema, {
    kind: { case: "update", value: { clientId, nickname: clientId.toUpperCase(), ...over } },
  } as never);
const left = (id: string) => create(PresenceEventSchema, { kind: { case: "leftClientId", value: id } } as never);

describe("applyPresenceEvent", () => {
  it("un update inserisce il peer e un secondo lo rimpiazza", () => {
    let p: Peers = {};
    p = applyPresenceEvent(p, update("a"));
    expect(p.a).toMatchObject({ nickname: "A", hasCursor: false, selection: [] });
    p = applyPresenceEvent(p, update("a", { hasCursor: true, cursorX: 4, cursorY: 5, selection: ["n1"] }));
    expect(p.a).toMatchObject({ hasCursor: true, cursorX: 4, cursorY: 5, selection: ["n1"] });
    expect(Object.keys(p)).toEqual(["a"]);
  });

  it("left toglie il peer, e un left sconosciuto non cambia l'oggetto", () => {
    let p = applyPresenceEvent({}, update("a"));
    p = applyPresenceEvent(p, update("b"));
    const after = applyPresenceEvent(p, left("a"));
    expect(Object.keys(after)).toEqual(["b"]);
    expect(applyPresenceEvent(after, left("zzz"))).toBe(after);
  });

  it("l'evento vuoto (il 'pronto' del server) non cambia nulla", () => {
    const p = applyPresenceEvent({}, update("a"));
    expect(applyPresenceEvent(p, create(PresenceEventSchema, {}))).toBe(p);
  });

  it("non muta l'oggetto di partenza", () => {
    const p: Peers = {};
    applyPresenceEvent(p, update("a"));
    expect(p).toEqual({});
  });
});

describe("peerColor", () => {
  it("è stabile per lo stesso id e diverso fra id diversi", () => {
    expect(peerColor("abc")).toBe(peerColor("abc"));
    expect(peerColor("abc")).not.toBe(peerColor("abd"));
    expect(peerColor("x")).toMatch(/^hsl\(\d+, 70%, 45%\)$/);
  });
});

describe("usePresence.clear", () => {
  it("su uno store già vuoto non notifica (altrimenti ridisegna la scena per niente)", async () => {
    const { usePresence } = await import("./presence");
    usePresence.setState({ peers: {} });
    let calls = 0;
    const unsub = usePresence.subscribe(() => { calls++; });
    usePresence.getState().clear();
    usePresence.getState().clear();
    expect(calls).toBe(0);
    usePresence.setState({ peers: { a: { clientId: "a", nickname: "A", hasCursor: false, cursorX: 0, cursorY: 0, pageId: "", selection: [] } } });
    calls = 0;
    usePresence.getState().clear();
    expect(calls).toBe(1);
    expect(usePresence.getState().peers).toEqual({});
    unsub();
  });
});
