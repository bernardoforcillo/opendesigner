import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { LayoutGridLite } from "../store/types";
import { cls, IconButton, Section } from "./ds";
import { NumberField } from "./fields/NumberField";
import { addGridOps, editGridOps, removeGridOps } from "./layoutGridOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);
const KINDS: { value: LayoutGridLite["kind"]; label: string }[] = [
  { value: "grid", label: "Grid" }, { value: "columns", label: "Columns" }, { value: "rows", label: "Rows" },
];

/** The layout grids of the selected frame: columns, rows and square grids that guide and snap. */
export function LayoutGridControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  const frame = useScene((s) => {
    const n = s.selection.length === 1 ? s.scene?.nodes.at(s.selection[0]) : undefined;
    return n && n.kind === "frame" ? n : undefined;
  });
  if (!frame) return null;
  const grids = frame.layoutGrids ?? [];
  return (
    <Section
      title="Layout grid"
      actions={<IconButton icon="plus" label="Add layout grid" size={24} onPress={() => run((ids) => addGridOps(ids, lookup, "columns"))} />}
    >
      <div className="flex flex-col gap-2">
        {grids.map((g, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex h-6 items-center justify-between gap-2">
              <select
                aria-label={`Grid ${i + 1} type`}
                className={cls.select}
                value={g.kind}
                onChange={(e) => run((ids) => editGridOps(ids, lookup, i, { kind: e.target.value as LayoutGridLite["kind"] }))}
              >
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <IconButton icon="trash" label={`Remove grid ${i + 1}`} size={24} onPress={() => run((ids) => removeGridOps(ids, lookup, i))} />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {g.kind === "grid" ? (
                <NumberField label="Size" minValue={1} value={g.size} onCommit={(v) => run((ids) => editGridOps(ids, lookup, i, { size: v }))} />
              ) : (
                <>
                  <NumberField label="Count" minValue={1} value={g.count} onCommit={(v) => run((ids) => editGridOps(ids, lookup, i, { count: v }))} />
                  <NumberField label="Gutter" minValue={0} value={g.gutter} onCommit={(v) => run((ids) => editGridOps(ids, lookup, i, { gutter: v }))} />
                  <NumberField label="Margin" minValue={0} value={g.margin} onCommit={(v) => run((ids) => editGridOps(ids, lookup, i, { margin: v }))} />
                </>
              )}
              <NumberField
                label="Grid opacity" glyph="α" suffix="%" minValue={0} value={Math.round(g.color.a * 100)}
                onCommit={(v) => run((ids) => editGridOps(ids, lookup, i, { alpha: v / 100 }))}
              />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
