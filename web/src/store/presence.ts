import { create } from "zustand";
import type { PresenceEvent } from "../gen/opendesigner/v1/opendesigner_pb";

// Who else is looking at the document. It is VIEW state, like camera and
// selection: not document, does not go through ops and does not enter undo. For
// this reason it lives in a separate store instead of inside store/store.ts.
export interface PeerLite {
  clientId: string;
  nickname: string;
  hasCursor: boolean;
  cursorX: number;
  cursorY: number;
  pageId: string;
  selection: string[];
  // Facilitation (see store/facilitation.ts): the camera, cursor chat, a reaction, votes and a timer.
  hasView: boolean;
  viewX: number;
  viewY: number;
  viewZoom: number;
  chat: string;
  reaction: string;
  emoteSeq: number;
  /** When THIS client saw chat/reaction change (ms): they show for a few seconds from then. */
  emoteAt: number;
  votes: string[];
  timerStartedMs: number;
  timerEndMs: number;
  timerLabel: string;
}

/** A peer with nothing set but who it is: what tests and the first sight of someone start from. */
export function newPeer(clientId: string, nickname: string, over: Partial<PeerLite> = {}): PeerLite {
  return {
    clientId, nickname, hasCursor: false, cursorX: 0, cursorY: 0, pageId: "", selection: [],
    hasView: false, viewX: 0, viewY: 0, viewZoom: 1, chat: "", reaction: "", emoteSeq: 0, emoteAt: 0,
    votes: [], timerStartedMs: 0, timerEndMs: 0, timerLabel: "", ...over,
  };
}

export type Peers = Record<string, PeerLite>;

// Pure function, so it can be tested without zustand: an "update" event inserts or
// replaces the peer, "left" removes it, an EMPTY event (the server's "ready") does
// not change anything.
export function applyPresenceEvent(peers: Peers, ev: PresenceEvent, now: number = Date.now()): Peers {
  const k = ev.kind;
  if (k.case === "update") {
    const u = k.value;
    if (u.clientId === "") return peers;
    const prev = peers[u.clientId];
    const emoteAt = u.emoteSeq === 0 ? 0 : prev && prev.emoteSeq === u.emoteSeq ? prev.emoteAt : now;
    return {
      ...peers,
      [u.clientId]: {
        clientId: u.clientId,
        nickname: u.nickname,
        hasCursor: u.hasCursor,
        cursorX: u.cursorX,
        cursorY: u.cursorY,
        pageId: u.pageId,
        selection: [...u.selection],
        hasView: u.hasView,
        viewX: u.viewX,
        viewY: u.viewY,
        viewZoom: u.viewZoom,
        chat: u.chat,
        reaction: u.reaction,
        emoteSeq: u.emoteSeq,
        // A new sequence number is a new message; the same one is the cursor moving.
        emoteAt,
        votes: [...u.votes],
        timerStartedMs: Number(u.timerStartedMs),
        timerEndMs: Number(u.timerEndMs),
        timerLabel: u.timerLabel,
      },
    };
  }
  if (k.case === "leftClientId") {
    if (!(k.value in peers)) return peers;
    const next = { ...peers };
    delete next[k.value];
    return next;
  }
  return peers;
}

interface PresenceStore {
  peers: Peers;
  apply: (ev: PresenceEvent) => void;
  clear: () => void;
}

export const usePresence = create<PresenceStore>((set) => ({
  peers: {},
  apply: (ev) => set((s) => {
    const next = applyPresenceEvent(s.peers, ev);
    return next === s.peers ? s : { peers: next };
  }),
  // Already empty: no notification. The presence channel calls it on every failed
  // connection attempt, and a store that notifies for nothing makes the scene redraw.
  clear: () => set((s) => (Object.keys(s.peers).length === 0 ? s : { peers: {} })),
}));

// Stable color for a client, derived from its id: every screen computes it
// the same way without the server knowing anything about it. 137.5° is the golden angle, which
// keeps even the colors of nearby ids far from each other.
export function peerColor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return `hsl(${Math.round((h * 137.5) % 360)}, 70%, 45%)`;
}

const NICK_KEY = "opendesigner.nickname";

export function loadNickname(): string {
  try {
    const saved = localStorage.getItem(NICK_KEY);
    if (saved && saved.trim() !== "") return saved;
  } catch { /* storage unavailable: use the default */ }
  return `Guest ${Math.floor(100 + Math.random() * 900)}`;
}

export function saveNickname(n: string): void {
  try { localStorage.setItem(NICK_KEY, n); } catch { /* idem */ }
}
