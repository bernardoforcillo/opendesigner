import type { MeshLite } from "../store/types";

// MESH GRADIENTS, rasterized. A mesh is a small grid of colors; every renderer wants it as an image
// it can stretch over the node's box (the browser's smoothing or the GPU's sampling does the rest),
// so the blend lives here once: a SIZE x SIZE bitmap where pixel (i, j) holds the bilinear mix of the
// four grid points around it. Colors are blended in premultiplied space so a transparent corner
// fades out instead of going gray.

export const MESH_BITMAP_SIZE = 64;

/**
 * RGBA bytes (straight alpha) of the mesh at `size` x `size`, plus `pad` pixels on every side that
 * repeat the nearest edge (a texture stretched over a box must not fade out at its border).
 */
export function meshBitmap(mesh: MeshLite, size = MESH_BITMAP_SIZE, pad = 0): Uint8ClampedArray {
  const { rows, cols, colors } = mesh;
  const total = size + pad * 2;
  const out = new Uint8ClampedArray(total * total * 4);
  const at = (r: number, c: number) => colors[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))] ?? { r: 0, g: 0, b: 0, a: 0 };
  const clamp = (x: number, max: number) => Math.min(max, Math.max(0, x));
  for (let j = 0; j < total; j++) {
    const v = clamp((j - pad + 0.5) / size * (rows - 1), rows - 1);
    const r0 = Math.min(rows - 2, Math.floor(v)), fv = v - r0;
    for (let i = 0; i < total; i++) {
      const u = clamp((i - pad + 0.5) / size * (cols - 1), cols - 1);
      const c0 = Math.min(cols - 2, Math.floor(u)), fu = u - c0;
      const p = [at(r0, c0), at(r0, c0 + 1), at(r0 + 1, c0), at(r0 + 1, c0 + 1)];
      const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        a += p[k].a * w[k];
        r += p[k].r * p[k].a * w[k];
        g += p[k].g * p[k].a * w[k];
        b += p[k].b * p[k].a * w[k];
      }
      const o = (j * total + i) * 4;
      if (a > 0) { out[o] = (r / a) * 255; out[o + 1] = (g / a) * 255; out[o + 2] = (b / a) * 255; }
      out[o + 3] = a * 255;
    }
  }
  return out;
}

/** A default mesh: a `rows` x `cols` grid of the one color, with the corners tinted so there is something to edit. */
export function defaultMesh(base: { r: number; g: number; b: number; a: number }, rows = 3, cols = 3): MeshLite {
  const colors: MeshLite["colors"] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Lighter toward the top-left, darker toward the bottom-right: visibly a mesh from the first frame.
      const t = (r / Math.max(1, rows - 1) + c / Math.max(1, cols - 1)) / 2;
      const k = 1.25 - t * 0.6;
      colors.push({ r: Math.min(1, base.r * k), g: Math.min(1, base.g * k), b: Math.min(1, base.b * k), a: base.a });
    }
  }
  return { rows, cols, colors };
}

/** The same grid at another size: each new point takes the bilinear value of the old mesh at that place. */
export function resizeMesh(mesh: MeshLite, rows: number, cols: number): MeshLite {
  const colors: MeshLite["colors"] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = (r / Math.max(1, rows - 1)) * (mesh.rows - 1), u = (c / Math.max(1, cols - 1)) * (mesh.cols - 1);
      const r0 = Math.min(mesh.rows - 2, Math.floor(v)), c0 = Math.min(mesh.cols - 2, Math.floor(u));
      const fv = v - r0, fu = u - c0;
      const q = (rr: number, cc: number) => mesh.colors[rr * mesh.cols + cc];
      const mix = (k: "r" | "g" | "b" | "a") =>
        q(r0, c0)[k] * (1 - fu) * (1 - fv) + q(r0, c0 + 1)[k] * fu * (1 - fv) + q(r0 + 1, c0)[k] * (1 - fu) * fv + q(r0 + 1, c0 + 1)[k] * fu * fv;
      colors.push({ r: mix("r"), g: mix("g"), b: mix("b"), a: mix("a") });
    }
  }
  return { rows, cols, colors };
}

/** The mean color of a mesh (what code export and the fallbacks show). */
export function meshAverage(colors: MeshLite["colors"]): { r: number; g: number; b: number; a: number } {
  const n = Math.max(1, colors.length);
  return colors.reduce((s, c) => ({ r: s.r + c.r / n, g: s.g + c.g / n, b: s.b + c.b / n, a: s.a + c.a / n }), { r: 0, g: 0, b: 0, a: 0 });
}
