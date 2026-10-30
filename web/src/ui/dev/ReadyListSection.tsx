import { useMemo } from "react";
import { formatDate } from "@/i18n/format";
import { useScene } from "@/store/store";
import { annotationsInside, categoryColor, readyFrames } from "@/store/devMode";
import { screenOf } from "@/flow/screens";
import { useFlowUi } from "@/store/flowUi";
import { Badge, cls } from "@/ui/ds";

// "READY FOR DEV" (Develop, left column): the frames the designer handed over, oldest first, with
// the colours of the annotations inside each. Picking one is the FOCUS view: the frame becomes the
// selection, so the code view shows its file and Ship shows its status, annotations and
// "Compare changes". A frame deleted since it was marked is listed as missing.

const when = (sec: number) => (sec ? formatDate(sec, { month: "short", day: "numeric" }) : "");

function focusFrame(id: string): void {
  const st = useScene.getState();
  const scene = st.scene;
  const n = scene?.nodes.get(id);
  if (!scene || !n) return;
  const screen = screenOf(scene, id);
  if (screen && st.currentPageId !== screen.parentId) st.setCurrentPage(screen.parentId);
  useFlowUi.getState().selectTransition(null);
  st.setSelection([id]);
}

export function ReadyListSection() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const ready = useMemo(() => (scene ? readyFrames(scene) : []), [scene]);
  if (!scene) return null;
  return (
    <section className="border-t border-line pb-2" aria-label="Ready for dev" data-testid="ready-list">
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <h3 className={cls.sectionTitle}>Ready for dev</h3>
        <span className="ml-auto" />
        <Badge tone={ready.length > 0 ? "ok" : "neutral"}>{ready.length}</Badge>
      </div>
      {ready.length === 0 && (
        <p className="px-3 text-[12px] text-fg-subtle">No frame is marked yet. Select one and use Mark ready for dev in Ship.</p>
      )}
      <ul>
        {ready.map((r) => {
          const node = scene.nodes.get(r.nodeId);
          const notes = annotationsInside(scene, r.nodeId);
          const colors = [...new Set(notes.map((a) => a.category))];
          return (
            <li key={r.nodeId}>
              <button
                type="button"
                disabled={!node}
                aria-current={selection[0] === r.nodeId ? "true" : undefined}
                onClick={() => focusFrame(r.nodeId)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)] disabled:opacity-60 aria-[current=true]:bg-accent-soft"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{node ? node.name || "(unnamed)" : "(deleted frame)"}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">
                    {when(r.markedAt)}{r.markedBy ? ` · ${r.markedBy}` : ""}{r.note ? ` · ${r.note}` : ""}
                  </span>
                </span>
                {colors.length > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5" title={`${notes.length} annotation${notes.length === 1 ? "" : "s"}`}>
                    {colors.map((c) => <span key={c} aria-hidden="true" className="size-2 rounded-full" style={{ background: categoryColor(c) }} />)}
                    <span className="ml-0.5 font-mono text-[10px] text-fg-subtle">{notes.length}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
