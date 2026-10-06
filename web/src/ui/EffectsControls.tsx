import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { IconButton, Section } from "./ds";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import { blurOf, blurOps, shadowOf, shadowOps } from "./effectOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

/**
 * The EFFECTS section: shadow and blur of the selected node (the first, if there
 * are more than one: effects are not summarized like `fills` because they are a list).
 * It does not know gestures: it emits ops through `run`, the same `runGesture` as the
 * panel, so every change is ONE undo step.
 *
 * The shadow is a LIST of (at most) one element: the "+" in the header
 * adds it, the trash can on its card removes it -- the same two ops as before
 * (`enabled: true/false`), just no longer behind a checkbox.
 */
export function EffectsControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  // Selectors that return stable primitives/references: the panel
  // redraws only when the first selected node's effects change.
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const shadow = shadowOf(first);
  const blur = blurOf(first);

  return (
    <Section
      title="Effects"
      actions={
        shadow === undefined && (
          <IconButton
            icon="plus" label="Add shadow" size={24}
            onPress={() => run((ids) => shadowOps(ids, lookup, { enabled: true }))}
          />
        )
      }
    >
      <div className="flex flex-col gap-2">
        {shadow && (
          // The shadow card: a thin-bordered box with its name and
          // the trash can, like a list row in a design editor.
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex h-6 items-center justify-between">
              <span className="text-[12px] font-medium text-fg">Drop shadow</span>
              <IconButton
                icon="trash" label="Remove shadow" size={24}
                onPress={() => run((ids) => shadowOps(ids, lookup, { enabled: false }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                label="X" value={shadow.offsetX}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { offsetX: v }))}
              />
              <NumberField
                label="Y" value={shadow.offsetY}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { offsetY: v }))}
              />
              <NumberField
                label="Blur" value={shadow.blur} minValue={0}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { blur: v }))}
              />
              <NumberField
                label="Shadow opacity" glyph="α" suffix="%" value={Math.round(shadow.color.a * 100)} minValue={0}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { alpha: v / 100 }))}
              />
            </div>
            <ColorField
              label="Shadow color" value={shadow.color}
              onCommit={(rgb) => run((ids) => shadowOps(ids, lookup, { rgb }))}
            />
          </div>
        )}
        <NumberField
          label="Layer blur" value={blur?.radius ?? 0} minValue={0}
          onCommit={(v) => run((ids) => blurOps(ids, lookup, v))}
        />
      </div>
    </Section>
  );
}
