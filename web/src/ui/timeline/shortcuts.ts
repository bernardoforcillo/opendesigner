import { useFlowUi } from "../../store/flowUi";
import { useTimeline } from "../../animation/timelineStore";
import { isTextField } from "../../tools/toolManager";

// M opens/closes the timeline. On the window like the other single-key
// shortcuts (the canvas is not focusable), never inside a text field, never with a
// modifier, never while the prototype is open. From Flows or Develop it returns to
// Design: the timeline lives there.
//
// SPACE (play/pause) is NOT here, on purpose: it belongs to the panel and applies only with
// focus inside it (TimelinePanel.tsx). A global shortcut on space
// would remove the temporary pan with the space bar (tools/toolManager.ts).
export function attachTimelineShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "m" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (isTextField(e.target)) return;
    const fu = useFlowUi.getState();
    if (fu.presenting) return;
    e.preventDefault();
    const tl = useTimeline.getState();
    if (fu.mode !== "design") {
      fu.setMode("design");
      tl.setOpen(true);
    } else tl.toggleOpen();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
