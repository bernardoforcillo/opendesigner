import { create } from "zustand";
import type { Peers } from "./presence";

// FACILITATION: what a workshop needs on top of a shared canvas -- dot voting, a countdown, cursor
// chat and reactions, and following someone's view. Like the cursor it is EPHEMERAL: each person
// publishes their own part through presence (rpc/presence.ts) and everyone derives the rest, so
// there is no accounts, no server state and no document change. The price is honest and stated in
// docs/whiteboard.md: when someone leaves, their votes and their timer leave with them.

export const VOTES_PER_PERSON = 5;
export const CHAT_MAX = 140;
/** How long a chat message or reaction stays by the cursor (ms). */
export const EMOTE_MS = 6000;
export const REACTIONS = ["👍", "❤️", "🎉", "👀", "🤔"] as const;

export interface TimerLite { startedMs: number; endMs: number; label: string; owner: string }

interface Facilitation {
  /** My dots, one entry per dot. */
  votes: string[];
  votesPerPerson: number;
  timer: { startedMs: number; endMs: number; label: string } | null;
  chat: string;
  reaction: string;
  emoteSeq: number;
  /** Whose view I follow (a client id), or null. */
  following: string | null;

  vote: (nodeId: string) => void;
  unvote: (nodeId: string) => void;
  clearVotes: () => void;
  startTimer: (seconds: number, label?: string, now?: number) => void;
  stopTimer: () => void;
  say: (text: string) => void;
  react: (emoji: string) => void;
  follow: (clientId: string | null) => void;
}

export const useFacilitation = create<Facilitation>((set) => ({
  votes: [],
  votesPerPerson: VOTES_PER_PERSON,
  timer: null,
  chat: "",
  reaction: "",
  emoteSeq: 0,
  following: null,

  vote: (nodeId) => set((s) => (s.votes.length >= s.votesPerPerson ? s : { votes: [...s.votes, nodeId] })),
  unvote: (nodeId) =>
    set((s) => {
      const i = s.votes.lastIndexOf(nodeId);
      if (i < 0) return s;
      return { votes: [...s.votes.slice(0, i), ...s.votes.slice(i + 1)] };
    }),
  clearVotes: () => set((s) => (s.votes.length === 0 ? s : { votes: [] })),
  startTimer: (seconds, label = "", now = Date.now()) => {
    if (!(seconds > 0)) return;
    set({ timer: { startedMs: now, endMs: now + Math.round(seconds * 1000), label: label.slice(0, 40) } });
  },
  stopTimer: () => set({ timer: null }),
  say: (text) => {
    const t = text.trim().slice(0, CHAT_MAX);
    if (t === "") return;
    set((s) => ({ chat: t, reaction: "", emoteSeq: s.emoteSeq + 1 }));
  },
  react: (emoji) => set((s) => ({ reaction: emoji, chat: "", emoteSeq: s.emoteSeq + 1 })),
  follow: (clientId) => set((s) => (s.following === clientId ? s : { following: clientId })),
}));

/** Dots per node: mine plus everyone else's. */
export function tally(peers: Peers, mine: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (ids: readonly string[]) => { for (const id of ids) out[id] = (out[id] ?? 0) + 1; };
  add(mine);
  for (const p of Object.values(peers)) add(p.votes);
  return out;
}

/** The nodes ranked by dots, most first (ties keep the order they were first counted in). */
export function ranking(t: Record<string, number>): { id: string; votes: number }[] {
  return Object.entries(t).map(([id, votes]) => ({ id, votes })).sort((a, b) => b.votes - a.votes);
}

/**
 * The countdown everyone sees: the most recently started one among mine and the peers', as long as it has not
 * been over for more than `graceMs` (so the zero is seen).
 */
export function activeTimer(
  peers: Peers, mine: { startedMs: number; endMs: number; label: string } | null, now: number, graceMs = 8000, myId = "",
): TimerLite | null {
  const all: TimerLite[] = [];
  if (mine) all.push({ ...mine, owner: myId });
  for (const p of Object.values(peers)) {
    if (p.timerEndMs > 0) all.push({ startedMs: p.timerStartedMs, endMs: p.timerEndMs, label: p.timerLabel, owner: p.clientId });
  }
  const live = all.filter((t) => now < t.endMs + graceMs);
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.startedMs > a.startedMs ? b : a));
}

/** "m:ss" left on a timer (0:00 once it is over). */
export function formatRemaining(endMs: number, now: number): string {
  const s = Math.max(0, Math.ceil((endMs - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What to show next to a peer's cursor right now, if anything. */
export function emoteOf(p: { chat: string; reaction: string; emoteAt: number }, now: number): string {
  if (p.emoteAt <= 0 || now - p.emoteAt >= EMOTE_MS) return "";
  return p.reaction || p.chat;
}
