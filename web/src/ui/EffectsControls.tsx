import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { BLEND_MODES, type BlendModeLite } from "../store/types";
import { cls, IconButton, Section } from "./ds";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import {
  addShadowOps, backgroundBlurOf, backgroundBlurOps, blendModeOps, blurOf, blurOps, editShadowOps, removeEffectOps,
  shadowsOf,
} from "./effectOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

/**
 * The EFFECTS section: any number of shadows (drop and inner), the layer blur,
 * the background blur and the blend mode of the selected node. It does not
 * know gestures: it emits ops through `run`, the same `runGesture` as the
 * panel, so every change is ONE undo step.
 */
export function EffectsControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  // Selectors that return stable primitives/references: the panel
  // redraws only when the first selected node's effects change.
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const shadows = shadowsOf(first);
  const blur = blurOf(first);
  const backdrop = backgroundBlurOf(first);

  return (
    <Section
      title="Effects"
      actions={
        <>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-fg-subtle hover:bg-surface-hover"
            onClick={() => run((ids) => addShadowOps(ids, lookup, "innerShadow"))}
          >
            + Inner
          </button>
          <IconButton icon="plus" label="Add shadow" size={24} onPress={() => run((ids) => addShadowOps(ids, lookup, "dropShadow"))} />
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {shadows.map(({ index, shadow }) => (
          // A shadow card: a thin-bordered box with its name and the trash can,
          // like a list row in a design editor.
          <div key={index} className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex h-6 items-center justify-between">
              <span className="text-[12px] font-medium text-fg">{shadow.kind === "innerShadow" ? "Inner shadow" : "Drop shadow"}</span>
              <IconButton
                icon="trash" label={shadows.length > 1 ? `Remove shadow ${index + 1}` : "Remove shadow"} size={24}
                onPress={() => run((ids) => removeEffectOps(ids, lookup, index))}
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                label="X" value={shadow.offsetX}
                onCommit={(v) => run((ids) => editShadowOps(ids, lookup, index, { offsetX: v }))}
              />
              <NumberField
                label="Y" value={shadow.offsetY}
                onCommit={(v) => run((ids) => editShadowOps(ids, lookup, index, { offsetY: v }))}
              />
              <NumberField
                label="Blur" value={shadow.blur} minValue={0}
                onCommit={(v) => run((ids) => editShadowOps(ids, lookup, index, { blur: v }))}
              />
              <NumberField
                label="Shadow opacity" glyph="α" suffix="%" value={Math.round(shadow.color.a * 100)} minValue={0}
                onCommit={(v) => run((ids) => editShadowOps(ids, lookup, index, { alpha: v / 100 }))}
              />
            </div>
            <ColorField
              label="Shadow color" value={shadow.color}
              onCommit={(rgb) => run((ids) => editShadowOps(ids, lookup, index, { rgb }))}
            />
          </div>
        ))}
        <NumberField
          label="Layer blur" value={blur?.radius ?? 0} minValue={0}
          onCommit={(v) => run((ids) => blurOps(ids, lookup, v))}
        />
        <NumberField
          label="Background blur" value={backdrop?.radius ?? 0} minValue={0}
          onCommit={(v) => run((ids) => backgroundBlurOps(ids, lookup, v))}
        />
        <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
          <span className="w-16 shrink-0">Blend</span>
          <select
            aria-label="Blend mode"
            className={cls.select}
            value={first?.blendMode ?? ""}
            onChange={(e) => run((ids) => blendModeOps(ids, lookup, (e.target.value || undefined) as BlendModeLite | undefined))}
          >
            <option value="">Normal</option>
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>{m.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())}</option>
            ))}
          </select>
        </label>
      </div>
    </Section>
  );
}
