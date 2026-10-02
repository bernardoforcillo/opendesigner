import { create } from "zustand";
import type { PresenceEvent } from "../gen/opendesigner/v1/opendesigner_pb";

// Chi altro sta guardando il documento. È stato di VISTA, come camera e
// selezione: non è documento, non passa dagli op e non entra nell'undo. Per
// questo sta in uno store a parte invece che dentro store/store.ts.
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

// Funzione pura, così si prova senza zustand: un evento "update" inserisce o
// rimpiazza il peer, "left" lo toglie, un evento VUOTO (il "pronto" del server)
// non cambia niente.
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
  clear: () => set({ peers: {} }),
}));

// Colore stabile di un client, ricavato dal suo id: ogni schermo lo calcola
// uguale senza che il server ne sappia niente. 137.5° è l'angolo aureo, che
// tiene lontani fra loro anche i colori di id vicini.
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
  } catch { /* storage non disponibile: si usa il default */ }
  return `Ospite ${Math.floor(100 + Math.random() * 900)}`;
}

export function saveNickname(n: string): void {
  try { localStorage.setItem(NICK_KEY, n); } catch { /* idem */ }
}
