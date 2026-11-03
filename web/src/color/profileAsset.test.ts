import { describe, expect, it } from "vitest";
import { loadProfile, loadStoredProfile, unwrapIccFile, wrapIccFile } from "@/color/profileAsset";

// A header-only profile: enough for `iccComponents`, not for `parseIcc` (no tables), which is the "usable by the PDF
// intent but not for conversion" case.
function headerOnly(space: string): Uint8Array {
  const out = new Uint8Array(200);
  new DataView(out.buffer).setUint32(0, 200);
  out.set([...space].map((c) => c.charCodeAt(0)), 16);
  out.set([..."acsp"].map((c) => c.charCodeAt(0)), 36);
  return out;
}

describe("the profile asset container", () => {
  it("wraps and unwraps a profile", () => {
    const p = headerOnly("CMYK");
    const w = wrapIccFile(p);
    expect(new TextDecoder().decode(w.subarray(0, 6))).toBe("ODICC\n");
    expect(unwrapIccFile(w)).toEqual(p);
  });

  it("refuses bytes that are not wrapped", () => {
    expect(unwrapIccFile(headerOnly("CMYK"))).toBeNull();
    expect(unwrapIccFile(new Uint8Array(2))).toBeNull();
    expect(loadStoredProfile(null)).toBeNull();
    expect(loadStoredProfile(headerOnly("CMYK"))).toBeNull();
  });

  it("reads the component count and keeps the bytes even when the tables are unusable", () => {
    const loaded = loadStoredProfile(wrapIccFile(headerOnly("CMYK")));
    expect(loaded?.components).toBe(4);
    expect(loaded?.managed).toBeNull();
    expect(loadProfile(headerOnly("RGB "))?.components).toBe(3);
    expect(loadProfile(new Uint8Array(300))).toBeNull();
  });
});
