import { useMemo } from "react";
import type { Template } from "../templates/catalog";
import type { FillLite, NodeLite } from "../store/types";

// A TEMPLATE'S PREVIEW: the same BuiltTemplate that will end up in the document,
// drawn as a miniature diagram (the screens, their elements as solid
// fields, the text as little bars) with the flow arrows. No canvas and
// no network: an SVG computed from the data, so always faithful to the template.

const css = (f: FillLite | undefined): string =>
  f ? `rgb(${Math.round(f.r * 255)} ${Math.round(f.g * 255)} ${Math.round(f.b * 255)})` : "none";

interface Box { id: string; x: number; y: number; w: number; h: number; n: NodeLite }

const cache = new Map<string, ReturnType<typeof layout>>();

function layout(t: Template) {
  let i = 0;
  const built = t.build("page", () => `p${++i}`);
  const byId = new Map<string, NodeLite>(built.nodes.map((n) => [n.id, n]));
  // ABSOLUTE positions: node coordinates are relative to the parent.
  const abs = new Map<string, Box>();
  for (const n of built.nodes) {
    const p = abs.get(n.parentId);
    abs.set(n.id, { id: n.id, x: (p?.x ?? 0) + n.x, y: (p?.y ?? 0) + n.y, w: n.width, h: n.height, n });
  }
  const screens = built.nodes.filter((n) => n.parentId === "page");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of screens) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width); maxY = Math.max(maxY, s.y + s.height);
  }
  return { built, byId, abs, screens, bounds: { minX, minY, maxX, maxY } };
}

export function TemplatePreview({ template, className = "" }: { template: Template; className?: string }) {
  const L = useMemo(() => {
    let c = cache.get(template.id);
    if (!c) { c = layout(template); cache.set(template.id, c); }
    return c;
  }, [template]);

  if (L.screens.length === 0) {
    // "Blank": a dashed board, with a plus sign.
    return (
      <svg viewBox="0 0 120 80" className={className} role="img" aria-label="Blank board">
        <rect x="34" y="12" width="52" height="56" rx="6" fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="4 3" />
        <path d="M60 33v14M53 40h14" stroke="var(--fg-subtle)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  const { minX, minY, maxX, maxY } = L.bounds;
  const pad = 40;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;
  return (
    <svg viewBox={vb} preserveAspectRatio="xMidYMid meet" className={className} role="img" aria-label={`Anteprima: ${template.name}`}>
      {L.screens.map((s) => (
        <g key={s.id}>
          <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={26} fill={css(s.fills[0])} stroke="var(--line-strong)" strokeWidth={5} />
        </g>
      ))}
      {L.built.nodes.filter((n) => n.parentId !== "page").map((n) => {
        const b = L.abs.get(n.id)!;
        if (n.kind === "text") {
          // The text as a little bar: length ~ number of characters, never beyond the box.
          const size = n.text?.style.fontSize ?? 14;
          const len = Math.min(b.w, (n.text?.content.length ?? 4) * size * 0.52);
          const align = n.text?.style.align ?? "left";
          const x = align === "center" ? b.x + (b.w - len) / 2 : align === "right" ? b.x + b.w - len : b.x;
          const h = Math.max(size * 0.55, 8);
          return <rect key={n.id} x={x} y={b.y + (b.h - h) / 2} width={len} height={h} rx={h / 2} fill={css(n.fills[0])} opacity={0.5} />;
        }
        const fill = n.fills.length > 0 ? css(n.fills[0]) : "none";
        const stroke = n.strokes.length > 0 ? css(n.strokes[0].color) : "none";
        if (n.kind === "ellipse") return <ellipse key={n.id} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={fill} />;
        return <rect key={n.id} x={b.x} y={b.y} width={b.w} height={b.h} rx={n.cornerRadius} fill={fill} stroke={stroke} strokeWidth={stroke === "none" ? 0 : 2} />;
      })}
      {L.built.transitions.map((t) => {
        const a = L.abs.get(t.fromId), z = L.abs.get(t.toId);
        if (!a || !z || a.id === z.id) return null;
        // From the right/left (or top/bottom) edge of a screen to the other,
        // with a curve: just an indication of where the flow goes.
        const forward = z.x > a.x;
        const sameRow = Math.abs(z.y - a.y) < 1;
        if (!sameRow) return null;
        const x1 = forward ? a.x + a.w : a.x;
        const x2 = forward ? z.x : z.x + z.w;
        // The "back" arrows run along the bottom so as not to cover the forward ones.
        const y = a.y + (forward ? a.h * 0.9 : a.h * 0.96);
        return (
          <path key={t.id} d={`M${x1} ${y} C${x1 + (x2 - x1) * 0.4} ${y} ${x1 + (x2 - x1) * 0.6} ${y} ${x2} ${y}`}
            fill="none" stroke="var(--flow)" strokeWidth={forward ? 7 : 5} strokeLinecap="round" opacity={forward ? 0.85 : 0.4} />
        );
      })}
    </svg>
  );
}
