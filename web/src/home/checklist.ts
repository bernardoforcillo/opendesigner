import type { SceneState } from "../store/types";
import { isPageRoot, isScreenNode } from "../flow/screens";
import { META_KEYS } from "../flow/meta";

// THE STARTER CHECKLIST: four steps that match the product's
// journey (Design · Flows · Try · Develop). It TICKS ITSELF OFF by looking at the
// document -- there is no "mark as done" to remember to press.

export type StepId = "draw" | "connect" | "present" | "ship";

export interface ChecklistStep {
  id: StepId;
  label: string;
  /** A line saying what to do and with which key. */
  hint: string;
  done: boolean;
}

/**
 * What the document alone cannot say: whether the prototype was opened and whether
 * the code was taken out. It is remembered per document (docPrefs.ts).
 */
export interface ChecklistFlags {
  presented: boolean;
  shipped: boolean;
}

/** The screens: the top-level frames of any page. */
export function screenNodes(scene: SceneState | null) {
  if (!scene) return [];
  return [...scene.nodes.values()].filter((n) => isScreenNode(n) && isPageRoot(scene, n));
}

export function checklistSteps(scene: SceneState | null, flags: ChecklistFlags): ChecklistStep[] {
  const screens = screenNodes(scene);
  const transitions = scene ? Object.keys(scene.transitions).length : 0;
  // "Ship" is done when the code has gone out (export event) OR
  // when every screen has left the "planned" state: it is the signal that the
  // work was delivered even if someone else did the export.
  const allImplemented = screens.length > 0 && screens.every((n) => (n.meta?.[META_KEYS.status] ?? "planned") !== "planned");
  return [
    { id: "draw", label: "Draw", hint: "A screen: key A, then drag on the board.", done: screens.length > 0 },
    { id: "connect", label: "Connect", hint: "Join two screens with an arrow: key K.", done: transitions > 0 },
    { id: "present", label: "Present", hint: "Try the prototype: Present, in Flows mode.", done: flags.presented },
    { id: "ship", label: "Ship", hint: "Take the code home: Develop mode.", done: flags.shipped || allImplemented },
  ];
}

export function isChecklistComplete(steps: readonly ChecklistStep[]): boolean {
  return steps.every((s) => s.done);
}

/** Which card to show: the big one ("Where do you want to start?"), the compact one, or none. */
export function onboardingMode(scene: SceneState | null, dismissed: boolean, steps: readonly ChecklistStep[]): "empty" | "progress" | "none" {
  if (!scene || dismissed) return "none";
  // The big card only on a TRULY empty board: whoever imported an SVG or
  // drew a shape is already working, even without a screen.
  if (scene.nodes.size === 0) return "empty";
  return isChecklistComplete(steps) ? "none" : "progress";
}
