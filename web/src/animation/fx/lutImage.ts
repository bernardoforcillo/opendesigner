// The CanvasKit side of fx/stats.ts: reading a small copy of an image back to count it, and turning a lookup table into the
// shader a lutKern effect samples. Shared by the renderer and the tests.

import type { CanvasKit, Image, Shader } from "canvaskit-wasm";
import { histogram, type Histogram } from "@/animation/fx/stats";

const MAX_SIDE = 256;

/** Histogram of `img` (unpremultiplied), from a copy scaled down to at most 256 px on the long side. */
export function readHistogram(CK: CanvasKit, img: Image): Histogram | null {
  const k = Math.min(1, MAX_SIDE / Math.max(img.width(), img.height(), 1));
  const w = Math.max(1, Math.round(img.width() * k)), h = Math.max(1, Math.round(img.height() * k));
  const small = CK.MakeSurface(w, h);
  if (!small) return null;
  const c = small.getCanvas();
  c.clear(CK.TRANSPARENT);
  const p = new CK.Paint();
  c.drawImageRect(img, CK.XYWHRect(0, 0, img.width(), img.height()), CK.XYWHRect(0, 0, w, h), p);
  p.delete();
  const px = c.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array | null;
  small.delete();
  return px ? histogram(px) : null;
}

/** The shader for a 256 x 2 lookup table (sampled with pixel coordinates: x = value * 255 + 0.5, y = row + 0.5). The image is returned so it can be freed. */
export function makeLutShader(CK: CanvasKit, bytes: Uint8Array): { image: Image; shader: Shader } | null {
  const image = CK.MakeImage({ width: 256, height: 2, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Opaque, colorSpace: CK.ColorSpace.SRGB }, bytes, 256 * 4);
  if (!image) return null;
  return { image, shader: image.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Nearest, CK.MipmapMode.None) };
}
