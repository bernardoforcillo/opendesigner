// THE APP ROUTING, in a pure function. The app has no router: the only
// navigation state is the URL hash.
//
//   (nothing)     -> Home: list of documents and templates
//   #new          -> Home, with the template gallery highlighted
//   #doc=<uuid>   -> the editor on that document (the link to share)
//
// A hash that is not recognized means Home: better to show your own documents than
// an editor on an id that HubFor would reject anyway.

export type Route = { kind: "home"; focusTemplates: boolean } | { kind: "doc"; id: string };

// A malformed id is ignored (HubFor would reject it anyway); the allowed
// characters are those of a UUID, so no `../` in the hash.
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

// A UUID on its own, or inside a text (the whole link, "#doc=...").
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * What gets pasted into the "Join" field: the full link copied from
 * "Share" (http://192.168.1.5:8080/#doc=...), just the hash or the bare id. If
 * there is a link the id is read from ITS hash (`#doc=`), not from any UUID in the
 * path. Returns the id in lowercase or null.
 */
export function parseJoinLink(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const marker = text.indexOf("#doc=");
  const candidate = marker >= 0 ? text.slice(marker + "#doc=".length) : text;
  const m = UUID_RE.exec(candidate);
  if (!m) return null;
  // Without the marker the text must be ONLY the id; with the marker the id
  // follows right after `#doc=`.
  if (marker < 0 && m[0].length !== text.length) return null;
  if (marker >= 0 && m.index !== 0) return null;
  return m[0].toLowerCase();
}

const MIN = 60, HOUR = 3600, DAY = 86400;

/** "now", "5 min ago", "2 hours ago", "yesterday", "3 days ago", then the date. */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!unixSeconds) return "—";
  const diff = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (diff < 45) return "now";
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MIN))} min ago`;
  if (diff < DAY) { const h = Math.round(diff / HOUR); return h === 1 ? "1 hour ago" : `${h} hours ago`; }
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

/** Most recent documents first; on a tie, by name (total and stable order). */
export function sortRecent<T extends { updatedAt: bigint | number; name: string; id: string }>(docs: readonly T[]): T[] {
  return docs.slice().sort((a, b) => {
    const d = Number(b.updatedAt) - Number(a.updatedAt);
    return d !== 0 ? d : a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
