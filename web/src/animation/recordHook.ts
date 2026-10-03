import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { PropChange } from "./timelineLogic";

// IL GANCIO DELLA REGISTRAZIONE.
//
// Con la clip aperta e "Registra" acceso, modificare x, y, rotazione o opacità di
// un nodo non cambia il nodo: scrive un keyframe nella clip al playhead. Chi
// modifica un nodo -- il trascinamento e la rotazione sulla tela (tools/
// selectTool.ts), i campi e il cursore dell'opacità del pannello Proprietà
// (ui/PropertiesPanel.tsx), la tastiera -- lo fa sempre per le stesse DUE porte
// dello store: `applyLocal(op)` per l'anteprima a ogni passo, `endGesture(ops)`
// per il rilascio. Il gancio sta lì, e solo lì: nessun tool sa che esiste la
// registrazione, e a registrazione spenta le due funzioni sono l'identità (il
// gancio è null: `recordPreview` torna false, `recordFinal` restituisce lo
// STESSO array).
//
// Il modulo non importa niente dallo store (lo importa lo store): chi registra
// il gancio è animation/timelineStore.ts.

export interface RecordHook {
  /** Anteprima: vero = l'op è stato assorbito (nella bozza), la scena NON va toccata. */
  preview(op: Op): boolean;
  /** Rilascio: gli op da mandare davvero al posto di `ops` (la bozza si chiude). */
  final(ops: Op[]): Op[];
}

let hook: RecordHook | null = null;

export function setRecordHook(h: RecordHook | null): void {
  hook = h;
}

export function recordPreview(op: Op): boolean {
  return hook ? hook.preview(op) : false;
}

export function recordFinal(ops: Op[]): Op[] {
  return hook ? hook.final(ops) : ops;
}

// Le proprietà del nodo che la registrazione sa tradurre in tracce, col nome del
// campo nel mask di `setProps` e nella traccia.
const RECORDABLE = new Set(["x", "y", "rotation", "opacity"]);

/**
 * Le modifiche di proprietà animabili portate da `ops`, o null se anche UN solo
 * op non è registrabile (non è un `setProps`, o la sua mask tocca altro oltre a
 * x, y, rotation, opacity -- un ridimensionamento, un colore). Tutto o niente:
 * un gesto misto (resize + spostamento) NON si registra a pezzi, passa com'è.
 */
export function propChangesOfOps(ops: readonly Op[]): PropChange[] | null {
  if (ops.length === 0) return null;
  const out: PropChange[] = [];
  for (const op of ops) {
    if (op.kind.case !== "setProps") return null;
    const { id, patch, mask } = op.kind.value;
    const paths = mask?.paths ?? [];
    if (paths.length === 0 || !patch || !paths.every((p) => RECORDABLE.has(p))) return null;
    for (const p of paths) out.push({ nodeId: id, prop: p, value: patch[p as "x" | "y" | "rotation" | "opacity"] });
  }
  return out;
}
