import { describe, it, expect } from "vitest";
import { emptyScene } from "../store/types";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import { pipelineSteps } from "./pipeline";

const ids = (s: ReturnType<typeof pipelineSteps>) => s.map((x) => `${x.id}:${x.done ? "ok" : "-"}${x.current ? "*" : ""}`).join(" ");

describe("pipelineSteps", () => {
  const linked = withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]);
  it.each([
    ["documento vuoto: si parte da Disegna", emptyScene("d", "t"), 0, 0, false, "draw:-* connect:- try:- ship:-"],
    ["schermate ma nessun flusso: tocca a Collega", baseScene(), 3, 3, false, "draw:ok connect:-* try:- ship:-"],
    ["un flusso senza transizioni non vale come collegato", withFlows(baseScene(), [flowOf("f", "A")], []), 3, 0, false, "draw:ok connect:-* try:- ship:ok"],
    ["collegato ma mai provato: tocca a Prova", linked, 3, 2, false, "draw:ok connect:ok try:-* ship:-"],
    ["provato con bloccanti: tocca a Spedisci", linked, 3, 2, true, "draw:ok connect:ok try:ok ship:-*"],
    ["tutto fatto: nessun passo corrente", linked, 3, 0, true, "draw:ok connect:ok try:ok ship:ok"],
    ["senza schermate Spedisci non è mai fatto", linked, 0, 0, true, "draw:-* connect:ok try:ok ship:-"],
  ])("%s", (_t, scene, screens, blockers, presented, want) => {
    expect(ids(pipelineSteps({ scene, screens, blockers, presented }))).toBe(want);
  });

  it("senza scena: tutto da fare; ogni passo dice in che modalità si lavora e perché manca", () => {
    const steps = pipelineSteps({ scene: null, screens: 0, blockers: 0, presented: false });
    expect(steps.map((s) => s.mode)).toEqual(["design", "flows", "flows", "dev"]);
    expect(steps.every((s) => s.hint.length > 0 && !s.done)).toBe(true);
    expect(steps[3].hint).toMatch(/schermate/);
    expect(pipelineSteps({ scene: baseScene(), screens: 2, blockers: 4, presented: false })[3].hint).toMatch(/4 bloccanti/);
  });
});
