import { drawScene, type ImageSource } from "../renderer/canvasRenderer";
import type { ExportRegion } from "./region";

// PNG EXPORT — an OFFSCREEN canvas, at the chosen scale.
//
// The drawing is done by `drawScene`, that is the canvas's renderer, not a second
// copy written for the export. It is the only way for the exported image to stay
// faithful as the editor grows: every shape, every style and every fix that
// will arrive in the renderer will arrive here too, without anyone having to
// remember to update two places. The price is a `SceneState` reduced to the
// nodes to export (built by export/region.ts) and a camera BUILT
// instead of read -- which is also how the export stops depending
// on where the user had scrolled.

// The scales offered. 1x/2x/3x are the densities that really matter (normal
// screen, retina, high-density phone); a free multiplier
// would only add ways to get it wrong.
export const EXPORT_SCALES = [1, 2, 3] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

// THE CANVAS CAP, and why we need a check of OUR OWN.
//
// A canvas that is too large does not fail the same way everywhere. Firefox
// does not allocate and `getContext("2d")` returns `null` -- loud, and it is caught by
// the check further below. Chrome instead returns a REGULAR context on a
// bitmap that does not exist: `drawScene` draws without errors, nothing is seen,
// and `toBlob` produces a valid and EMPTY PNG. Without this cap the user
// would download a white image without a single message -- the worst way
// to fail, because it looks successful.
//
// The two numbers are real engine limits, not estimates, and there are TWO because
// engines impose two independent ones:
//   - 32,767 px per SIDE: the tightest of the per-side limits in circulation
//     (Firefox; Chrome and Safari reach 65,535). A 40,000 × 100 ribbon has
//     a tiny area and is impossible all the same.
//   - 268,435,456 px of AREA (2^28, Chrome's limit, the tightest among
//     the area ones): it is what a region of 6000 × 6000 units at 3x
//     exceeds, with 324 Mpx and no side out of range.
// Below both the canvas is allocated; above there would be more than a
// billion bytes of pixels to encode anyway.
export const MAX_CANVAS_SIDE = 32_767;
export const MAX_CANVAS_AREA = 268_435_456;

function megapixels(px: number): string {
  return `${(px / 1e6).toFixed(1)} Mpx`;
}

/**
 * `null` if a canvas of `width × height` is allocatable, otherwise the REASON
 * why it is not -- already written to be read by the user, because it is
 * exactly what `runExport` will do with it (a `notice`, like every other
 * way this export can fail).
 *
 * The message states the requested size, the limit and the ways out: a
 * warning that only said "too large" would leave the user guessing.
 */
export function canvasLimitMessage(width: number, height: number): string | null {
  const area = width * height;
  if (width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && area <= MAX_CANVAS_AREA) return null;
  return (
    `the requested image is too large: ${width}×${height} px (${megapixels(area)}), ` +
    `beyond the browser's canvas limit (${MAX_CANVAS_SIDE} px per side, ` +
    `${megapixels(MAX_CANVAS_AREA)} in total); ` +
    `choose a lower scale, export a smaller selection, or use SVG`
  );
}

function defaultCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

/**
 * Draws the region on an offscreen canvas of `bounds * scale` pixels.
 *
 * The canvas is created by injection so the computation stays verifiable without a
 * real 2D context (jsdom has none): the proof that the PIXELS are right
 * comes from browser verification, what can be done here is that the canvas
 * is the right size and transformed the right way.
 *
 * `images` are the assets ALREADY resolved and ALREADY awaited (prepared by
 * export/exportScene.ts). They must be passed: `drawScene` is synchronous and without a
 * ready source it would draw the placeholder, so leaving it at its default
 * -- the renderer's shared cache, which fills when it can -- would mean
 * a file that depends on what this session has already seen go by.
 */
export function renderRegionToCanvas(
  region: ExportRegion,
  scale: number,
  createCanvas: () => HTMLCanvasElement = defaultCanvas,
  images?: ImageSource,
): HTMLCanvasElement {
  const { bounds } = region;
  // ROUNDING UP, and never below 1: rounding down would crop the last
  // fraction of a pixel of the drawing, and a canvas with a zero side makes
  // toBlob fail instead of producing an empty image.
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));

  // The cap is checked BEFORE allocating: beyond the limit Chrome does not
  // fail, it draws into the void (see MAX_CANVAS_AREA). The error becomes a
  // warning in runExport, like every other way the export fails.
  const tooBig = canvasLimitMessage(width, height);
  if (tooBig) throw new Error(tooBig);

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("the export canvas's 2D context is not available");

  // The export camera: zoom = chosen scale, origin moved to the region's
  // corner. It is not the user's camera and does not read it -- it is built
  // here on purpose. Together with the images resolved by the caller it is what
  // guarantees that two exports of the same document give the same file: neither
  // where the view is, nor what has already gone through the screen.
  //
  // dpr: 1 because an offscreen canvas has no device. The scale is
  // decided by the user (1x/2x/3x) and the machine's devicePixelRatio must not
  // multiply it.
  drawScene(
    ctx,
    region.scene,
    { x: -bounds.x * scale, y: -bounds.y * scale, zoom: scale },
    { dpr: 1, images },
  );
  return canvas;
}

/**
 * The canvas's PNG bytes. `toBlob` is asynchronous and may answer `null` (memory
 * exhausted, tainted canvas): it becomes an error, because downloading an
 * empty file would be worse than a message.
 */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG encoding produced no data"));
    }, "image/png");
  });
}
