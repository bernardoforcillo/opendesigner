import { describe, it, expect } from "vitest";
import { emptyScene } from "../store/types";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import { pipelineSteps } from "./pipeline";

const ids = (s: ReturnType<typeof pipelineSteps>) => s.map((x) => `${x.id}:${x.done ? "ok" : "-"}${x.current ? "*" : ""}`).join(" ");

describe("pipelineSteps", () => {
  const linked = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
  it.each([
    ["empty document: start from Draw", emptyScene("d", "t"), 0, 0, false, "draw:-* connect:- try:- ship:-"],
    ["screens but no flow: Connect is next", baseScene(), 3, 3, false, "draw:ok connect:-* try:- ship:-"],
    ["a flow without transitions does not count as connected", withFlows(baseScene(), [flowOf("f", "A")], []), 3, 0, false, "draw:ok connect:-* try:- ship:ok"],
    ["connected but never tried: Try is next", linked, 3, 2, false, "draw:ok connect:ok try:-* ship:-"],
    ["tried with blockers: Ship is next", linked, 3, 2, true, "draw:ok connect:ok try:ok ship:-*"],
    ["all done: no current step", linked, 3, 0, true, "draw:ok connect:ok try:ok ship:ok"],
    ["without screens Ship is never done", linked, 0, 0, true, "draw:-* connect:ok try:ok ship:-"],
  ])("%s", (_t, scene, screens, blockers, presented, want) => {
    expect(ids(pipelineSteps({ scene, screens, blockers, presented }))).toBe(want);
  });

  it("without a scene: everything to do; every step says which mode it is worked in and why it is missing", () => {
    const steps = pipelineSteps({ scene: null, screens: 0, blockers: 0, presented: false });
    expect(steps.map((s) => s.mode)).toEqual(["design", "flows", "flows", "dev"]);
    expect(steps.every((s) => s.hint.length > 0 && !s.done)).toBe(true);
    expect(steps[3].hint).toMatch(/[Ss]creens/);
    expect(pipelineSteps({ scene: baseScene(), screens: 2, blockers: 4, presented: false })[3].hint).toMatch(/4 blockers/);
  });
});
