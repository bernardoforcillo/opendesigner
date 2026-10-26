import type { FillLite, NodeLite, SceneState } from "@/store/types";
import { rgbToCmyk } from "@/color/cmyk";
import { num, pdfName, type PdfFile } from "@/pdf/write/pdfFile";

// COLOUR IN A PDF. Three kinds of paint come out of a document:
//   - a swatch with a CMYK definition  -> DeviceCMYK (the numbers the user typed, untouched);
//   - a spot swatch (or a tint of one) -> a Separation colour space named after the spot, so a
//     printer gets a real separation plate, with DeviceCMYK as the on-screen alternate;
//   - anything else                    -> DeviceRGB, or DeviceCMYK through the plain device
//     conversion when the document's colour mode is CMYK.
// A swatch is known by the node's binding on the paint slot (`fills.0` / `strokes.0`). There is no ICC
// profile applied -- the profile is recorded as the output intent's name only.

export type PdfPaint =
  | { kind: "rgb"; r: number; g: number; b: number }
  | { kind: "cmyk"; c: number; m: number; y: number; k: number } // 0..1
  | { kind: "spot"; name: string; alt: [number, number, number, number]; tint: number }; // alt 0..1, tint 0..1

const c01 = (v: number) => Math.min(1, Math.max(0, v));

export class PdfColors {
  /** Spot names in use and whether the file uses RGB / CMYK: the preflight and the output intent read these. */
  readonly spots = new Set<string>();
  usesRgb = false;
  usesCmyk = false;
  private spaces = new Map<string, string>(); // spot name -> resource name
  private n = 0;

  constructor(private scene: Pick<SceneState, "variables" | "collections">, readonly cmykDocument: boolean) {}

  /** The paint for a node's paint slot whose resolved value is `f`. */
  paintOf(n: NodeLite, slot: string, f: { r: number; g: number; b: number }): PdfPaint {
    const id = n.bindings?.[slot];
    const v = id ? this.scene.variables[id] : undefined;
    if (v?.swatch) {
      const base = v.tintOf ? this.scene.variables[v.tintOf] : v;
      const tint = v.tintOf ? c01((v.tint ?? 100) / 100) : 1;
      const cm = base?.cmyk;
      if (base?.spotName && cm) return { kind: "spot", name: base.spotName, alt: [cm.c, cm.m, cm.y, cm.k], tint };
      if (cm) return { kind: "cmyk", c: cm.c * tint, m: cm.m * tint, y: cm.y * tint, k: cm.k * tint };
    }
    if (this.cmykDocument) {
      const k = rgbToCmyk(f);
      return { kind: "cmyk", c: k.c / 100, m: k.m / 100, y: k.y / 100, k: k.k / 100 };
    }
    return { kind: "rgb", r: c01(f.r), g: c01(f.g), b: c01(f.b) };
  }

  /** Fill (`stroke` false) or stroke colour operators for `p`. */
  ops(p: PdfPaint, stroke: boolean): string {
    if (p.kind === "rgb") { this.usesRgb = true; return `${num(p.r)} ${num(p.g)} ${num(p.b)} ${stroke ? "RG" : "rg"}\n`; }
    if (p.kind === "cmyk") { this.usesCmyk = true; return `${num(p.c)} ${num(p.m)} ${num(p.y)} ${num(p.k)} ${stroke ? "K" : "k"}\n`; }
    this.spots.add(p.name);
    let res = this.spaces.get(p.name);
    if (!res) { res = `CS${++this.n}`; this.spaces.set(p.name, res); this.alt.set(p.name, p.alt); }
    return `${pdfName(res)} ${stroke ? "CS" : "cs"} ${num(p.tint)} ${stroke ? "SCN" : "scn"}\n`;
  }

  private alt = new Map<string, [number, number, number, number]>();

  /** A solid RGB colour (gradient stops, placeholders, marks) -- no swatch involved. */
  rgbOps(f: Pick<FillLite, "r" | "g" | "b">, stroke: boolean): string {
    return this.ops(this.cmykDocument ? this.plainCmyk(f) : { kind: "rgb", r: c01(f.r), g: c01(f.g), b: c01(f.b) }, stroke);
  }

  private plainCmyk(f: { r: number; g: number; b: number }): PdfPaint {
    const k = rgbToCmyk(f);
    return { kind: "cmyk", c: k.c / 100, m: k.m / 100, y: k.y / 100, k: k.k / 100 };
  }

  /** The /ColorSpace resource entries: one Separation per spot. */
  emit(file: PdfFile): string {
    let out = "";
    for (const [name, res] of this.spaces) {
      const [c, m, y, k] = this.alt.get(name)!;
      const fn = file.add(`<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[${num(c)} ${num(m)} ${num(y)} ${num(k)}]/N 1>>`);
      out += `${pdfName(res)} [/Separation${pdfName(name)}/DeviceCMYK ${fn} 0 R] `;
    }
    return out;
  }
}
