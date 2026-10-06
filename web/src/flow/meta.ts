import type { NodeLite } from "../store/types";

// THE SCREEN METADATA CONVENTIONS (Node.meta, see proto). The model
// keeps them as a free string -> string map; here we say WHAT the
// known keys mean, in one place, because they are read by the renderer (badge), the
// panel (editor) and the prototype.

export const META_KEYS = {
  kind: "flow.kind",
  route: "code.route",
  component: "code.component",
  testId: "test.id",
  testText: "test.text",
  status: "status",
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

export const FLOW_KINDS = ["screen", "decision", "action", "start", "end", "note"] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export const FLOW_KIND_LABELS: Record<FlowKind, string> = {
  screen: "Screen",
  decision: "Decision",
  action: "Action",
  start: "Start",
  end: "End",
  note: "Note",
};

export const STATUSES = ["planned", "implemented", "tested"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  planned: "Planned",
  implemented: "Implemented",
  tested: "Tested",
};

// Gray / blue / green: from "not done" to "verified".
export const STATUS_COLORS: Record<Status, string> = {
  planned: "#9ca3af",
  implemented: "#2f6fed",
  tested: "#16a34a",
};

export function kindOf(n: NodeLite | undefined): FlowKind {
  const v = n?.meta?.[META_KEYS.kind];
  return (FLOW_KINDS as readonly string[]).includes(v ?? "") ? (v as FlowKind) : "screen";
}

export function statusOf(n: NodeLite | undefined): Status {
  const v = n?.meta?.[META_KEYS.status];
  return (STATUSES as readonly string[]).includes(v ?? "") ? (v as Status) : "planned";
}

export function metaValue(n: NodeLite | undefined, key: MetaKey): string {
  return n?.meta?.[key] ?? "";
}

/**
 * The COMPLETE meta map after writing `key = value`. It is needed because the "meta"
 * mask of setProps REPLACES the whole map: writing a single key
 * would erase the others (including those of other tools). An empty value
 * REMOVES the key -- "unset" and "set to empty" are the same thing
 * for all readers, and a map full of empty strings is just noise.
 */
export function withMeta(n: NodeLite, key: string, value: string): Record<string, string> {
  const next: Record<string, string> = { ...(n.meta ?? {}) };
  if (value.trim() === "") delete next[key];
  else next[key] = value;
  return next;
}
