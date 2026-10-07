import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { vectorStyleOf } from "../renderer/vectorStyle";
import { SegButtons } from "./ds/props-controls";
import { strokeStyleOps } from "./strokeStyleOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

const CAPS = [
  { value: "butt", label: "Butt" }, { value: "round", label: "Round" }, { value: "square", label: "Square" },
] as const;
const JOINS = [
  { value: "miter", label: "Miter" }, { value: "round", label: "Round" }, { value: "bevel", label: "Bevel" },
] as const;

/** Cap, join and dash of the selected node's stroke (one gesture per change). */
export function StrokeStyleControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  if (!first) return null;
  const vs = vectorStyleOf(first);
  return (
    <div className="flex flex-col gap-1.5">
      <SegButtons label="Cap" value={vs.cap} options={CAPS} onPick={(cap) => run((ids) => strokeStyleOps(ids, lookup, { cap }))} />
      <SegButtons label="Join" value={vs.join} options={JOINS} onPick={(join) => run((ids) => strokeStyleOps(ids, lookup, { join }))} />
      <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
        <span className="w-16 shrink-0">Dash</span>
        <input
          aria-label="Dash"
          // Uncontrolled and keyed by the stored value: typing is free, Enter or blur commits.
          key={vs.dash.join(",")}
          defaultValue={vs.dash.join(", ")}
          placeholder="e.g. 4, 2"
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px] text-fg outline-none focus-visible:shadow-[var(--ring)]"
          onBlur={(e) => run((ids) => strokeStyleOps(ids, lookup, { dash: e.currentTarget.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      </label>
    </div>
  );
}
