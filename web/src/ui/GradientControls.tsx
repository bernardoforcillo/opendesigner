import type { ReactNode } from "react";
import { useScene } from "../store/store";
import type { FillLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { CHECKER, SegButtons } from "./ds/props-controls";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import {
  addGradientStopOps, fillKindOf, type PaintTarget, fillKindOps, gradientAngleOf, gradientAngleOps, gradientStopOps,
  gradientStopPositionOps, removeGradientStopOps, type FillKind,
} from "./gradientOps";

const KINDS: { value: FillKind; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
];

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

// A model color (float 0..1, alpha included) as a CSS value. Here and not
// in ColorField because it serves ONLY to draw the strip: the hexadecimal field
// stays the only "UI edge" for the values the user reads and writes.
function css(c: { r: number; g: number; b: number; a: number }): string {
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${ch(c.r)} ${ch(c.g)} ${ch(c.b)} / ${c.a})`;
}

/**
 * The fill type (solid / linear / radial) and, for a gradient,
 * the preview, the two colors at the ends and the angle. It does not know gestures: it emits
 * ops through `run`, the same `runGesture` as the panel, so a type change
 * is ONE undo step like any other change.
 *
 * The STRIP is a real preview: the model's same stops, in order of
 * position, above the checkerboard (transparency can be read too). The handles
 * below the strip are the stops' points, colored like the stop -- they are
 * decorative: colors are changed from the fields below, which also carry the
 * accessible name.
 */
export function GradientControls({
  fill, run, solid, target = "fill",
}: {
  fill: FillLite | null;
  /** Which paint it edits: the first fill (default) or the first stroke's. */
  target?: PaintTarget;
  run: (build: (ids: readonly string[]) => Op[]) => void;
  /** The SOLID fill's color field: it sits under the segments, and exists only without a gradient. */
  solid?: ReactNode;
}) {
  const kind = fillKindOf(fill);
  const g = fill?.gradient;
  const last = g ? g.stops.length - 1 : 0;
  const ordered = g ? [...g.stops].sort((a, b) => a.position - b.position) : [];
  return (
    <div className="flex flex-col gap-2">
      <SegButtons
        label={target === "fill" ? "Fill type" : "Stroke type"}
        value={kind}
        options={KINDS}
        onPick={(k) => run((ids) => fillKindOps(ids, lookup, k, target))}
      />
      {!g && solid}
      {g && (
        <>
          {/* The side padding leaves room for the handles at the two ends. */}
          <div className="px-1.5 pb-2 pt-0.5" aria-hidden="true">
            <div className="relative h-6">
              <div className="absolute inset-0 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--line-strong)]">
                <div className="absolute inset-0" style={{ background: CHECKER }} />
                <div
                  className="absolute inset-0"
                  style={{ background: `linear-gradient(90deg, ${ordered.map((s) => `${css(s.color)} ${s.position * 100}%`).join(", ")})` }}
                />
              </div>
              {ordered.map((s, i) => (
                <span
                  key={i}
                  style={{ left: `${s.position * 100}%` }}
                  className="absolute top-full size-3.5 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-surface shadow-[0_0_0_2px_var(--surface),0_0_0_3px_var(--line-strong),0_1px_3px_rgb(0_0_0/0.3)]"
                >
                  <span className="absolute inset-0" style={{ background: CHECKER }} />
                  <span className="absolute inset-0" style={{ background: css({ ...s.color, a: 1 }) }} />
                </span>
              ))}
            </div>
          </div>
          {g.stops.map((st, i) => (
            <StopRow
              key={i}
              label={i === 0 ? "From" : i === last ? "To" : `Stop ${i + 1}`}
              position={st.position}
              onPosition={(v) => run((ids) => gradientStopPositionOps(ids, lookup, i, v / 100, target))}
              onRemove={last > 1 ? () => run((ids) => removeGradientStopOps(ids, lookup, i, target)) : undefined}
            >
              <ColorField
                label={i === 0 ? "From" : i === last ? "To" : `Stop ${i + 1}`}
                value={st.color}
                onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, i, rgb, target))}
              />
            </StopRow>
          ))}
          <button
            type="button"
            className="self-start rounded px-1.5 py-0.5 text-[11px] text-fg-subtle hover:bg-surface-hover"
            onClick={() => run((ids) => addGradientStopOps(ids, lookup, target))}
          >
            + Add stop
          </button>
          {g.kind === "linear" && (
            <NumberField
              label="Angle"
              suffix="°"
              value={gradientAngleOf(fill)}
              onCommit={(v) => run((ids) => gradientAngleOps(ids, lookup, v, target))}
            />
          )}
        </>
      )}
    </div>
  );
}

// A stop row: the position (in %, editable) on the left, the color and a
// remove button. `label` names the stop for the accessible names.
function StopRow({
  label, position, onPosition, onRemove, children,
}: {
  label: string; position: number; onPosition: (percent: number) => void; onRemove?: () => void; children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 shrink-0">
        <NumberField label={`${label} position`} suffix="%" minValue={0} value={Math.round(position * 100)} onCommit={onPosition} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {onRemove && (
        <button type="button" aria-label={`Remove ${label}`} className="shrink-0 rounded px-1 text-fg-subtle hover:bg-surface-hover" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
