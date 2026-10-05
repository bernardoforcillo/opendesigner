// THE PER-DOCUMENT PREFERENCES of the onboarding, in the browser's localStorage:
// the closed card and the two steps the document cannot tell on its own
// (prototype opened, code exported). They are per-user conveniences: they do not
// travel to other collaborators and it is fine if they get lost.

export interface DocPrefs {
  dismissed: boolean;
  presented: boolean;
  shipped: boolean;
}

const NONE: DocPrefs = { dismissed: false, presented: false, shipped: false };
const key = (docId: string) => `opendesigner.onboarding.${docId}`;

export function loadDocPrefs(docId: string): DocPrefs {
  try {
    const raw = localStorage.getItem(key(docId));
    if (!raw) return NONE;
    const v = JSON.parse(raw) as Partial<DocPrefs>;
    return { dismissed: v.dismissed === true, presented: v.presented === true, shipped: v.shipped === true };
  } catch {
    return NONE;
  }
}

export function saveDocPrefs(docId: string, patch: Partial<DocPrefs>): DocPrefs {
  const next = { ...loadDocPrefs(docId), ...patch };
  try {
    localStorage.setItem(key(docId), JSON.stringify(next));
  } catch {
    /* storage unavailable: the preference holds for this session */
  }
  return next;
}

/**
 * The event by which the rest of the app says "this document's code
 * has been exported" (Develop mode emits it after the zip): it ticks off
 * the last checklist step without the two parts importing each other.
 */
export const SHIPPED_EVENT = "opendesigner:shipped";
