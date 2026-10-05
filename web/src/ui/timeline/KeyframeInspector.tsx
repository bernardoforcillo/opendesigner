import { AnimIconButton } from "../ds/anim-parts";
import { NumberField } from "../fields/NumberField";
import { useScene } from "../../store/store";
import type { ClipLite } from "../../store/types";
import { commitClip, useTimeline } from "../../animation/timelineStore";
import {
  PROP_LABEL, PROP_UNIT, deleteKeyframes, duplicateKeyframes, updateKeyframe, type KeyRef,
} from "../../animation/timelineLogic";
import { EasingEditor } from "./EasingEditor";

// THE INSPECTOR of the selected keyframe (right column of the timeline): time,
// value, easing with the mini-curve, duplicate and delete. Every change is ONE SetClip.
export function KeyframeInspector({ clip, selection }: { clip: ClipLite; selection: KeyRef[] }) {
  const scene = useScene((s) => s.scene);
  const refs = selection.filter((r) => clip.tracks[r.track]?.keyframes[r.key]);
  if (refs.length === 0) return null;

  const del = () => {
    commitClip(deleteKeyframes(clip, refs));
    useTimeline.getState().select([]);
  };
  const dup = () => {
    const r = duplicateKeyframes(clip, refs, useTimeline.getState().playhead);
    commitClip(r.clip);
    useTimeline.getState().select(r.sel);
  };
  const actions = (
    <div className="flex shrink-0 items-center gap-0.5">
      <AnimIconButton icon="copy" label="Duplicate the keyframes at the playhead" shortcut="⌘D" size={24} onPress={dup} />
      <AnimIconButton icon="trash" label="Delete the keyframes" shortcut="Del" size={24} onPress={del} />
    </div>
  );

  if (refs.length > 1) {
    return (
      <aside aria-label="Selected keyframes" className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-line p-3">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] font-medium text-fg">{refs.length} keyframes selected</p>
          {actions}
        </div>
        <p className="text-[12px] leading-snug text-fg-subtle">Drag one to move them together. Shift releases snapping.</p>
      </aside>
    );
  }

  const ref = refs[0];
  const tr = clip.tracks[ref.track];
  const kf = tr.keyframes[ref.key];
  const node = scene?.nodes.get(tr.nodeId);
  const unit = PROP_UNIT[tr.prop] ?? "";
  const edit = (patch: Partial<typeof kf>) => {
    const r = updateKeyframe(clip, ref, patch);
    commitClip(r.clip);
    useTimeline.getState().select([r.ref]);
  };
  const seg = ref.key < tr.keyframes.length - 1;

  return (
    <aside aria-label="Keyframe" className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-line p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-fg">{node?.name.trim() ? node.name : tr.nodeId}</p>
          <p className="truncate text-[11px] text-fg-subtle">{PROP_LABEL[tr.prop] ?? tr.prop} · keyframe {ref.key + 1} di {tr.keyframes.length}</p>
        </div>
        {actions}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label="Time" glyph="T" suffix="ms" minValue={0} value={kf.time} onCommit={(v) => edit({ time: v })} />
        <NumberField
          label="Value"
          glyph="V"
          suffix={unit}
          minValue={tr.prop === "opacity" || tr.prop === "draw" ? 0 : undefined}
          value={kf.value}
          onCommit={(v) => edit({ value: v })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-fg-subtle">Curve to the next one</span>
        {seg ? (
          <EasingEditor value={kf.easing} onCommit={(easing) => edit({ easing })} />
        ) : (
          <p className="text-[12px] leading-snug text-fg-subtle">Last keyframe: no segment after it.</p>
        )}
      </div>
    </aside>
  );
}
