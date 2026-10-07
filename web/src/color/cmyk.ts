// CMYK, for people who prepare things for print. HONEST SCOPE: this is the textbook device-independent
// conversion (K takes the darkness, C/M/Y what is left of each channel), not an ICC-managed one -- a
// printer's real inks and paper are described by a profile this editor does not apply, so a CMYK
// value here is a starting point for the print shop's own conversion, not a proof. The document keeps
// RGB (the model, the renderers and the exports are all RGB); CMYK is a way to read and write it.

export interface Rgb { r: number; g: number; b: number }
/** Percentages, 0..100. */
export interface Cmyk { c: number; m: number; y: number; k: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function rgbToCmyk({ r, g, b }: Rgb): Cmyk {
  const R = clamp01(r), G = clamp01(g), B = clamp01(b);
  const k = 1 - Math.max(R, G, B);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  const pct = (v: number) => Math.round(v * 1000) / 10;
  return { c: pct((1 - R - k) / (1 - k)), m: pct((1 - G - k) / (1 - k)), y: pct((1 - B - k) / (1 - k)), k: pct(k) };
}

export function cmykToRgb({ c, m, y, k }: Cmyk): Rgb {
  const C = clamp01(c / 100), M = clamp01(m / 100), Y = clamp01(y / 100), K = clamp01(k / 100);
  return { r: (1 - C) * (1 - K), g: (1 - M) * (1 - K), b: (1 - Y) * (1 - K) };
}

/** "cmyk(10% 20% 0% 5%)", for a design token or a spec. */
export function cmykString(c: Cmyk): string {
  return `cmyk(${c.c}% ${c.m}% ${c.y}% ${c.k}%)`;
}
