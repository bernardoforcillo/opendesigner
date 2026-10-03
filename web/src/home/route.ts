// IL ROUTING DELL'APP, in una funzione pura. L'app non ha un router: l'unico
// stato di navigazione è l'hash dell'URL.
//
//   (niente)      -> Home: elenco dei documenti e template
//   #new          -> Home, con la galleria dei template in evidenza
//   #doc=<uuid>   -> l'editor su quel documento (il link da condividere)
//
// Un hash che non si riconosce vale Home: meglio mostrare i propri documenti che
// un editor su un id che HubFor rifiuterebbe comunque.

export type Route = { kind: "home"; focusTemplates: boolean } | { kind: "doc"; id: string };

// Un id non ben formato si ignora (HubFor lo rifiuterebbe comunque); i
// caratteri ammessi sono quelli di un UUID, quindi niente `../` nell'hash.
const DOC_HASH_RE = /^#doc=([0-9a-fA-F-]{36})$/;

export function docIdFromHash(hash: string): string | null {
  const m = DOC_HASH_RE.exec(hash);
  return m ? m[1].toLowerCase() : null;
}

export function routeFromHash(hash: string): Route {
  const id = docIdFromHash(hash);
  if (id) return { kind: "doc", id };
  return { kind: "home", focusTemplates: hash === "#new" };
}

export const hashForDoc = (id: string): string => `#doc=${id}`;

// Un UUID da solo, oppure dentro un testo (il link intero, "#doc=...").
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * Ciò che si incolla nel campo "Unisciti": il link completo copiato da
 * "Condividi" (http://192.168.1.5:8080/#doc=...), solo l'hash o l'id nudo. Se
 * c'è un link si legge l'id dal SUO hash (`#doc=`), non da un UUID qualunque nel
 * percorso. Ritorna l'id in minuscolo oppure null.
 */
export function parseJoinLink(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const marker = text.indexOf("#doc=");
  const candidate = marker >= 0 ? text.slice(marker + "#doc=".length) : text;
  const m = UUID_RE.exec(candidate);
  if (!m) return null;
  // Senza il marcatore il testo deve essere SOLO l'id; col marcatore l'id
  // segue subito il `#doc=`.
  if (marker < 0 && m[0].length !== text.length) return null;
  if (marker >= 0 && m.index !== 0) return null;
  return m[0].toLowerCase();
}

const MIN = 60, HOUR = 3600, DAY = 86400;

/** "adesso", "5 min fa", "2 ore fa", "ieri", "3 giorni fa", poi la data. */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!unixSeconds) return "—";
  const diff = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (diff < 45) return "adesso";
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MIN))} min fa`;
  if (diff < DAY) { const h = Math.round(diff / HOUR); return h === 1 ? "1 ora fa" : `${h} ore fa`; }
  if (diff < 2 * DAY) return "ieri";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} giorni fa`;
  return new Date(unixSeconds * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
}

/** Documenti più recenti per primi; a parità, per nome (ordine totale e stabile). */
export function sortRecent<T extends { updatedAt: bigint | number; name: string; id: string }>(docs: readonly T[]): T[] {
  return docs.slice().sort((a, b) => {
    const d = Number(b.updatedAt) - Number(a.updatedAt);
    return d !== 0 ? d : a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
