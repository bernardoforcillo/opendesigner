import type { SceneState } from "../store/types";
import type { EditorMode } from "../store/flowUi";

// THE PIPELINE: Draw · Connect · Try · Ship. Four steps, each
// "done" or not, DEDUCED from the document -- nobody ticks them by hand, so they cannot
// lie:
//   Draw    = there is at least one screen;
//   Connect = at least one flow has at least one transition;
//   Try     = the prototype has been opened at least once (a habit, per
//             document, in localStorage: dev/presented.ts);
//   Ship    = there are screens and no blockers in the checklist.
// Pure: app state -> steps. The click is handled by the view (ui/dev/PipelineStepper).

export type StepId = "draw" | "connect" | "try" | "ship";

export interface PipelineStep {
  id: StepId;
  label: string;
  done: boolean;
  /** The "current" step = the first not done (where it makes sense to work). */
  current: boolean;
  /** Why it is not done, in a few words (tooltip). */
  hint: string;
  /** The mode in which this step is worked on. */
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
    { id: "draw", label: "Draw", done: draw, mode: "design", hint: draw ? `${screens} screens` : "Draw at least one screen (a frame)" },
    { id: "connect", label: "Connect", done: connected, mode: "flows", hint: connected ? "flows connected" : "Connect the screens with arrows" },
    { id: "try", label: "Try", done: presented, mode: "flows", hint: presented ? "prototype tried" : "Open the prototype with Present" },
    {
      id: "ship", label: "Ship", done: draw && blockers === 0, mode: "dev",
      hint: !draw ? "Screens needed" : blockers === 0 ? "ready for export" : `${blockers} blockers to fix`,
    },
  ];
  const firstTodo = raw.findIndex((s) => !s.done);
  return raw.map((s, i) => ({ ...s, current: i === firstTodo }));
}
