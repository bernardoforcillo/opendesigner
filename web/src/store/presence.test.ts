import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { PresenceEventSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyPresenceEvent, newPeer, peerColor, type Peers } from "./presence";

const update = (clientId: string, over: Record<string, unknown> = {}) =>
  create(PresenceEventSchema, {
    kind: { case: "update", value: { clientId, nickname: clientId.toUpperCase(), ...over } },
  } as never);
const left = (id: string) => create(PresenceEventSchema, { kind: { case: "leftClientId", value: id } } as never);

describe("applyPresenceEvent", () => {
  it("an update inserts the peer and a second one replaces it", () => {
    let p: Peers = {};
    p = applyPresenceEvent(p, update("a"));
    expect(p.a).toMatchObject({ nickname: "A", hasCursor: false, selection: [] });
    p = applyPresenceEvent(p, update("a", { hasCursor: true, cursorX: 4, cursorY: 5, selection: ["n1"] }));
    expect(p.a).toMatchObject({ hasCursor: true, cursorX: 4, cursorY: 5, selection: ["n1"] });
    expect(Object.keys(p)).toEqual(["a"]);
  });

  it("left removes the peer, and an unknown left does not change the object", () => {
    let p = applyPresenceEvent({}, update("a"));
    p = applyPresenceEvent(p, update("b"));
    const after = applyPresenceEvent(p, left("a"));
    expect(Object.keys(after)).toEqual(["b"]);
    expect(applyPresenceEvent(after, left("zzz"))).toBe(after);
  });

  it("the empty event (the server's 'ready') changes nothing", () => {
    const p = applyPresenceEvent({}, update("a"));
    expect(applyPresenceEvent(p, create(PresenceEventSchema, {}))).toBe(p);
  });

  it("does not mutate the starting object", () => {
    const p: Peers = {};
    applyPresenceEvent(p, update("a"));
    expect(p).toEqual({});
  });
});

describe("peerColor", () => {
  it("is stable for the same id and different across different ids", () => {
    expect(peerColor("abc")).toBe(peerColor("abc"));
    expect(peerColor("abc")).not.toBe(peerColor("abd"));
    expect(peerColor("x")).toMatch(/^hsl\(\d+, 70%, 45%\)$/);
  });
});

describe("usePresence.clear", () => {
  it("on an already empty store it does not notify (otherwise it redraws the scene for nothing)", async () => {
    const { usePresence } = await import("./presence");
    usePresence.setState({ peers: {} });
    let calls = 0;
    const unsub = usePresence.subscribe(() => { calls++; });
    usePresence.getState().clear();
    usePresence.getState().clear();
    expect(calls).toBe(0);
    usePresence.setState({ peers: { a: newPeer("a", "A") } });
    calls = 0;
    usePresence.getState().clear();
    expect(calls).toBe(1);
    expect(usePresence.getState().peers).toEqual({});
    unsub();
  });
});
