import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { ArrowHeadLite } from "../store/types";
import { Section } from "./ds";
import { NumberField } from "./fields/NumberField";
import { arcOps, arrowheadOps, cornerRadiiOps, cornerSmoothingOps, polygonSidesOps, starOps, strokeSidesOps } from "./shapeOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);
type Run = (build: (ids: readonly string[]) => Op[]) => void;

const ARROWHEADS: { value: ArrowHeadLite | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "triangle", label: "Triangle" },
  { value: "circle", label: "Circle" },
  { value: "square", label: "Square" },
  { value: "diamond", label: "Diamond" },
];

const SELECT = "h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px] outline-none focus-visible:shadow-[var(--ring)]";

/**
 * The parametric fields of the selected node (docs/shapes.md): polygon sides, star points and depth, an ellipse's
 * arc and ring, and a rectangle's corner smoothing and independent radii. Renders nothing for other shapes.
 * It emits ops through `run` (the panel's `runGesture`), so every change is ONE undo step.
 */
export function ShapeControls({ run }: { run: Run }) {
  const n = useScene((s) => (s.selection.length === 1 && s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  if (!n) return null;
  if (n.kind === "polygon") {
    return (
      <Section title="Polygon">
        <NumberField label="Sides" value={n.sides ?? 3} minValue={3} onCommit={(v) => run((ids) => polygonSidesOps(ids, lookup, v))} />
      </Section>
    );
  }
  if (n.kind === "star") {
    return (
      <Section title="Star">
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="Points" value={n.points ?? 5} minValue={3} onCommit={(v) => run((ids) => starOps(ids, lookup, { points: v }))} />
          <NumberField
            label="Inner ratio" suffix="%" value={Math.round((n.innerRatio ?? 0.5) * 100)} minValue={5}
            onCommit={(v) => run((ids) => starOps(ids, lookup, { innerRatio: v / 100 }))}
          />
        </div>
      </Section>
    );
  }
  if (n.kind === "ellipse") {
    return (
      <Section title="Arc">
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="Start" suffix="°" value={n.arcStart ?? 0} onCommit={(v) => run((ids) => arcOps(ids, lookup, { start: v }))} />
          <NumberField
            label="Sweep" suffix="°" value={n.arcSweep ? n.arcSweep : 360}
            onCommit={(v) => run((ids) => arcOps(ids, lookup, { sweep: v }))}
          />
          <NumberField
            label="Ring" suffix="%" value={Math.round((n.innerRatio ?? 0) * 100)} minValue={0}
            onCommit={(v) => run((ids) => arcOps(ids, lookup, { innerRatio: v / 100 }))}
          />
        </div>
      </Section>
    );
  }
  if (n.kind === "rect") {
    const radii = n.radii;
    const corner = (label: string, key: "topLeft" | "topRight" | "bottomRight" | "bottomLeft") => (
      <NumberField
        key={key} label={label} minValue={0} value={radii ? radii[key] : n.cornerRadius}
        onCommit={(v) => run((ids) => cornerRadiiOps(ids, lookup, { [key]: v }))}
      />
    );
    return (
      <Section title="Corners">
        <div className="flex flex-col gap-1.5">
          <NumberField
            label="Smoothing" suffix="%" value={Math.round((n.cornerSmoothing ?? 0) * 100)} minValue={0}
            onCommit={(v) => run((ids) => cornerSmoothingOps(ids, lookup, v / 100))}
          />
          <label className="flex items-center gap-2 text-[12px] text-fg-muted">
            <input
              type="checkbox" aria-label="Independent corners" checked={radii !== undefined}
              onChange={(e) => run((ids) => cornerRadiiOps(ids, lookup, e.target.checked ? {} : null))}
            />
            Independent corners
          </label>
          {radii && (
            <div className="grid grid-cols-2 gap-1.5">
              {corner("Top left", "topLeft")}
              {corner("Top right", "topRight")}
              {corner("Bottom left", "bottomLeft")}
              {corner("Bottom right", "bottomRight")}
            </div>
          )}
        </div>
      </Section>
    );
  }
  return null;
}

/** Start and end arrowheads of a vector's stroke (renders nothing for other nodes). */
export function ArrowheadControls({ run }: { run: Run }) {
  const n = useScene((s) => (s.selection.length === 1 && s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  if (!n || n.kind !== "vector" || !n.vector?.subpaths.some((sp) => !sp.closed && sp.anchors.length >= 2)) return null;
  const stroke = n.strokes[0];
  const pick = (label: string, value: ArrowHeadLite | undefined, set: (v: ArrowHeadLite | null) => (ids: readonly string[]) => Op[]) => (
    <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
      <span className="w-16 shrink-0">{label}</span>
      <select
        aria-label={label} className={SELECT} value={value ?? "none"}
        onChange={(e) => run(set(e.target.value === "none" ? null : (e.target.value as ArrowHeadLite)))}
      >
        {ARROWHEADS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-1.5">
      {pick("Start", stroke?.startCap, (v) => (ids) => arrowheadOps(ids, lookup, { start: v }))}
      {pick("End", stroke?.endCap, (v) => (ids) => arrowheadOps(ids, lookup, { end: v }))}
    </div>
  );
}

/** Per-side stroke weights of a rectangle or frame (renders nothing for other nodes). */
export function StrokeSidesControls({ run }: { run: Run }) {
  const n = useScene((s) => (s.selection.length === 1 && s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  if (!n || (n.kind !== "rect" && n.kind !== "frame") || !n.strokes[0]) return null;
  const sides = n.strokes[0].sides;
  const side = (label: string, key: "top" | "right" | "bottom" | "left") => (
    <NumberField
      key={key} label={label} minValue={0} value={sides ? sides[key] : n.strokes[0].weight}
      onCommit={(v) => run((ids) => strokeSidesOps(ids, lookup, { [key]: v }))}
    />
  );
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-[12px] text-fg-muted">
        <input
          type="checkbox" aria-label="Per-side weights" checked={sides !== undefined}
          onChange={(e) => run((ids) => strokeSidesOps(ids, lookup, e.target.checked ? {} : null))}
        />
        Per-side weights
      </label>
      {sides && (
        <div className="grid grid-cols-2 gap-1.5">
          {side("Top", "top")}
          {side("Right", "right")}
          {side("Bottom", "bottom")}
          {side("Left", "left")}
        </div>
      )}
    </div>
  );
}
