// TEXT EFFECTS with real strings. The text is a string parameter (animation/fx/props.ts: stored in a track's name, edited in a
// dialog), and it is drawn with the editor's own fonts as a text node over the node (renderer/ck/ckRenderer.ts::drawFxText), so
// wrapping, kerning, weights, letter spacing and text on a path are the document's, not a bitmap font.

import type { FxDef, FxTextSpec } from "@/animation/fx/library";
import { P, hsvRgb } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");
const color = (h: number, s: number, v: number, a: number) => { const [r, g, b] = hsvRgb(h, s / 100, v / 100); return { r, g, b, a }; };

const FONT = { id: "font", label: "Font", default: "Inter" } as const;
const weightOf = (w: number) => String(Math.max(100, Math.min(900, Math.round(w / 100) * 100)));

/** A polyline for the built-in text paths, in units of the node's shorter side from its centre. */
export function builtInPath(shape: number, v: Readonly<Record<string, number>>): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const N = 96;
  if (shape === 4) { // line
    for (let i = 0; i <= N; i++) pts.push({ x: -0.5 + i / N, y: 0 });
  } else if (shape === 3) { // wave
    for (let i = 0; i <= N; i++) pts.push({ x: -0.5 + i / N, y: Math.sin((i / N) * Math.PI * 2) * v.amplitude });
  } else { // circle (1) and arc (2): clockwise from the top, `start` degrees round
    const sweep = shape === 1 ? 360 : v.sweep;
    for (let i = 0; i <= N; i++) {
      const a = ((v.start - 90 + (sweep * i) / N) * Math.PI) / 180;
      pts.push({ x: Math.cos(a) * v.radius, y: Math.sin(a) * v.radius });
    }
  }
  return pts;
}

const common = [
  P("size", "Size", 4, 600, 36), P("weight", "Weight", 100, 900, 400, 100), P("tracking", "Tracking", -50, 300, 0), P("lineSpacing", "Line Spacing", 0.6, 3, 1.2, 0.05),
  HUE("hue", "Fill Color (hue)", 0), P("sat", "Fill Saturation", 0, 100, 0), P("val", "Fill Brightness", 0, 100, 100), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
];

const spec = (v: Record<string, number>, s: Record<string, string>, over: Partial<FxTextSpec>): FxTextSpec => ({
  content: s.text ?? "", fontFamily: s.font ?? "Inter", fontWeight: weightOf(v.weight), fontSize: v.size, lineHeight: v.lineSpacing, letterSpacing: v.tracking / 100 * v.size * 0.1,
  align: "center", color: color(v.hue, v.sat, v.val, 1), opacity: v.opacity / 100, ax: 0.5, ay: 0.5, width: 1, ...over,
});

export const TEXT_FX: FxDef[] = [
  {
    id: "ec.obsolete.basictext",
    params: [...common, P("x", "Position X", -100, 200, 50, 0.5, "%"), P("y", "Position Y", -100, 200, 50, 0.5, "%"), P("align", "Align (0 Left, 1 Center, 2 Right)", 0, 2, 1), P("width", "Box Width", 5, 400, 100, 1, "%")],
    strings: [{ id: "text", label: "Text", default: "Text", multiline: true }, FONT],
    outset: (v) => v.size * 2,
    text: (v, s) => spec(v, s, { ax: v.x / 100, ay: v.y / 100, align: (["left", "center", "right"] as const)[Math.round(v.align)] ?? "center", width: v.width / 100 }),
  },
  {
    id: "ec.obsolete.pathtext",
    params: [
      ...common, P("shape", "Path (0 Layer if named else Circle, 1 Circle, 2 Arc, 3 Wave, 4 Line)", 0, 4, 0), P("radius", "Radius", 0.05, 1, 0.38, 0.01), P("sweep", "Arc Sweep", 10, 360, 180, 1, "°"),
      P("start", "Start Angle (0 = top)", -360, 360, 0, 1, "°"), P("amplitude", "Wave Height", 0, 0.5, 0.12, 0.01), P("x", "Center X", -100, 200, 50, 0.5, "%"), P("y", "Center Y", -100, 200, 50, 0.5, "%"),
    ],
    strings: [{ id: "text", label: "Text", default: "Text on a path", multiline: false }, FONT],
    layerOptional: true,
    outset: (v) => v.size * 3,
    text: (v, s) => spec(v, s, {
      ax: v.x / 100, ay: v.y / 100, align: "left",
      // shape 0 runs along the named layer; the renderer falls back to the circle when none is named
      path: Math.round(v.shape) === 0 ? "layer" : builtInPath(Math.round(v.shape), v),
    }),
  },
];
