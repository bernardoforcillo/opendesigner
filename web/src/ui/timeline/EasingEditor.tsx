import { useEffect, useRef, useState } from "react";
import { cls } from "../ds";
import {
  EASING_PRESETS, curvePath, dragControl, easingToBezier, nudgeControl, presetIdOf, toPx, type CurveBox,
} from "../../animation/easingEdit";
import { EASING_LABELS } from "./labels";

// THE EASING EDITOR of a keyframe: a menu of ready-made curves and a mini-curve
// with the Bézier's two control points to drag. Dragging works on a local
// DRAFT (the curve updates under the finger) and on release calls
// `onCommit` ONCE: a single op, a single undo step. Named curves
// drag like the others: they become the equivalent cubic-bezier.
export const CURVE_BOX: CurveBox = { width: 200, height: 96, pad: 14 };
const BOX = CURVE_BOX;
const HANDLE_R = 5;

export function EasingEditor({ value, onCommit }: { value: string; onCommit: (spec: string) => void }) {
  // The draft exists only during the drag; outside it, the curve is `value`.
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<0 | 1 | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const spec = draft ?? value;
  useEffect(() => setDraft(null), [value]);

  const b = easingToBezier(spec);
  const p0 = toPx(BOX, 0, 0), p1 = toPx(BOX, 1, 1);
  const c1 = toPx(BOX, b[0], b[1]);
  const c2 = toPx(BOX, b[2], b[3]);
  const preset = presetIdOf(spec);

  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const r = svg.current?.getBoundingClientRect();
    const sx = r && r.width > 0 ? BOX.width / r.width : 1;
    const sy = r && r.height > 0 ? BOX.height / r.height : 1;
    return { x: (e.clientX - (r?.left ?? 0)) * sx, y: (e.clientY - (r?.top ?? 0)) * sy };
  };
  const down = (which: 0 | 1) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = which;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* no capture (jsdom) */ }
  };
  const move = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    const p = local(e);
    setDraft(dragControl(spec, drag.current, BOX, p.x, p.y));
  };
  const up = () => {
    if (drag.current === null) return;
    drag.current = null;
    if (draft !== null && draft !== value) onCommit(draft);
    else setDraft(null);
  };
  const key = (which: 0 | 1) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    onCommit(nudgeControl(spec, which, v[0], v[1]));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <select
        aria-label="Easing"
        value={preset}
        onChange={(e) => {
          const id = e.target.value;
          onCommit(id === "custom" ? "cubic-bezier(0.25,0.1,0.25,1)" : id);
        }}
        className={cls.select}
      >
        {EASING_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        <option value="custom">{EASING_LABELS.custom}</option>
      </select>
      <svg
        ref={svg}
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        className="w-full touch-none select-none rounded-md bg-surface-2"
        role="group"
        aria-label="Easing curve"
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => { drag.current = null; setDraft(null); }}
      >
        {/* the 0..1 frame and the two handles from the diagonal */}
        <rect x={p0.x} y={p1.y} width={p1.x - p0.x} height={p0.y - p1.y} fill="none" className="stroke-line-strong" strokeDasharray="3 3" />
        <line x1={p0.x} y1={p0.y} x2={c1.x} y2={c1.y} className="stroke-fg-subtle" strokeWidth={1} />
        <line x1={p1.x} y1={p1.y} x2={c2.x} y2={c2.y} className="stroke-fg-subtle" strokeWidth={1} />
        <path d={curvePath(spec, BOX)} fill="none" className="stroke-accent" strokeWidth={2} strokeLinecap="round" />
        {([[c1, 0], [c2, 1]] as const).map(([c, which]) => (
          <circle
            key={which}
            cx={c.x}
            cy={c.y}
            r={HANDLE_R}
            tabIndex={0}
            role="button"
            aria-label={`Control point ${which + 1}`}
            className="cursor-grab fill-raised stroke-accent outline-none focus-visible:stroke-fg active:cursor-grabbing"
            strokeWidth={2}
            onPointerDown={down(which)}
            onKeyDown={key(which)}
          />
        ))}
      </svg>
      <code className="truncate text-[11px] text-fg-subtle" title={spec}>{preset === "custom" ? spec : EASING_LABELS[preset] ?? spec}</code>
    </div>
  );
}
