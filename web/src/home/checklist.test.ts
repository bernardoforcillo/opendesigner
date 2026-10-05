import { describe, expect, it, beforeEach } from "vitest";
import { emptyScene } from "../store/types";
import type { SceneState } from "../store/types";
import { baseScene, withFlows, flowOf, transition } from "../flow/testSupport";
import { checklistSteps, isChecklistComplete, onboardingMode, screenNodes } from "./checklist";
import { loadDocPrefs, saveDocPrefs } from "./docPrefs";

const NO_FLAGS = { presented: false, shipped: false };
const done = (steps: ReturnType<typeof checklistSteps>) => steps.filter((s) => s.done).map((s) => s.id);

describe("starter checklist", () => {
  it("empty document: no step done, four steps in journey order", () => {
    const steps = checklistSteps(emptyScene("d", "n"), NO_FLAGS);
    expect(steps.map((s) => s.id)).toEqual(["draw", "connect", "present", "ship"]);
    expect(steps.map((s) => s.label)).toEqual(["Draw", "Connect", "Present", "Ship"]);
    expect(done(steps)).toEqual([]);
  });

  it("without a scene (not loaded yet) nothing is ticked", () => {
    expect(done(checklistSteps(null, NO_FLAGS))).toEqual([]);
  });

  it("Draw ticks with the first screen (a top-level frame)", () => {
    expect(done(checklistSteps(baseScene(), NO_FLAGS))).toEqual(["draw"]);
  });

  it("a loose rectangle at page level is NOT a screen", () => {
    // baseScene has three frames (A, B, C), a button inside A and a page rectangle.
    const scene: SceneState = baseScene();
    expect(screenNodes(scene).map((n) => n.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("Connect ticks with the first transition", () => {
    const scene = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(done(checklistSteps(scene, NO_FLAGS))).toEqual(["draw", "connect"]);
  });

  it("Present and Ship follow the flags", () => {
    const scene = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(done(checklistSteps(scene, { presented: true, shipped: false }))).toEqual(["draw", "connect", "present"]);
    expect(done(checklistSteps(scene, { presented: true, shipped: true }))).toEqual(["draw", "connect", "present", "ship"]);
  });

  it("Ship also ticks if every screen has left the 'planned' state", () => {
    const base = baseScene();
    const nodes = base.nodes;
    let n2 = nodes;
    for (const id of ["A", "B", "C"]) n2 = n2.set(id, { ...nodes.at(id)!, meta: { status: "implemented" } });
    expect(done(checklistSteps({ ...base, nodes: n2 }, NO_FLAGS))).toContain("ship");
    // a single screen still planned is enough to keep it unticked
    const partial = nodes.set("A", { ...nodes.at("A")!, meta: { status: "implemented" } });
    expect(done(checklistSteps({ ...base, nodes: partial }, NO_FLAGS))).not.toContain("ship");
  });

  it("isChecklistComplete requires all four", () => {
    expect(isChecklistComplete(checklistSteps(baseScene(), NO_FLAGS))).toBe(false);
    const scene = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(isChecklistComplete(checklistSteps(scene, { presented: true, shipped: true }))).toBe(true);
  });
});

describe("onboardingMode", () => {
  const empty = emptyScene("d", "n");
  it("empty -> big card; with screens -> compact; complete, closed or without a scene -> nothing", () => {
    expect(onboardingMode(empty, false, checklistSteps(empty, NO_FLAGS))).toBe("empty");
    expect(onboardingMode(baseScene(), false, checklistSteps(baseScene(), NO_FLAGS))).toBe("progress");
    const full = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
    expect(onboardingMode(full, false, checklistSteps(full, { presented: true, shipped: true }))).toBe("none");
    expect(onboardingMode(empty, true, checklistSteps(empty, NO_FLAGS))).toBe("none");
    expect(onboardingMode(null, false, checklistSteps(null, NO_FLAGS))).toBe("none");
  });
});

describe("per-document preferences", () => {
  beforeEach(() => localStorage.clear());
  it("they all start off and are remembered per document", () => {
    expect(loadDocPrefs("a")).toEqual({ dismissed: false, presented: false, shipped: false });
    saveDocPrefs("a", { dismissed: true });
    saveDocPrefs("a", { presented: true });
    expect(loadDocPrefs("a")).toEqual({ dismissed: true, presented: true, shipped: false });
    expect(loadDocPrefs("b").dismissed).toBe(false);
  });
  it("an unreadable value in storage counts as 'off', not an error", () => {
    localStorage.setItem("opendesigner.onboarding.a", "{not json");
    expect(loadDocPrefs("a").dismissed).toBe(false);
  });
});
