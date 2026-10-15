import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { useScene } from "../store/store";
import { uploadAsset } from "../rpc/assets";
import type { FillLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { CHECKER, SegButtons } from "./ds/props-controls";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import {
  addGradientStopOps, imagePaintOps, fillKindOf, type PaintTarget, fillKindOps, gradientAngleOf, gradientAngleOps, gradientStopOps,
  gradientStopPositionOps, removeGradientStopOps, type FillKind, meshPointOps, meshSizeOps,
} from "./gradientOps";

const KINDS: { value: FillKind; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "image", label: "Image" },
  { value: "mesh", label: "Mesh" },
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
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The file goes up as a content-addressed asset (like an image node's); the paint stores its hash.
  const upload = async (file: File | undefined) => {
    const scene = useScene.getState().scene;
    if (!file || !scene) return;
    try {
      const ref = await uploadAsset(scene.id, file);
      setUploadError(null);
      run((ids) => imagePaintOps(ids, lookup, { assetHash: ref.hash }, target));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "could not upload the image");
    }
  };
  const g = fill?.gradient;
  const last = g ? g.stops.length - 1 : 0;
  const ordered = g ? [...g.stops].sort((a, b) => a.position - b.position) : [];
  return (
    <div className="flex flex-col gap-2">
      <SegButtons
        label={target === "fill" ? "Fill type" : "Stroke type"}
        value={kind}
        options={KINDS}
        wrap
        onPick={(k) => (k === "image" ? (fill?.image ? undefined : fileInput.current?.click()) : run((ids) => fillKindOps(ids, lookup, k, target)))}
      />
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Image file" className="hidden"
        onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      {fill?.image && (
        <div className="flex items-center gap-2">
          <select
            aria-label="Image scale" className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px]"
            value={fill.image.mode}
            onChange={(e) => run((ids) => imagePaintOps(ids, lookup, { mode: e.target.value as "fill" | "fit" | "tile" }, target))}
          >
            <option value="fill">Fill</option>
            <option value="fit">Fit</option>
            <option value="tile">Tile</option>
          </select>
          <button type="button" className="h-7 rounded-md px-2 text-[12px] text-fg-muted hover:bg-surface-3" onClick={() => fileInput.current?.click()}>Replace…</button>
        </div>
      )}
      {fill?.mesh && <MeshEditor fill={fill} run={run} target={target} />}
      {uploadError && <p role="alert" className="text-[12px] text-danger">{uploadError}</p>}
      {!g && !fill?.image && !fill?.mesh && solid}
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

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });

/** A mesh's grid: its size and one color picker per point, laid out as the grid is on the shape. */
function MeshEditor({ fill, run, target }: { fill: FillLite; run: (build: (ids: readonly string[]) => Op[]) => void; target: PaintTarget }) {
  const m = fill.mesh!;
  const sizes = [2, 3, 4, 5, 6];
  const pick = (label: string, value: number, set: (v: number) => void) => (
    <label className="flex items-center gap-1 text-[12px] text-fg-muted">
      {label}
      <select aria-label={label} className="h-7 rounded-md border border-line bg-surface px-1 text-[12px]" value={value} onChange={(e) => set(Number(e.target.value))}>
        {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {pick("Mesh rows", m.rows, (v) => run((ids) => meshSizeOps(ids, lookup, v, m.cols, target)))}
        {pick("Mesh columns", m.cols, (v) => run((ids) => meshSizeOps(ids, lookup, m.rows, v, target)))}
      </div>
      <div role="group" aria-label="Mesh points" className="grid gap-1" style={{ gridTemplateColumns: `repeat(${m.cols}, minmax(0, 1fr))` }}>
        {m.colors.map((c, i) => (
          <input
            key={i} type="color" aria-label={`Mesh point ${Math.floor(i / m.cols) + 1},${(i % m.cols) + 1}`}
            value={hex(c)}
            onChange={(e) => run((ids) => meshPointOps(ids, lookup, i, fromHex(e.target.value), target))}
            className="h-7 w-full cursor-pointer rounded border border-line bg-transparent p-0"
          />
        ))}
      </div>
    </div>
  );
}
