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
}

export type Peers = Record<string, PeerLite>;

// Pure function, so it can be tested without zustand: an "update" event inserts or
// replaces the peer, "left" removes it, an EMPTY event (the server's "ready") does
// not change anything.
export function applyPresenceEvent(peers: Peers, ev: PresenceEvent): Peers {
  const k = ev.kind;
  if (k.case === "update") {
    const u = k.value;
    if (u.clientId === "") return peers;
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
