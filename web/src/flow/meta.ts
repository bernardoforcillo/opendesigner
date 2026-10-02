import type { NodeLite } from "../store/types";

// LE CONVENZIONI DEI METADATI DI SCHERMATA (Node.meta, vedi proto). Il modello
// li conserva come mappa libera stringa -> stringa; qui si dice COSA significano
// le chiavi note, in un posto solo, perché le leggono il renderer (badge), il
// pannello (editor) e il prototipo.

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
  screen: "Schermata",
  decision: "Decisione",
  action: "Azione",
  start: "Inizio",
  end: "Fine",
  note: "Nota",
};

export const STATUSES = ["planned", "implemented", "tested"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  planned: "Pianificata",
  implemented: "Implementata",
  tested: "Testata",
};

// Grigio / blu / verde: dal "non fatto" al "verificato".
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
 * La mappa meta COMPLETA dopo aver scritto `key = value`. Serve perché la mask
 * "meta" di setProps SOSTITUISCE l'intera mappa: scrivere una chiave sola
 * cancellerebbe le altre (comprese quelle di altri strumenti). Un valore vuoto
 * TOGLIE la chiave -- "non impostato" e "impostato a vuoto" sono la stessa cosa
 * per tutti i lettori, e una mappa piena di stringhe vuote è solo rumore.
 */
export function withMeta(n: NodeLite, key: string, value: string): Record<string, string> {
  const next: Record<string, string> = { ...(n.meta ?? {}) };
  if (value.trim() === "") delete next[key];
  else next[key] = value;
  return next;
}
