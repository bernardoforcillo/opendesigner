import { useMemo } from "react";
import { useScene } from "@/store/store";
import { IconButton } from "@/ui/ds";
import { zoomAt } from "@/canvas/camera";
import { pageNumbers } from "@/store/pageNumbers";
import { hasErrors, preflightScene } from "@/export/preflight";

// THE STATUS BAR (Publishing workspace): zoom, the page navigator and the preflight verdict, along the
// bottom of the window where a page-layout app keeps them.
//  - zoom steps around the middle of the canvas (the same anchor the shortcuts use), so the page
//    stays where it is;
//  - the navigator walks the regular pages (masters are not pages) and shows the number `<#>` shows;
//  - preflight runs on the document itself (export/preflight.ts), no export needed: the verdict is
//    the count of errors and warnings of the same list the print dialog shows.
const STEP = 1.25;

export function StatusBar() {
  const scene = useScene((s) => s.scene);
  const zoom = useScene((s) => s.camera.zoom);
  const currentPageId = useScene((s) => s.currentPageId);

  const pages = useMemo(() => (scene?.pages ?? []).filter((p) => !p.isMaster), [scene?.pages]);
  const numbers = useMemo(() => pageNumbers(scene?.pages ?? []), [scene?.pages]);
  const at = Math.max(0, pages.findIndex((p) => p.id === (currentPageId ?? pages[0]?.id)));
  const issues = useMemo(() => (scene ? preflightScene(scene) : []), [scene]);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  function zoomBy(factor: number) {
    const st = useScene.getState();
    const canvas = document.getElementById("scene");
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    st.setCamera(zoomAt(st.camera, factor, w / 2, h / 2));
  }
  const go = (to: number) => {
    const p = pages[Math.min(pages.length - 1, Math.max(0, to))];
    if (p) useScene.getState().setCurrentPage(p.id);
  };

  const current = pages[at];
  const verdict = errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "No errors";
  const dot = errors > 0 ? "bg-danger" : warnings > 0 ? "bg-warn" : "bg-ok";

  return (
    <div role="status" aria-label="Status" className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-2 text-[12px] text-fg-muted">
      <div className="flex items-center gap-0.5">
        <IconButton icon="minus" label="Zoom out" size={20} onPress={() => zoomBy(1 / STEP)} />
        <span className="w-12 text-center tabular-nums text-fg" aria-label="Zoom">{Math.round(zoom * 100)}%</span>
        <IconButton icon="plus" label="Zoom in" size={20} onPress={() => zoomBy(STEP)} />
      </div>
      {pages.length > 0 && (
        <div className="flex items-center gap-0.5">
          <IconButton icon="chevronLeft" label="Previous page" size={20} isDisabled={at <= 0} onPress={() => go(at - 1)} />
          <span className="min-w-16 text-center text-fg" aria-label="Page">
            {current ? (numbers.get(current.id)?.label ?? at + 1) : ""} <span className="text-fg-subtle">/ {pages.length}</span>
          </span>
          <IconButton icon="chevronRight" label="Next page" size={20} isDisabled={at >= pages.length - 1} onPress={() => go(at + 1)} />
        </div>
      )}
      <span className="ml-auto flex items-center gap-1.5" title={issues.map((i) => i.message).join("\n")}>
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        <span aria-label="Preflight" className={hasErrors(issues) ? "text-danger" : "text-fg-muted"}>{verdict}</span>
      </span>
    </div>
  );
}
