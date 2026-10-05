import { Button as RacButton } from "react-aria-components";
import { cls } from "../ds";
import { AnimIcon, AnimIconButton } from "../ds/anim-parts";
import { SPEEDS, useTimeline } from "../../animation/timelineStore";
import { formatClock } from "../../animation/timelineLogic";
import type { ClipLite } from "../../store/types";
import { ClipSettingsButton } from "./ClipSettings";
import { AddPropertyMenu, PresetMenu } from "./menus";

// THE TRANSPORT: play/pause, stop, loop, speed, the current time, Record,
// the two actions that bring a layer into an animation (+ Property, Preset) and the
// clip settings. SPACE plays/pauses only with focus inside the
// timeline (see TimelinePanel): globally it stays the pan with the space bar.
export function Transport({ clip }: { clip: ClipLite | null }) {
  const playing = useTimeline((s) => s.playing);
  const loop = useTimeline((s) => s.loop);
  const speed = useTimeline((s) => s.speed);
  const record = useTimeline((s) => s.record);
  const playhead = useTimeline((s) => s.playhead);
  const tl = () => useTimeline.getState();
  const has = clip !== null;

  return (
    <div role="toolbar" aria-label="Transport" className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-line px-2 py-1">
      <AnimIconButton icon="chevronDown" label="Collapse the timeline" size={24} onPress={() => tl().setCollapsed(true)} />
      <span className="mx-0.5 h-5 w-px bg-line" />
      <AnimIconButton icon="skipStart" label="Go to start" isDisabled={!has} onPress={() => tl().setPlayhead(0)} />
      <AnimIconButton
        icon={playing ? "pause" : "play"}
        label={playing ? "Pause" : "Play"}
        shortcut="Space"
        isDisabled={!has}
        selected={playing}
        onPress={() => tl().togglePlay()}
      />
      <AnimIconButton icon="stop" label="Stop" isDisabled={!has} onPress={() => tl().stop()} />
      <AnimIconButton icon="loop" label="Repeat in loop" isDisabled={!has} selected={loop} onPress={() => tl().setLoop(!loop)} />
      <div className="w-[64px] shrink-0">
        <select aria-label="Speed" value={speed} onChange={(e) => tl().setSpeed(Number(e.target.value))} className={cls.select}>
          {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
      </div>
      <output aria-label="Current time" className="mx-1 min-w-[78px] rounded-md bg-surface-2 px-2 py-1 text-center text-[12px] tabular-nums text-fg">
        {formatClock(playhead)}
      </output>

      {/* RECORD: with the clip open, changes to x, y, rotation and opacity
          write keyframes at the playhead instead of changing the layer. */}
      <RacButton
        aria-label="Record"
        aria-pressed={record}
        isDisabled={!has}
        onPress={() => tl().setRecord(!record)}
        className={
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium outline-none transition-colors " +
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[focus-visible]:shadow-[var(--ring)] " +
          (record ? "bg-danger-soft text-danger" : "bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg")
        }
      >
        <AnimIcon name="record" size={12} className={record ? "text-danger" : ""} />
        Record
      </RacButton>

      <span className="mx-0.5 h-5 w-px bg-line" />
      <AddPropertyMenu />
      <PresetMenu />

      <div className="ml-auto flex items-center gap-0.5">
        {clip && <ClipSettingsButton clip={clip} />}
        <AnimIconButton icon="x" label="Close the timeline" shortcut="M" onPress={() => tl().setOpen(false)} />
      </div>
    </div>
  );
}
