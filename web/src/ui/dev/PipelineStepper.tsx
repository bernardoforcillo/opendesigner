import { Button as RacButton, Tooltip, TooltipTrigger } from "react-aria-components";
import { useScene } from "../../store/store";
import { useFlowUi } from "../../store/flowUi";
import { usePanels } from "../shell/panels";
import { hasPresented } from "../../dev/presented";
import { pipelineSteps, type PipelineStep, type StepId } from "../../dev/pipeline";
import { Icon } from "../ds";
import { useReadiness } from "./useReadiness";

// The pipeline STEPPER: Draw · Connect · Try · Ship.
//
// It sits in the Develop view's header and not in the dock: the dock is the most
// contended resource on screen (it already scrolls horizontally below 1100 px) and the
// stepper answers a question -- "what is missing to ship?" -- that makes sense
// right here, where you hand off. Each step is clickable and leads to where the work is:
// Draw -> Design, Connect -> Flows, Try -> Flows with the prototype open,
// Ship -> the "Ship" panel (reopens it if it was closed).

const TIP = "z-50 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop";

/** What a click on a step does (exported: the test wants it without mounting the view). */
export function goToStep(id: StepId, hasFlow: boolean): void {
  const ui = useFlowUi.getState();
  switch (id) {
    case "draw": ui.setMode("design"); break;
    case "connect": ui.setMode("flows"); break;
    case "try":
      ui.setMode("flows");
      // Without a flow there is nothing to present: we stop at Flows.
      if (hasFlow) ui.setPresenting(true);
      break;
    case "ship":
      ui.setMode("dev");
      if (!usePanels.getState().right) usePanels.getState().toggle("right");
      break;
  }
}

function StepButton({ step, index, active, onPress }: { step: PipelineStep; index: number; active: boolean; onPress: () => void }) {
  const tone = step.done ? "text-ok" : step.current ? "text-fg" : "text-fg-subtle";
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <RacButton
        onPress={onPress}
        aria-current={active ? "step" : undefined}
        data-done={step.done}
        data-step={step.id}
        className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium outline-none transition-colors ` +
          `focus-visible:shadow-[var(--ring)] hover:bg-surface-3 ${tone} ${active ? "bg-surface-3" : ""}`}
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ` +
            (step.done ? "bg-ok-soft text-ok" : step.current ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg-subtle")}
        >
          {step.done ? <Icon name="check" size={10} /> : index + 1}
        </span>
        {step.label}
      </RacButton>
      <Tooltip offset={8} className={TIP}>{step.hint}</Tooltip>
    </TooltipTrigger>
  );
}

export function PipelineStepper() {
  const scene = useScene((s) => s.scene);
  const r = useReadiness();
  const mode = useFlowUi((s) => s.mode);
  const steps = pipelineSteps({
    scene,
    screens: r?.screens.length ?? 0,
    blockers: r?.blockers ?? 0,
    presented: hasPresented(scene?.id),
  });
  const hasFlow = !!scene && Object.keys(scene.flows).length > 0;
  return (
    <nav aria-label="Pipeline" className="flex items-center gap-0.5">
      {steps.map((s, i) => (
        <span key={s.id} className="flex items-center gap-0.5">
          {i > 0 && <Icon name="chevronRight" size={12} className="text-fg-subtle" />}
          <StepButton step={s} index={i} active={s.id === "ship" && mode === "dev"} onPress={() => goToStep(s.id, hasFlow)} />
        </span>
      ))}
    </nav>
  );
}
