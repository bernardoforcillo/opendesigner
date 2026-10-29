import { runZoom } from "@/canvas/zoomCommands";
import type { PaletteAction } from "@/store/actions";
import { useFlowUi, type EditorMode } from "@/store/flowUi";
import { useScene } from "@/store/store";
import { useSpreadView } from "@/store/spread";
import { showDockTab, type DockTab } from "@/store/dock";
import { usePanels } from "@/ui/shell/panels";
import { TOOL_KEYS } from "@/ui/shell/ToolDock";
import type { ToolId } from "@/tools/types";

// WHAT THE PALETTE CAN DO, built from what the editor has right now: the tools of the mode on screen, the
// modes this kind of document offers, the zoom commands, the panels, the history. Each is one line that calls
// the same function a button or a shortcut would.
const MODE_LABEL: Record<EditorMode, string> = { board: "Board", design: "Design", flows: "Flows", dev: "Develop" };

export function buildPaletteActions(o: {
  tools: readonly { id: ToolId; label: string }[];
  chooseTool: (id: ToolId) => void;
  modes: readonly EditorMode[];
  /** The Publishing workspace has a dock with tabs, and spreads. */
  publishing: boolean;
}): PaletteAction[] {
  const out: PaletteAction[] = [];
  for (const t of o.tools) out.push({ id: `tool:${t.id}`, label: t.label, group: "Tools", keys: TOOL_KEYS[t.id], run: () => o.chooseTool(t.id) });
  for (const m of o.modes) out.push({ id: `mode:${m}`, label: `Go to ${MODE_LABEL[m]}`, group: "Modes", run: () => useFlowUi.getState().setMode(m) });
  out.push(
    { id: "zoom:in", label: "Zoom in", group: "View", keys: "⌘+", run: () => runZoom("in") },
    { id: "zoom:out", label: "Zoom out", group: "View", keys: "⌘−", run: () => runZoom("out") },
    { id: "zoom:100", label: "Zoom to 100%", group: "View", keys: "⇧0", run: () => runZoom("100") },
    { id: "zoom:fit", label: "Zoom to fit", group: "View", keys: "⇧1", run: () => runZoom("fit") },
    { id: "zoom:selection", label: "Zoom to selection", group: "View", keys: "⇧2", run: () => runZoom("selection") },
    { id: "panel:left", label: "Show or hide the left panel", group: "View", keys: "[", run: () => usePanels.getState().toggle("left") },
    { id: "panel:right", label: "Show or hide the right panel", group: "View", keys: "]", run: () => usePanels.getState().toggle("right") },
  );
  if (o.publishing) {
    out.push({ id: "view:spread", label: "Show or hide spreads", group: "View", run: () => useSpreadView.getState().setOn(!useSpreadView.getState().on) });
    const tabs: [DockTab, string][] = [["properties", "Properties"], ["pages", "Pages"], ["layers", "Layers"], ["styles", "Styles"], ["preflight", "Preflight"], ["comments", "Comments"]];
    for (const [tab, label] of tabs) out.push({ id: `dock:${tab}`, label: `Show ${label}`, group: "Panels", run: () => showDockTab(tab) });
  }
  out.push(
    { id: "edit:undo", label: "Undo", group: "Edit", keys: "⌘Z", run: () => useScene.getState().undo() },
    { id: "edit:redo", label: "Redo", group: "Edit", keys: "⇧⌘Z", run: () => useScene.getState().redo() },
  );
  return out;
}
