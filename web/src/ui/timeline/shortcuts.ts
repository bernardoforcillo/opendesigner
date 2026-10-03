import { useFlowUi } from "../../store/flowUi";
import { useTimeline } from "../../animation/timelineStore";
import { isTextField } from "../../tools/toolManager";

// M apre/chiude la timeline. Sulla finestra come le altre scorciatoie a tasto
// singolo (il canvas non è focusabile), mai dentro un campo di testo, mai con un
// modificatore, mai mentre il prototipo è aperto. Da Flussi o Sviluppo riporta in
// Design: la timeline vive lì.
//
// Lo SPAZIO (play/pausa) NON è qui, di proposito: è del pannello e vale solo col
// fuoco al suo interno (TimelinePanel.tsx). Una scorciatoia globale sullo spazio
// toglierebbe il pan temporaneo con la barra spaziatrice (tools/toolManager.ts).
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
