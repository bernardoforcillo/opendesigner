import { create } from "zustand";

// VIEW PREFERENCES that belong to the person, not the document: kept in the browser, never sent.
// The pixel snap rounds a dragged or resized box to a grid of `pixelSnap` world units when no other
// node offers a line to snap to (0 = off). Alt turns snapping off for a gesture, this one included.

const KEY = "od.pixelSnap";
export const PIXEL_SNAP_STEPS = [0, 1, 4, 8] as const;

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (PIXEL_SNAP_STEPS as readonly number[]).includes(v) ? v : 0;
  } catch { return 0; }
}

export const useViewPrefs = create<{ pixelSnap: number; setPixelSnap: (n: number) => void; cyclePixelSnap: () => void }>((set, get) => ({
  pixelSnap: read(),
  setPixelSnap: (pixelSnap) => {
    try { localStorage.setItem(KEY, String(pixelSnap)); } catch { /* no storage */ }
    set({ pixelSnap });
  },
  cyclePixelSnap: () => {
    const i = PIXEL_SNAP_STEPS.indexOf(get().pixelSnap as (typeof PIXEL_SNAP_STEPS)[number]);
    get().setPixelSnap(PIXEL_SNAP_STEPS[(i + 1) % PIXEL_SNAP_STEPS.length]);
  },
}));

/** `v` rounded to the grid (a step of 0 leaves it as it is). */
export function roundToGrid(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}
