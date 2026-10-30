// THE DOCUMENT'S OUTPUT PROFILE AS AN ASSET. The ICC file lives in the document's asset store like an image does
// (DocSettings.icc_profile_asset is its hash). The server only keeps files whose container it knows, and a profile's own
// signature is at byte 36, so the editor uploads it wrapped: "ODICC\n" + the profile (internal/store/assets.go).
// Reading goes through the same wrapper. See docs/color-management.md.

import { iccComponents, parseIcc, type IccProfile } from "@/color/icc";

export const ICC_MAGIC = "ODICC\n";
/** A profile this big is not a printer profile worth keeping in a document (the biggest ship around 2 MB). */
export const MAX_ICC_BYTES = 4 << 20;

export function wrapIccFile(bytes: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(ICC_MAGIC);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}

export function unwrapIccFile(bytes: Uint8Array): Uint8Array | null {
  const head = new TextEncoder().encode(ICC_MAGIC);
  if (bytes.length < head.length) return null;
  for (let i = 0; i < head.length; i++) if (bytes[i] !== head[i]) return null;
  return bytes.subarray(head.length);
}

/** What a document's profile gives the exporters: the raw bytes to embed and, when this reader can use it, the conversion. */
export interface LoadedProfile {
  bytes: Uint8Array;
  components: 3 | 4;
  managed: IccProfile | null;
}

/** Reads a plain ICC file (as a person picks it); null when it is not a profile. */
export function loadProfile(bytes: Uint8Array): LoadedProfile | null {
  const components = iccComponents(bytes);
  return components ? { bytes, components, managed: parseIcc(bytes) } : null;
}

/** Reads the profile out of a stored asset (the wrapped form); null when the asset is missing or not a profile. */
export function loadStoredProfile(stored: Uint8Array | null): LoadedProfile | null {
  const raw = stored ? unwrapIccFile(stored) : null;
  return raw ? loadProfile(raw) : null;
}
