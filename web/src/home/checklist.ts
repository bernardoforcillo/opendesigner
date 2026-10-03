import type { SceneState } from "../store/types";
import { isPageRoot, isScreenNode } from "../flow/screens";
import { META_KEYS } from "../flow/meta";

// LA CHECKLIST DI PARTENZA: quattro passi che coincidono con il percorso del
// prodotto (Design · Flussi · Prova · Sviluppo). Si SPUNTA DA SOLA guardando il
// documento -- non c'è un "segna come fatto" da ricordarsi di premere.

export type StepId = "draw" | "connect" | "present" | "ship";

export interface ChecklistStep {
  id: StepId;
  label: string;
  /** Una riga che dice cosa fare e con quale tasto. */
  hint: string;
  done: boolean;
}

/**
 * Ciò che il documento da solo non può dire: se il prototipo è stato aperto e se
 * il codice è stato portato fuori. Si ricorda per documento (docPrefs.ts).
 */
export interface ChecklistFlags {
  presented: boolean;
  shipped: boolean;
}

/** Le schermate: i frame di primo livello di una qualunque pagina. */
export function screenNodes(scene: SceneState | null) {
  if (!scene) return [];
  return [...scene.nodes.values()].filter((n) => isScreenNode(n) && isPageRoot(scene, n));
}

export function checklistSteps(scene: SceneState | null, flags: ChecklistFlags): ChecklistStep[] {
  const screens = screenNodes(scene);
  const transitions = scene ? Object.keys(scene.transitions).length : 0;
  // "Spedisci" è fatto quando il codice è uscito (evento di export) OPPURE
  // quando ogni schermata ha lasciato lo stato "planned": è il segnale che il
  // lavoro è stato consegnato anche se l'export l'ha fatto un altro.
  const allImplemented = screens.length > 0 && screens.every((n) => (n.meta?.[META_KEYS.status] ?? "planned") !== "planned");
  return [
    { id: "draw", label: "Disegna", hint: "Una schermata: tasto A, poi trascina sulla tavola.", done: screens.length > 0 },
    { id: "connect", label: "Collega", hint: "Unisci due schermate con una freccia: tasto K.", done: transitions > 0 },
    { id: "present", label: "Presenta", hint: "Prova il prototipo: Presenta, in modalità Flussi.", done: flags.presented },
    { id: "ship", label: "Spedisci", hint: "Porta a casa il codice: la modalità Sviluppo.", done: flags.shipped || allImplemented },
  ];
}

export function isChecklistComplete(steps: readonly ChecklistStep[]): boolean {
  return steps.every((s) => s.done);
}

/** Quale scheda mostrare: la grande ("Da dove parti?"), la compatta, o nessuna. */
export function onboardingMode(scene: SceneState | null, dismissed: boolean, steps: readonly ChecklistStep[]): "empty" | "progress" | "none" {
  if (!scene || dismissed) return "none";
  // La scheda grande solo su una tavola DAVVERO vuota: chi ha importato un SVG o
  // disegnato una forma sta già lavorando, anche senza una schermata.
  if (scene.nodes.size === 0) return "empty";
  return isChecklistComplete(steps) ? "none" : "progress";
}
