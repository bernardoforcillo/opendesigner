import type { SceneState } from "../store/types";
import type { EditorMode } from "../store/flowUi";

// LA PIPELINE: Disegna · Collega · Prova · Spedisci. Quattro passi, ognuno
// "fatto" o no, DEDOTTI dal documento -- nessuno li spunta a mano, quindi non
// possono mentire:
//   Disegna  = c'è almeno una schermata;
//   Collega  = almeno un flusso ha almeno una transizione;
//   Prova    = il prototipo è stato aperto almeno una volta (abitudine, per
//              documento, in localStorage: dev/presented.ts);
//   Spedisci = ci sono schermate e nessun bloccante nella checklist.
// Pura: stato dell'app -> passi. Il click lo gestisce la vista (ui/dev/PipelineStepper).

export type StepId = "draw" | "connect" | "try" | "ship";

export interface PipelineStep {
  id: StepId;
  label: string;
  done: boolean;
  /** Il passo "corrente" = il primo non fatto (dove conviene mettersi). */
  current: boolean;
  /** Perché non è fatto, in poche parole (tooltip). */
  hint: string;
  /** La modalità in cui si lavora a questo passo. */
  mode: EditorMode;
}

export interface PipelineInput {
  scene: SceneState | null;
  screens: number;
  blockers: number;
  presented: boolean;
}

export function pipelineSteps({ scene, screens, blockers, presented }: PipelineInput): PipelineStep[] {
  const connected = !!scene && Object.keys(scene.flows).length > 0 && Object.keys(scene.transitions).length > 0;
  const draw = screens > 0;
  const raw: Omit<PipelineStep, "current">[] = [
    { id: "draw", label: "Disegna", done: draw, mode: "design", hint: draw ? `${screens} schermate` : "Disegna almeno una schermata (un frame)" },
    { id: "connect", label: "Collega", done: connected, mode: "flows", hint: connected ? "flussi collegati" : "Collega le schermate con le frecce" },
    { id: "try", label: "Prova", done: presented, mode: "flows", hint: presented ? "prototipo provato" : "Apri il prototipo con Presenta" },
    {
      id: "ship", label: "Spedisci", done: draw && blockers === 0, mode: "dev",
      hint: !draw ? "Servono schermate" : blockers === 0 ? "pronto per l'export" : `${blockers} bloccanti da sistemare`,
    },
  ];
  const firstTodo = raw.findIndex((s) => !s.done);
  return raw.map((s, i) => ({ ...s, current: i === firstTodo }));
}
