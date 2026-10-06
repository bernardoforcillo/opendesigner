import { beforeEach, describe, expect, it } from "vitest";
import { activeTimer, emoteOf, formatRemaining, ranking, tally, useFacilitation, VOTES_PER_PERSON } from "./facilitation";
import { newPeer } from "./presence";

beforeEach(() => useFacilitation.setState({ votes: [], timer: null, chat: "", reaction: "", emoteSeq: 0, following: null }));

describe("voting", () => {
  it("gives each person a fixed number of dots, which can be taken back", () => {
    const f = useFacilitation.getState();
    for (let i = 0; i < VOTES_PER_PERSON + 3; i++) f.vote("a");
    expect(useFacilitation.getState().votes).toHaveLength(VOTES_PER_PERSON);
    f.unvote("a");
    expect(useFacilitation.getState().votes).toHaveLength(VOTES_PER_PERSON - 1);
    f.unvote("zzz");
    expect(useFacilitation.getState().votes).toHaveLength(VOTES_PER_PERSON - 1);
    f.clearVotes();
    expect(useFacilitation.getState().votes).toEqual([]);
  });

  it("counts mine and everyone else's, and ranks them", () => {
    const peers = { p: newPeer("p", "P", { votes: ["a", "b", "b"] }), q: newPeer("q", "Q", { votes: ["b"] }) };
    const t = tally(peers, ["a"]);
    expect(t).toEqual({ a: 2, b: 3 });
    expect(ranking(t).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("timer", () => {
  it("shows the most recently started one, until a few seconds after it ends", () => {
    const peers = { p: newPeer("p", "P", { timerStartedMs: 1000, timerEndMs: 61000, timerLabel: "Ideas" }) };
    expect(activeTimer(peers, null, 30000)?.label).toBe("Ideas");
    const mine = { startedMs: 2000, endMs: 12000, label: "Quick" };
    expect(activeTimer(peers, mine, 5000, 8000, "me")).toMatchObject({ label: "Quick", owner: "me" });
    expect(activeTimer({}, mine, 12000 + 7000)).not.toBeNull();
    expect(activeTimer({}, mine, 12000 + 9000)).toBeNull();
  });

  it("starts from the clock it is given and ignores a non-positive length", () => {
    useFacilitation.getState().startTimer(90, "Retro", 5000);
    expect(useFacilitation.getState().timer).toEqual({ startedMs: 5000, endMs: 95000, label: "Retro" });
    useFacilitation.getState().stopTimer();
    useFacilitation.getState().startTimer(0);
    expect(useFacilitation.getState().timer).toBeNull();
  });

  it("formats what is left as m:ss", () => {
    expect(formatRemaining(61000, 0)).toBe("1:01");
    expect(formatRemaining(1000, 5000)).toBe("0:00");
  });
});

describe("chat and reactions", () => {
  it("each message bumps the sequence, even if it is the same text, and a reaction replaces chat", () => {
    const f = useFacilitation.getState();
    f.say("hello");
    f.say("hello");
    expect(useFacilitation.getState()).toMatchObject({ chat: "hello", emoteSeq: 2 });
    f.say("   ");
    expect(useFacilitation.getState().emoteSeq).toBe(2);
    f.react("🎉");
    expect(useFacilitation.getState()).toMatchObject({ chat: "", reaction: "🎉", emoteSeq: 3 });
  });

  it("shows a peer's message for a few seconds only", () => {
    const p = { chat: "look here", reaction: "", emoteAt: 1000 };
    expect(emoteOf(p, 2000)).toBe("look here");
    expect(emoteOf(p, 8000)).toBe("");
    expect(emoteOf({ ...p, emoteAt: 0 }, 2000)).toBe("");
    expect(emoteOf({ ...p, reaction: "👍" }, 2000)).toBe("👍");
  });
});
