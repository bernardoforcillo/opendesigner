import { afterEach, describe, expect, it } from "vitest";
import { activeConverter, resetActiveProfile, setActiveProfile, syncActiveProfile } from "@/color/activeProfile";
import { cmykToRgb } from "@/color/cmyk";
import { wrapIccFile } from "@/color/profileAsset";

afterEach(resetActiveProfile);

const stub = { colorSpace: "CMYK" as const, description: "Stub", rgbToCmyk: () => ({ c: 1, m: 2, y: 3, k: 4 }), cmykToRgb: () => ({ r: 0.5, g: 0.5, b: 0.5 }) };
const bytes = new Uint8Array(200);
new DataView(bytes.buffer).setUint32(0, 200);
bytes.set([..."CMYK"].map((c) => c.charCodeAt(0)), 16);
bytes.set([..."acsp"].map((c) => c.charCodeAt(0)), 36);
const dataUrl = (b: Uint8Array) => `data:application/x-opendesigner-icc;base64,${btoa(String.fromCharCode(...b))}`;

describe("the active profile", () => {
  it("is the plain conversion until a usable profile is installed", () => {
    expect(activeConverter().managed).toBe(false);
    expect(activeConverter().cmykToRgb({ c: 0, m: 100, y: 0, k: 0 })).toEqual(cmykToRgb({ c: 0, m: 100, y: 0, k: 0 }));
    setActiveProfile({ bytes, components: 4, managed: stub });
    expect(activeConverter()).toMatchObject({ managed: true, profileName: "Stub" });
    expect(activeConverter().rgbToCmyk({ r: 0, g: 0, b: 0 })).toEqual({ c: 1, m: 2, y: 3, k: 4 });
    setActiveProfile({ bytes, components: 4, managed: null }); // embeddable but not convertible
    expect(activeConverter().managed).toBe(false);
  });

  it("loads once per document and hash, and falls back to plain when the asset is missing or not a profile", async () => {
    let calls = 0;
    const load = async () => { calls++; return dataUrl(wrapIccFile(bytes)); };
    await syncActiveProfile("d", "a".repeat(64), load);
    await syncActiveProfile("d", "a".repeat(64), load);
    expect(calls).toBe(1);
    await syncActiveProfile("d", "b".repeat(64), async () => null);
    expect(activeConverter().managed).toBe(false);
    await syncActiveProfile("d", "c".repeat(64), async () => { throw new Error("offline"); });
    expect(activeConverter().managed).toBe(false);
    await syncActiveProfile("d", "", load);
    expect(activeConverter().managed).toBe(false);
  });
});
