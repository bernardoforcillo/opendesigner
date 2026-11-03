// THE OBJECT LIBRARY: named snippets (tools/objectTools.ts::exportSnippet) kept in this browser and
// shared by every document opened in it, so a logo or a callout made in one document is placed in
// another. It is stored in localStorage: it is NOT synced across browsers or users (docs/object-tools.md).

const KEY = "opendesigner.objectLibrary.v1";
export const MAX_ITEMS = 200;
/** A snippet above this many characters is refused (the store holds a few MB per origin). */
export const MAX_SNIPPET_CHARS = 500_000;

export interface LibraryItem { id: string; name: string; snippet: string; createdAt: number }

function storageOf(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Every item, oldest first; an unreadable or foreign value reads as an empty library. */
export function loadLibrary(storage: Storage | null = storageOf()): LibraryItem[] {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is LibraryItem =>
      !!x && typeof x.id === "string" && typeof x.name === "string" && typeof x.snippet === "string" && typeof x.createdAt === "number");
  } catch {
    return [];
  }
}

function persist(items: LibraryItem[], storage: Storage | null): string | null {
  if (!storage) return "the browser storage is not available";
  try {
    storage.setItem(KEY, JSON.stringify(items));
    return null;
  } catch {
    return "the browser storage is full or blocked";
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The item with this id, or this name (ignoring case). */
export function findItem(items: readonly LibraryItem[], nameOrId: string): LibraryItem | undefined {
  return items.find((i) => i.id === nameOrId) ?? items.find((i) => same(i.name, nameOrId));
}

/** Adds an item; one with the same name is replaced (it keeps its id). Returns the item, or an error message. */
export function saveItem(name: string, snippet: string, storage: Storage | null = storageOf(), now = Date.now()): LibraryItem | string {
  const n = name.trim();
  if (n === "") return "name is required";
  if (snippet.length > MAX_SNIPPET_CHARS) return "the snippet is too large for the library";
  const items = loadLibrary(storage);
  const old = items.find((i) => same(i.name, n));
  if (!old && items.length >= MAX_ITEMS) return `the library holds at most ${MAX_ITEMS} items`;
  const item: LibraryItem = { id: old?.id ?? `lib${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, name: n, snippet, createdAt: now };
  const err = persist(old ? items.map((i) => (i === old ? item : i)) : [...items, item], storage);
  return err ?? item;
}

/** Removes the item with this id or name. Returns whether there was one, or an error message. */
export function removeItem(nameOrId: string, storage: Storage | null = storageOf()): boolean | string {
  const items = loadLibrary(storage);
  const hit = findItem(items, nameOrId);
  if (!hit) return false;
  const err = persist(items.filter((i) => i !== hit), storage);
  return err ?? true;
}
