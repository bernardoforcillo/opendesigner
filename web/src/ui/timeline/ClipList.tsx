import { useMemo } from "react";
import { Button as RacButton } from "react-aria-components";
import { Badge, Icon } from "../ds";
import { AnimIconButton } from "../ds/anim-parts";
import { useScene } from "../../store/store";
import { useTimeline, createClip, duplicateClipOp, removeClip } from "../../animation/timelineStore";
import { clipsForSelection, formatTime } from "../../animation/timelineLogic";
import { TRIGGER_LABELS } from "./labels";

// THE DOCUMENT'S CLIP LIST (left column of the timeline): choosing
// a clip opens it in the editor; creating, duplicating, deleting are ONE op each
// (one undo step). The "of the selection" filter limits the list to the clips that
// concern the screen or group being worked on.
export function ClipList() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const clipId = useTimeline((s) => s.clipId);
  const filter = useTimeline((s) => s.filterToSelection);
  const clips = useMemo(
    () => (scene ? (filter ? clipsForSelection(scene, selection) : clipsForSelection(scene, [])) : []),
    [scene, selection, filter],
  );
  const total = scene ? Object.keys(scene.clips).length : 0;
  const open = (id: string) => useTimeline.getState().openClip(id);

  return (
    <section aria-label="Clip" className="flex h-full w-52 shrink-0 flex-col border-r border-line">
      <header className="flex h-8 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Clip</h3>
        <span className="text-[11px] tabular-nums text-fg-subtle">{total}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <AnimIconButton
            icon="layers"
            label={filter ? "Show all clips" : "Only the selection's clips"}
            size={24}
            selected={filter}
            onPress={() => useTimeline.getState().setFilterToSelection(!filter)}
          />
          <AnimIconButton
            icon="plus"
            label="New clip"
            size={24}
            onPress={() => scene && createClip(scene, useScene.getState().selection)}
          />
        </div>
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5" aria-label="Clip list">
        {clips.length === 0 && (
          <li className="px-2 py-3 text-[12px] leading-snug text-fg-subtle">
            {total === 0 ? "No clips. Create one with +." : "No clips for the selection."}
          </li>
        )}
        {clips.map((c) => {
          const current = c.id === clipId;
          return (
            <li key={c.id} className="group/clip relative">
              <RacButton
                aria-current={current ? "true" : undefined}
                onPress={() => open(c.id)}
                className={
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left outline-none data-[focus-visible]:shadow-[var(--ring)] " +
                  (current ? "bg-accent-soft" : "hover:bg-surface-3")
                }
              >
                <span className={`flex w-full items-center gap-1.5 text-[13px] font-medium ${current ? "text-accent" : "text-fg"}`}>
                  <Icon name="play" size={10} className="shrink-0" />
                  <span className="truncate">{c.name.trim() !== "" ? c.name : "Unnamed"}</span>
                </span>
                <span className="flex items-center gap-1.5 pl-[18px] text-[11px] text-fg-subtle">
                  <Badge tone={c.trigger === "loop" ? "flow" : "neutral"}>{TRIGGER_LABELS[c.trigger || "manual"] ?? c.trigger}</Badge>
                  <span className="tabular-nums">{formatTime(c.duration)}</span>
                  <span className="tabular-nums">{c.tracks.length} {c.tracks.length === 1 ? "track" : "tracks"}</span>
                </span>
              </RacButton>
              {current && scene && (
                <span className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-raised/90 p-0.5">
                  <AnimIconButton icon="copy" label="Duplicate the clip" size={22} onPress={() => duplicateClipOp(scene, c.id)} />
                  <AnimIconButton icon="trash" label="Delete the clip" size={22} onPress={() => removeClip(c.id)} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
