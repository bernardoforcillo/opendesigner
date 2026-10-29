import { useMemo } from "react";
import { useScene } from "@/store/store";
import { ToggleButton } from "react-aria-components";
import { IconButton } from "@/ui/ds";
import { zoomAt } from "@/canvas/camera";
import { pageNumbers } from "@/store/pageNumbers";
import { facingPartner, fitSpreadCamera, useSpreadView } from "@/store/spread";
import { hasErrors } from "@/export/preflight";
import { showDockTab } from "@/store/dock";
import { usePreflight } from "@/ui/shell/preflightIssues";

// THE STATUS BAR (Publishing workspace): zoom, the page navigator and the preflight verdict, along the
// bottom of the window where a page-layout app keeps them.
//  - zoom steps around the middle of the canvas (the same anchor the shortcuts use), so the page
//    stays where it is;
//  - the navigator walks the regular pages (masters are not pages) and shows the number `<#>` shows;
//  - the Spread toggle shows the page facing the one on screen beside it (store/spread.ts); it needs the
//    document's Facing pages setting (Page setup), and the navigator then names the pair, "2–3";
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
  const issues = usePreflight();
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  function zoomBy(factor: number) {
    const st = useScene.getState();
    const canvas = document.getElementById("scene");
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    st.setCamera(zoomAt(st.camera, factor, w / 2, h / 2));
  }
  // Frames the page on screen, and its facing page when the spread is on.
  const fit = () => {
    const st = useScene.getState();
    const canvas = document.getElementById("scene");
    if (!st.scene || !canvas) return;
    const sp = useSpreadView.getState().on ? facingPartner(st.scene, st.currentPageId) : null;
    const cam = fitSpreadCamera(st.scene, st.currentPageId, sp, canvas.clientWidth, canvas.clientHeight);
    if (cam) st.setCamera(cam);
  };
  const go = (to: number) => {
    const p = pages[Math.min(pages.length - 1, Math.max(0, to))];
    if (!p) return;
    useScene.getState().setCurrentPage(p.id);
    fit();
  };

  const current = pages[at];
  const facing = scene?.settings?.facingPages === true;
  const spreadOn = useSpreadView((s) => s.on);
  const partner = facing && spreadOn && scene ? facingPartner(scene, currentPageId) : null;
  const partnerLabel = partner ? numbers.get(partner.pageId)?.label : undefined;
  const ownLabel = current ? String(numbers.get(current.id)?.label ?? at + 1) : "";
  const pageLabel = partnerLabel ? (partner?.partnerIsLeft ? `${partnerLabel}–${ownLabel}` : `${ownLabel}–${partnerLabel}`) : ownLabel;
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
            {pageLabel} <span className="text-fg-subtle">/ {pages.length}</span>
          </span>
          <IconButton icon="chevronRight" label="Next page" size={20} isDisabled={at >= pages.length - 1} onPress={() => go(at + 1)} />
        </div>
      )}
      <ToggleButton
        aria-label="Spread"
        isSelected={facing && spreadOn}
        isDisabled={!facing}
        onChange={(on) => { useSpreadView.getState().setOn(on); fit(); }}
        className={({ isSelected, isDisabled }) =>
          `h-5 rounded px-2 text-[12px] outline-none focus-visible:shadow-[var(--ring)] ` +
          (isDisabled ? "text-fg-subtle opacity-60" : isSelected ? "bg-accent-soft font-medium text-accent" : "hover:bg-surface-3")
        }
      >
        <span title={facing ? "Show facing pages side by side" : "Turn on Facing pages in Page setup to see spreads"}>Spread</span>
      </ToggleButton>
      <button
        type="button"
        aria-label="Preflight"
        onClick={() => showDockTab("preflight")}
        title="Open Preflight"
        className="ml-auto flex items-center gap-1.5 rounded px-1.5 outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]"
      >
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        <span className={hasErrors(issues) ? "text-danger" : "text-fg-muted"}>{verdict}</span>
      </button>
    </div>
  );
}
