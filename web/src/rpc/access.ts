import { create } from "zustand";

// ACCESS LINKS, client side. A protected document is opened from a link with `?k=<token>`: the
// token is kept in this browser (per document), removed from the address bar, and sent with
// every request (Authorization: Bearer) and on image URLs (?k=). The server decides what it
// allows; `role` here is only what the interface uses to hide what would be refused.

const KEY = (docId: string) => `od.link.${docId}`;

export type Role = "open" | "owner" | "edit" | "comment" | "view";

export function storedToken(docId: string): string {
  try { return localStorage.getItem(KEY(docId)) ?? ""; } catch { return ""; }
}

export function storeToken(docId: string, token: string): void {
  try {
    if (token === "") localStorage.removeItem(KEY(docId)); else localStorage.setItem(KEY(docId), token);
  } catch { /* no storage: the link works until the tab closes */ }
}

// The document the editor is on: requests carry ITS token (a token is only good for its own document).
let activeDoc = "";
let sessionToken = "";
export function setActiveDoc(docId: string): void {
  activeDoc = docId;
  sessionToken = storedToken(docId);
}
export function activeToken(): string {
  return activeDoc === "" ? "" : sessionToken || storedToken(activeDoc);
}
/** For a request about `docId`: its token, if it is the document the editor is on or one we hold. */
export function tokenFor(docId: string): string {
  return docId === activeDoc ? activeToken() : storedToken(docId);
}

/**
 * Takes the link token from the address (?k=...), keeps it for this document and removes it from the
 * URL so it is not copied by accident. Returns the token that applies to the document.
 */
export function captureLinkToken(docId: string, loc: Location = location, hist: History = history): string {
  const params = new URLSearchParams(loc.search);
  const k = params.get("k");
  if (k) {
    storeToken(docId, k);
    params.delete("k");
    const rest = params.toString();
    hist.replaceState(hist.state, "", loc.pathname + (rest ? `?${rest}` : "") + loc.hash);
  }
  setActiveDoc(docId);
  return storedToken(docId);
}

/** A link to `docId` that carries `token`. */
export function shareUrl(docId: string, token: string, origin = location.origin): string {
  return `${origin}/doc/${encodeURIComponent(docId)}?k=${encodeURIComponent(token)}`;
}

interface AccessStore {
  role: Role | null;
  setRole: (r: Role | null) => void;
}

/** What this person may do in the open document (null until known). */
export const useAccess = create<AccessStore>((set) => ({ role: null, setRole: (role) => set({ role }) }));

export const canWrite = (role: Role | null) => role === null || role === "open" || role === "owner" || role === "edit";
export const canComment = (role: Role | null) => canWrite(role) || role === "comment";
