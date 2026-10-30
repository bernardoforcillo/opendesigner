import { useScene } from "@/store/store";
import { currentT } from "@/i18n";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { BrushLite, BrushTipLite } from "@/store/types";
import { BRUSH_PRESETS, BRUSH_TIPS, brushPresetName } from "@/vector/brushSpec";
import { brushStrokeOf, setBrushOps } from "@/vector/brushEdit";
import { NumberField } from "@/ui/fields/NumberField";

// Names the shared controls cannot translate on their own (options, text nodes). See docs/localization.md.
const tr = (key: string, vars?: Record<string, string | number>) => currentT().tx(key, vars);

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);
type Run = (build: (ids: readonly string[]) => Op[]) => void;

const PRESETS: { value: string; label: string }[] = [
  { value: "none", label: "None (plain stroke)" },
  { value: "chalk", label: "Chalk" },
  { value: "marker", label: "Marker" },
  { value: "dots", label: "Dotted" },
  { value: "leaves", label: "Leaves" },
];

const KINDS: { value: BrushLite["kind"]; label: string }[] = [
  { value: "stretch", label: "Stretch (tiles end to end)" },
  { value: "scatter", label: "Scatter (stamped tips)" },
];

const SELECT = "h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px] outline-none focus-visible:shadow-[var(--ring)]";

/**
 * Brush of a vector's stroke (docs/vector.md): a preset, or a kind (stretch / scatter) with its tip, spacing,
 * scatter, jitters and seed. Renders nothing for other nodes or a vector without a stroke. Every change is ONE
 * undo step through `run`.
 */
export function BrushControls({ run }: { run: Run }) {
  const n = useScene((s) => (s.selection.length === 1 && s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  if (!n || n.kind !== "vector" || !brushStrokeOf(n)) return null;
  const brush = brushStrokeOf(n)?.brush;
  const name = brushPresetName(brush);
  const write = (next: BrushLite | undefined) => run((ids) => ids.flatMap((id) => {
    const t = lookup(id);
    return t ? setBrushOps(t, next) : [];
  }));
  const patch = (p: Partial<BrushLite>) => brush && write({ ...brush, ...p });
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-fg-muted">Brush</span>
      <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
        <span className="w-16 shrink-0">Preset</span>
        <select
          aria-label="Brush preset" className={SELECT} value={name}
          onChange={(e) => write(e.target.value === "none" ? undefined : BRUSH_PRESETS[e.target.value])}
        >
          {name === "custom" && <option value="custom">{tr("Custom")}</option>}
          {PRESETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {brush && (
        <>
          <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="w-16 shrink-0">Kind</span>
            <select aria-label="Brush kind" className={SELECT} value={brush.kind} onChange={(e) => patch({ kind: e.target.value as BrushLite["kind"] })}>
              {KINDS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="w-16 shrink-0">Tip</span>
            <select aria-label="Brush tip" className={SELECT} value={brush.tip} onChange={(e) => patch({ tip: e.target.value as BrushTipLite })}>
              {BRUSH_TIPS.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label={brush.kind === "stretch" ? "Length" : "Spacing"} suffix="%" minValue={5} value={Math.round(brush.spacing * 100)} onCommit={(v) => patch({ spacing: v / 100 })} />
            <NumberField label="Scatter" suffix="%" minValue={0} value={Math.round(brush.scatter * 100)} onCommit={(v) => patch({ scatter: v / 100 })} />
            <NumberField label="Size jitter" suffix="%" minValue={0} value={Math.round(brush.sizeJitter * 100)} onCommit={(v) => patch({ sizeJitter: Math.min(100, v) / 100 })} />
            <NumberField label="Angle jitter" suffix="°" minValue={0} value={Math.round(brush.angleJitter)} onCommit={(v) => patch({ angleJitter: v })} />
            <NumberField label="Seed" minValue={0} value={brush.seed} onCommit={(v) => patch({ seed: Math.round(v) })} />
          </div>
        </>
      )}
    </div>
  );
}
