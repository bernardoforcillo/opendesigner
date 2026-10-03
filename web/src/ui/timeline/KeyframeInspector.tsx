import { AnimIconButton } from "../ds/anim-parts";
import { NumberField } from "../fields/NumberField";
import { useScene } from "../../store/store";
import type { ClipLite } from "../../store/types";
import { commitClip, useTimeline } from "../../animation/timelineStore";
import {
  PROP_LABEL, PROP_UNIT, deleteKeyframes, duplicateKeyframes, updateKeyframe, type KeyRef,
} from "../../animation/timelineLogic";
import { EasingEditor } from "./EasingEditor";

// L'ISPETTORE del keyframe selezionato (colonna destra della timeline): tempo,
// valore, easing con la mini-curva, duplica ed elimina. Ogni modifica è UN SetClip.
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
      <AnimIconButton icon="copy" label="Duplica i keyframe al playhead" shortcut="⌘D" size={24} onPress={dup} />
      <AnimIconButton icon="trash" label="Elimina i keyframe" shortcut="Canc" size={24} onPress={del} />
    </div>
  );

  if (refs.length > 1) {
    return (
      <aside aria-label="Keyframe selezionati" className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-line p-3">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] font-medium text-fg">{refs.length} keyframe selezionati</p>
          {actions}
        </div>
        <p className="text-[12px] leading-snug text-fg-subtle">Trascinane uno per spostarli insieme. Maiusc libera l'aggancio.</p>
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
        <NumberField label="Tempo" glyph="T" suffix="ms" minValue={0} value={kf.time} onCommit={(v) => edit({ time: v })} />
        <NumberField
          label="Valore"
          glyph="V"
          suffix={unit}
          minValue={tr.prop === "opacity" || tr.prop === "draw" ? 0 : undefined}
          value={kf.value}
          onCommit={(v) => edit({ value: v })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-fg-subtle">Curva verso il prossimo</span>
        {seg ? (
          <EasingEditor value={kf.easing} onCommit={(easing) => edit({ easing })} />
        ) : (
          <p className="text-[12px] leading-snug text-fg-subtle">Ultimo keyframe: nessun segmento dopo di lui.</p>
        )}
      </div>
    </aside>
  );
}
