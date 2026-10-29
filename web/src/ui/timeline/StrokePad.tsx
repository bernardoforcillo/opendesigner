import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/ds";
import { encodeStrokes, parseStrokes, simplify, strokesFit, type Pt, type Stroke } from "@/animation/fx/paint";

// A drawing pad for the Paint effect: strokes are recorded in fractions of the node's box (aspect = width / height) and kept as the
// effect's `strokes` string (animation/fx/paint.ts). Draw with the pointer; Undo takes the last stroke off.

const PAD_W = 360;

export function StrokePad({ value, aspect, onChange }: { value: string; aspect: number; onChange: (v: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef<Pt[] | null>(null);
  const [color, setColor] = useState("#e5484d");
  const [size, setSize] = useState(24); // thousandths of the shorter side
  const [full, setFull] = useState(false);
  const strokes = parseStrokes(value);
  const w = PAD_W, h = Math.max(60, Math.round(PAD_W / Math.max(0.2, Math.min(5, aspect))));

  const paintAll = (extra?: Stroke) => {
    const ctx = ref.current?.getContext?.("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const u = Math.min(w, h);
    for (const s of extra ? [...strokes, extra] : strokes) {
      ctx.strokeStyle = s.color; ctx.globalAlpha = s.opacity; ctx.lineWidth = Math.max(1, s.size * u); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * w, p.y * h) : ctx.lineTo(p.x * w, p.y * h)));
      if (s.points.length === 1) ctx.lineTo(s.points[0].x * w, s.points[0].y * h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  useEffect(() => paintAll());

  const at = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) };
  };
  const current = (): Stroke => ({ size: size / 1000, color, opacity: 1, points: simplify(live.current ?? [], 0.003) });
  const finish = () => {
    if (!live.current) return;
    const next = [...strokes, current()];
    live.current = null;
    if (strokesFit(next)) { setFull(false); onChange(encodeStrokes(next)); } else { setFull(true); paintAll(); }
  };

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={ref} width={w} height={h} aria-label="Paint pad" role="img" style={{ width: w, height: h, touchAction: "none" }}
        className="rounded-md border border-line bg-surface-2"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); live.current = [at(e)]; paintAll(current()); }}
        onPointerMove={(e) => { if (live.current) { live.current.push(at(e)); paintAll(current()); } }}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      <div className="flex items-center gap-2 text-[12px]">
        <input type="color" aria-label="Brush color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input type="range" aria-label="Brush size" min={4} max={120} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        <Button onPress={() => onChange(encodeStrokes(strokes.slice(0, -1)))} isDisabled={strokes.length === 0}>Undo</Button>
        <Button onPress={() => onChange("")} isDisabled={strokes.length === 0}>Clear</Button>
        <span role="status" className="text-fg-subtle">{full ? "The strokes are full: undo one to paint more." : `${strokes.length} stroke${strokes.length === 1 ? "" : "s"}`}</span>
      </div>
    </div>
  );
}
