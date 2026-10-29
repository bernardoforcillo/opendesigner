// THE PAINT EFFECT: brush strokes recorded on a pad (ui/timeline/EffectTextDialog.tsx) and drawn over the node, with the write-on that
// reveals them in the order they were painted. The strokes are the string parameter `strokes` (fx/paint.ts).

import type { FxDef } from "@/animation/fx/library";
import { P, pad, KHEAD } from "@/animation/fx/kit";
import { parseStrokes, writeOn } from "@/animation/fx/paint";

const CLEAR = `${KHEAD}\nhalf4 main(float2 xy) { return half4(0.0); }`;

export const PAINT_FX: FxDef[] = [
  {
    id: "ec.paint.paint",
    params: [
      P("writeOn", "Write On", 0, 100, 100, 0.5, "%"), P("opacity", "Opacity", 0, 100, 100, 1, "%"),
      P("brushScale", "Brush Size", 10, 400, 100, 1, "%"), P("onTransparent", "Paint on Transparent", 0, 1, 0),
    ],
    strings: [{ id: "strokes", label: "Strokes", default: "", strokes: true }],
    outset: () => 32,
    // "paint on transparent": the node's own pixels are taken away and only the strokes stay
    kernel: (v) => (v.onTransparent > 0.5 ? { sksl: CLEAR, uniforms: pad([]) } : { sksl: CLEAR, uniforms: pad([]), skip: true }),
    paint: (v, s) => ({
      strokes: writeOn(parseStrokes(s.strokes ?? ""), v.writeOn / 100).map((k) => ({ ...k, size: k.size * v.brushScale / 100 })),
      opacity: v.opacity / 100,
    }),
  },
];
