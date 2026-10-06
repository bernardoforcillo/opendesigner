// THE APP ROUTING, as pure helpers (the router itself lives in router.tsx).
//
//   /                  -> Home: list of documents and templates
//   /?templates=true   -> Home, with the template gallery highlighted
//   /doc/<uuid>        -> the editor on that document (the link to share)
//
// Links from before the router (`#doc=<uuid>`, `#new`) are still understood and
// are redirected to the paths above (see legacyRedirect). An id that is not
// valid means Home: better to show your own documents than an editor on an id
// that HubFor would reject anyway.

// A malformed id is ignored (HubFor would reject it anyway); the allowed
// characters are those of a UUID, so no `../` in the path.
const DOC_ID_RE = /^[0-9a-fA-F-]{36}$/;
const LEGACY_HASH_RE = /^#?doc=([0-9a-fA-F-]{36})$/;

/** The id if `id` is a well-formed document id (lowercased), else null. */
export function normalizeDocId(id: string): string | null {
  return DOC_ID_RE.test(id) ? id.toLowerCase() : null;
}

/** The id of a legacy `#doc=<id>` hash, or null. */
export function docIdFromHash(hash: string): string | null {
  const m = LEGACY_HASH_RE.exec(hash);
  return m ? m[1].toLowerCase() : null;
}

/** Where an old-style hash link points to in the path-based router, or null. */
export function legacyRedirect(hash: string): { to: "/doc/$docId"; params: { docId: string } } | { to: "/"; search: { templates: true } } | null {
  const id = docIdFromHash(hash);
  if (id) return { to: "/doc/$docId", params: { docId: id } };
  if (hash === "#new" || hash === "new") return { to: "/", search: { templates: true } };
  return null;
}

export const pathForDoc = (id: string): string => `/doc/${id}`;
export const HOME_TEMPLATES_PATH = "/?templates=true";

// A UUID on its own, or inside a text (the whole link, "#doc=...").
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * What gets pasted into the "Join" field: the full link copied from
 * "Share" (http://192.168.1.5:8080/doc/...), an old `#doc=` link, just the
 * path or the bare id. If there is a link the id is read from the `/doc/`
 * segment (or the legacy `#doc=` hash), not from any other UUID in the text.
 * Returns the id in lowercase or null.
 */
export function parseJoinLink(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  for (const marker of ["/doc/", "#doc="]) {
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const m = UUID_RE.exec(text.slice(at + marker.length));
    // The id must follow right after the marker.
    return m && m.index === 0 ? m[0].toLowerCase() : null;
  }
  // Without a marker the text must be ONLY the id.
  const m = UUID_RE.exec(text);
  return m && m[0].length === text.length ? m[0].toLowerCase() : null;
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
