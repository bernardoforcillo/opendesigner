import type { ReactNode } from "react";
import { useScene } from "../store/store";
import type { FillLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { CHECKER, SegButtons } from "./ds/props-controls";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import {
  fillKindOf, fillKindOps, gradientAngleOf, gradientAngleOps, gradientStopOps, type FillKind,
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
  fill, run, solid,
}: {
  fill: FillLite | null;
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
        label="Fill type"
        value={kind}
        options={KINDS}
        onPick={(k) => run((ids) => fillKindOps(ids, lookup, k))}
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
          <StopRow label="From" position={g.stops[0].position}>
            <ColorField
              label="From"
              value={g.stops[0].color}
              onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, 0, rgb))}
            />
          </StopRow>
          <StopRow label="To" position={g.stops[last].position}>
            <ColorField
              label="To"
              value={g.stops[last].color}
              onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, last, rgb))}
            />
          </StopRow>
          {g.kind === "linear" && (
            <NumberField
              label="Angle"
              suffix="°"
              value={gradientAngleOf(fill)}
              onCommit={(v) => run((ids) => gradientAngleOps(ids, lookup, v))}
            />
          )}
        </>
      )}
    </div>
  );
}

// A stop row: the position (in %, read-only) on the left and the color.
// `label` is not repeated here as accessible text -- the color field
// already carries it -- but it serves the viewer to understand WHICH end it is.
function StopRow({ label, position, children }: { label: string; position: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11px] tabular-nums text-fg-subtle" title={`${label}: ${Math.round(position * 100)}%`}>
        {Math.round(position * 100)}%
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
