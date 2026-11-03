// THE EDITOR'S ACTIVE OUTPUT PROFILE. The document's ICC profile (DocSettings.icc_profile_asset) is fetched once per
// (document, hash) and kept here, so the colour fields, the swatch panel and the swatch ops convert RGB <-> CMYK through
// it. Until it has loaded -- or when the document has none, or one this reader cannot use -- the converter is the plain
// device one (color/cmyk.ts). The PDF export loads the profile itself (export/printPdf.ts) and does not depend on this.
// Plain module state with no UI imports, so the ops can read it; the React hook is in color/useCmykConverter.ts.

import { cmykToRgb, rgbToCmyk, type Cmyk, type Rgb } from "@/color/cmyk";
import { dataUrlBytes } from "@/pdf/write/pdfImages";
import { loadStoredProfile, type LoadedProfile } from "@/color/profileAsset";

export interface CmykConverter {
  rgbToCmyk(rgb: Rgb): Cmyk;
  cmykToRgb(cmyk: Cmyk): Rgb;
  /** True when the conversion goes through an ICC profile. */
  managed: boolean;
  /** The profile's own name, "" when there is none. */
  profileName: string;
}

const plain: CmykConverter = { rgbToCmyk, cmykToRgb, managed: false, profileName: "" };

let current: CmykConverter = plain;
let key = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The converter in force now (plain until a profile has loaded). */
export const activeConverter = (): CmykConverter => current;

export function subscribeActiveProfile(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Installs a loaded profile as the active one (null, or one without usable tables, = back to the plain conversion). */
export function setActiveProfile(profile: LoadedProfile | null): void {
  const m = profile?.managed;
  current = m ? { rgbToCmyk: (c) => m.rgbToCmyk(c), cmykToRgb: (c) => m.cmykToRgb(c), managed: true, profileName: m.description } : plain;
  emit();
}

/** Loads the profile named by `hash` for `docId` (once per pair); "" clears it. Failures leave the plain conversion. */
export async function syncActiveProfile(docId: string, hash: string, load: (docId: string, hash: string) => Promise<string | null>): Promise<void> {
  const next = hash ? `${docId}/${hash}` : "";
  if (next === key) return;
  key = next;
  if (!hash) { setActiveProfile(null); return; }
  try {
    const uri = await load(docId, hash);
    if (key !== next) return; // a newer request superseded this one
    const data = uri === null ? null : dataUrlBytes(uri);
    setActiveProfile(loadStoredProfile(data ? data.bytes : null));
  } catch {
    if (key === next) setActiveProfile(null);
  }
}

/** For tests: forget everything. */
export function resetActiveProfile(): void { key = ""; current = plain; emit(); }
