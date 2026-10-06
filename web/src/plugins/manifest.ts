// PLUGINS: a small script that runs in a sandbox and edits the document through a narrow API
// (plugins/api.ts). A plugin is a JSON file:
//
//   { "name": "Number the layers", "version": "1.0.0", "description": "...",
//     "permissions": ["read", "write"], "code": "const sel = await od.selection(); ..." }
//
// `code` is the BODY of an async function that receives `od`. Plugins are stored in the browser
// (like preferences) and never leave it: they are the person's tools, not part of the document.

export type Permission = "read" | "write";

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: Permission[];
  code: string;
}

export const MAX_CODE_BYTES = 200_000;
const PERMISSIONS: readonly Permission[] = ["read", "write"];

/** A plugin from JSON text, or the reason it is not one. */
export function parsePlugin(text: string, newId: () => string = () => crypto.randomUUID()): { plugin: Plugin } | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: "That is not valid JSON." }; }
  if (typeof raw !== "object" || raw === null) return { error: "A plugin is a JSON object." };
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (name === "" || name.length > 80) return { error: "A plugin needs a name (up to 80 characters)." };
  if (typeof o.code !== "string" || o.code.trim() === "") return { error: "A plugin needs `code`." };
  if (new Blob([o.code]).size > MAX_CODE_BYTES) return { error: "The plugin's code is too long." };
  const perms = o.permissions === undefined ? ["read"] : o.permissions;
  if (!Array.isArray(perms) || !perms.every((p): p is Permission => PERMISSIONS.includes(p as Permission))) {
    return { error: "`permissions` can only contain \"read\" and \"write\"." };
  }
  return {
    plugin: {
      id: newId(),
      name,
      version: typeof o.version === "string" ? o.version.slice(0, 20) : "0.0.0",
      description: typeof o.description === "string" ? o.description.slice(0, 300) : "",
      permissions: [...new Set(perms)],
      code: o.code,
    },
  };
}

const KEY = "od.plugins";

export function loadPlugins(): Plugin[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is Plugin => typeof p?.id === "string" && typeof p.code === "string" && typeof p.name === "string") : [];
  } catch { return []; }
}

export function savePlugins(list: readonly Plugin[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* no storage: plugins last for the session */ }
}

/** A plugin worth installing to see how it works. */
export const EXAMPLE_PLUGIN = {
  name: "Number the selection",
  version: "1.0.0",
  description: "Renames the selected layers 1, 2, 3 in the order they sit in the layers panel.",
  permissions: ["read", "write"],
  code: [
    "const ids = await od.selection();",
    "if (ids.length === 0) { od.notify('Select some layers first.'); return; }",
    "let i = 1;",
    "for (const id of ids) await od.setProps(id, { name: String(i++) });",
    "od.notify('Numbered ' + ids.length + ' layers.');",
  ].join("\n"),
};
