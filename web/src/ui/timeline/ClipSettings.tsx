import { useMemo } from "react";
import { Button as RacButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { cls } from "../ds";
import { Field } from "../ds/flow-parts";
import { AnimIconButton } from "../ds/anim-parts";
import { CommitField } from "../fields/CommitField";
import { NumberField } from "../fields/NumberField";
import { useScene } from "../../store/store";
import type { ClipLite } from "../../store/types";
import { CLIP_TRIGGERS } from "../../animation/engine";
import { commitClip } from "../../animation/timelineStore";
import { targetCandidates, withDuration } from "../../animation/timelineLogic";
import { TRIGGER_HINTS, TRIGGER_LABELS } from "./labels";

// The open clip's SETTINGS, in a popover from the button in the
// transport bar: they are what is touched rarely, and in a fixed row they would eat
// the tracks' height. Every change is ONE `SetClip` with the whole clip (one
// gesture, one undo step) and the fields commit on Enter or blur, like the
// rest of the interface (CommitField / NumberField): no op per keystroke.
const TOGGLE =
  "flex h-7 shrink-0 items-center justify-center rounded-md px-2.5 text-[12px] font-medium outline-none transition-colors " +
  "data-[focus-visible]:shadow-[var(--ring)] ";

export function ClipSettingsButton({ clip }: { clip: ClipLite }) {
  return (
    <DialogTrigger>
      <AnimIconButton icon="sliders" label="Clip settings" />
      <Popover placement="bottom end" offset={6} className="z-50 w-[300px] rounded-xl bg-raised p-3 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Clip settings" className="flex flex-col gap-1.5 outline-none">
          <ClipSettings clip={clip} />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

export function ClipSettings({ clip }: { clip: ClipLite }) {
  const scene = useScene((s) => s.scene);
  const targets = useMemo(() => (scene ? targetCandidates(scene, clip.targetId) : []), [scene, clip.targetId]);
  const set = (patch: Partial<ClipLite>) => commitClip({ ...clip, ...patch });
  const infinite = clip.repeat < 0;
  // An unknown trigger (clip from another version) stays selectable as it is.
  const triggers: string[] = (CLIP_TRIGGERS as readonly string[]).includes(clip.trigger) ? [...CLIP_TRIGGERS] : [clip.trigger, ...CLIP_TRIGGERS];

  return (
    <div role="group" aria-label="Clip settings" className="flex flex-col gap-1.5">
      <Field label="Name" wide>
        <CommitField label="Clip name" value={clip.name} onCommit={(v) => v.trim() !== "" && set({ name: v.trim() })} />
      </Field>
      <Field label="Trigger" wide>
        <select
          aria-label="Trigger"
          title={TRIGGER_HINTS[clip.trigger]}
          value={clip.trigger === "" ? "manual" : clip.trigger}
          onChange={(e) => set({ trigger: e.target.value })}
          className={cls.select}
        >
          {triggers.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t] ?? t}</option>)}
        </select>
      </Field>
      <p className="-mt-0.5 pl-[96px] text-[11px] leading-snug text-fg-subtle">{TRIGGER_HINTS[clip.trigger === "" ? "manual" : clip.trigger]}</p>
      <Field label="Duration" wide>
        <NumberField label="Duration" glyph="" labelWidth="w-1.5" suffix="ms" minValue={10} value={clip.duration} onCommit={(v) => commitClip(withDuration(clip, v))} />
      </Field>
      <Field label="Delay" wide>
        <NumberField label="Delay" glyph="" labelWidth="w-1.5" suffix="ms" minValue={0} value={clip.delay} onCommit={(v) => set({ delay: Math.max(0, v) })} />
      </Field>
      <Field label="Repeats" wide>
        <div className="flex min-w-0 flex-1 gap-1">
          <div className="min-w-0 flex-1">
            <NumberField
              label="Repeats"
              glyph=""
              labelWidth="w-1.5"
              minValue={0}
              isDisabled={infinite}
              value={infinite ? NaN : clip.repeat}
              placeholder="∞"
              onCommit={(v) => set({ repeat: Math.max(0, Math.round(v)) })}
            />
          </div>
          <RacButton
            aria-label="Repeat forever"
            aria-pressed={infinite}
            onPress={() => set({ repeat: infinite ? 0 : -1 })}
            className={TOGGLE + (infinite ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-muted hover:bg-surface-3")}
          >
            ∞
          </RacButton>
        </div>
      </Field>
      <Field label="Yoyo" wide>
        <RacButton
          aria-label="Yoyo"
          aria-pressed={clip.yoyo}
          onPress={() => set({ yoyo: !clip.yoyo })}
          className={TOGGLE + (clip.yoyo ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-muted hover:bg-surface-3")}
        >
          {clip.yoyo ? "Yes: odd repeats play backwards" : "No"}
        </RacButton>
      </Field>
      <Field label="Target" wide>
        <select
          aria-label="Target"
          value={clip.targetId}
          onChange={(e) => set({ targetId: e.target.value })}
          className={cls.select}
        >
          {targets.map((n) => (
            <option key={n.id} value={n.id}>{n.name.trim() !== "" ? n.name : n.kind}</option>
          ))}
          {!targets.some((n) => n.id === clip.targetId) && <option value={clip.targetId}>(target deleted)</option>}
        </select>
      </Field>
    </div>
  );
}
