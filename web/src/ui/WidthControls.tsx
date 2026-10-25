import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { WidthPointLite } from "../store/types";
import { WIDTH_PRESETS, presetNameOf } from "../vector/widthProfile";
import { addWidthPointInGap, profileOf, removeWidthPoint, setWidthPoint, setWidthProfileOps, widthStrokeOf } from "../vector/widthEdit";
import { NumberField } from "./fields/NumberField";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);
type Run = (build: (ids: readonly string[]) => Op[]) => void;

const PRESETS: { value: string; label: string }[] = [
  { value: "uniform", label: "Uniform" },
  { value: "taper", label: "Taper (thick to thin)" },
  { value: "taper-start", label: "Taper (thin to thick)" },
  { value: "lens", label: "Lens (thin ends)" },
  { value: "bulge", label: "Bulge" },
  { value: "pinch", label: "Pinch" },
  { value: "brush", label: "Brush" },
];

const SELECT = "h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px] outline-none focus-visible:shadow-[var(--ring)]";
const BTN = "h-7 rounded-md border border-line bg-surface px-2 text-[12px] text-fg-muted outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)]";

/**
 * Variable width of a vector's stroke (docs/vector.md): a preset and the width points (position along the
 * path, left and right width as a percentage of the stroke). Renders nothing for other nodes or a vector
 * without a stroke. Every change is ONE undo step through `run`. The Variable width tool (W) edits the same
 * points on the canvas.
 */
export function WidthControls({ run }: { run: Run }) {
  const n = useScene((s) => (s.selection.length === 1 && s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  if (!n || n.kind !== "vector" || !widthStrokeOf(n)) return null;
  const profile = profileOf(n);
  const name = presetNameOf(profile);
  const write = (next: readonly WidthPointLite[]) => run((ids) => ids.flatMap((id) => {
    const t = lookup(id);
    return t ? setWidthProfileOps(t, next) : [];
  }));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-fg-muted">Variable width</span>
        <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
        <span className="w-16 shrink-0">Profile</span>
        <select aria-label="Width profile" className={SELECT} value={name} onChange={(e) => write(WIDTH_PRESETS[e.target.value] ?? [])}>
          {name === "custom" && <option value="custom">Custom</option>}
          {PRESETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {profile.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-1.5">
          <NumberField
            label="At" suffix="%" minValue={0} value={Math.round(p.position * 1000) / 10}
            onCommit={(v) => write(setWidthPoint(profile, i, { position: Math.min(100, v) / 100 }))}
          />
          <NumberField
            label="Left" suffix="%" minValue={0} value={Math.round(p.left * 100)}
            onCommit={(v) => write(setWidthPoint(profile, i, { left: v / 100 }))}
          />
          <NumberField
            label="Right" suffix="%" minValue={0} value={Math.round(p.right * 100)}
            onCommit={(v) => write(setWidthPoint(profile, i, { right: v / 100 }))}
          />
          <button type="button" className={BTN} aria-label={`Remove width point ${i + 1}`} onClick={() => write(removeWidthPoint(profile, i))}>×</button>
        </div>
      ))}
      <button
        type="button" className={BTN}
        onClick={() => {
          const added = addWidthPointInGap(profile);
          if (added) write(added.profile);
        }}
      >
        Add width point
      </button>
  </div>
  );
}
