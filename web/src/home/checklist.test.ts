import { describe, expect, it, beforeEach } from "vitest";
import { emptyScene } from "../store/types";
import type { SceneState } from "../store/types";
import { baseScene, withFlows, flowOf, transition } from "../flow/testSupport";
import { checklistSteps, isChecklistComplete, onboardingMode, screenNodes } from "./checklist";
import { loadDocPrefs, saveDocPrefs } from "./docPrefs";

const NO_FLAGS = { presented: false, shipped: false };
const done = (steps: ReturnType<typeof checklistSteps>) => steps.filter((s) => s.done).map((s) => s.id);

describe("checklist di partenza", () => {
  it("documento vuoto: nessun passo fatto, quattro passi nell'ordine del percorso", () => {
    const steps = checklistSteps(emptyScene("d", "n"), NO_FLAGS);
    expect(steps.map((s) => s.id)).toEqual(["draw", "connect", "present", "ship"]);
    expect(steps.map((s) => s.label)).toEqual(["Disegna", "Collega", "Presenta", "Spedisci"]);
    expect(done(steps)).toEqual([]);
  });

  it("senza scena (non ancora caricata) non ticchetta niente", () => {
    expect(done(checklistSteps(null, NO_FLAGS))).toEqual([]);
  });

  it("Disegna si spunta con la prima schermata (un frame di primo livello)", () => {
    expect(done(checklistSteps(baseScene(), NO_FLAGS))).toEqual(["draw"]);
  });

  it("un rettangolo sciolto a livello di pagina NON è una schermata", () => {
    // baseScene ha tre frame (A, B, C), un bottone dentro A e un rettangolo di pagina.
    const scene: SceneState = baseScene();
    expect(screenNodes(scene).map((n) => n.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("Collega si spunta con la prima transizione", () => {
    const scene = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(done(checklistSteps(scene, NO_FLAGS))).toEqual(["draw", "connect"]);
  });

  it("Presenta e Spedisci seguono i flag", () => {
    const scene = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(done(checklistSteps(scene, { presented: true, shipped: false }))).toEqual(["draw", "connect", "present"]);
    expect(done(checklistSteps(scene, { presented: true, shipped: true }))).toEqual(["draw", "connect", "present", "ship"]);
  });

  it("Spedisci si spunta anche se ogni schermata ha lasciato lo stato 'planned'", () => {
    const base = baseScene();
    const nodes = base.nodes;
    let n2 = nodes;
    for (const id of ["A", "B", "C"]) n2 = n2.set(id, { ...nodes.at(id)!, meta: { status: "implemented" } });
    expect(done(checklistSteps({ ...base, nodes: n2 }, NO_FLAGS))).toContain("ship");
    // basta una schermata ancora pianificata per non spuntarlo
    const partial = nodes.set("A", { ...nodes.at("A")!, meta: { status: "implemented" } });
    expect(done(checklistSteps({ ...base, nodes: partial }, NO_FLAGS))).not.toContain("ship");
  });

  it("isChecklistComplete vuole tutti e quattro", () => {
    expect(isChecklistComplete(checklistSteps(baseScene(), NO_FLAGS))).toBe(false);
    const scene = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(isChecklistComplete(checklistSteps(scene, { presented: true, shipped: true }))).toBe(true);
  });
});

describe("onboardingMode", () => {
  const empty = emptyScene("d", "n");
  it("vuoto -> scheda grande; con schermate -> compatta; completo, chiuso o senza scena -> niente", () => {
    expect(onboardingMode(empty, false, checklistSteps(empty, NO_FLAGS))).toBe("empty");
    expect(onboardingMode(baseScene(), false, checklistSteps(baseScene(), NO_FLAGS))).toBe("progress");
    const full = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(onboardingMode(full, false, checklistSteps(full, { presented: true, shipped: true }))).toBe("none");
    expect(onboardingMode(empty, true, checklistSteps(empty, NO_FLAGS))).toBe("none");
    expect(onboardingMode(null, false, checklistSteps(null, NO_FLAGS))).toBe("none");
  });
});

describe("preferenze per documento", () => {
  beforeEach(() => localStorage.clear());
  it("partono tutte spente e si ricordano per documento", () => {
    expect(loadDocPrefs("a")).toEqual({ dismissed: false, presented: false, shipped: false });
    saveDocPrefs("a", { dismissed: true });
    saveDocPrefs("a", { presented: true });
    expect(loadDocPrefs("a")).toEqual({ dismissed: true, presented: true, shipped: false });
    expect(loadDocPrefs("b").dismissed).toBe(false);
  });
  it("un valore illeggibile nello storage vale 'spento', non un errore", () => {
    localStorage.setItem("opendesigner.onboarding.a", "{non json");
    expect(loadDocPrefs("a").dismissed).toBe(false);
  });
});
