import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { encodePng, pngDataUri } from "./rawPng";

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const out: { type: string; data: Uint8Array }[] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let o = 8; o < png.length; ) {
    const len = dv.getUint32(o);
    out.push({ type: String.fromCharCode(...png.subarray(o + 4, o + 8)), data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

describe("encodePng", () => {
  it("writes a PNG that decodes back to the pixels", () => {
    const w = 3, h = 2;
    const px = Uint8ClampedArray.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128,
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const png = encodePng(w, h, px);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const ihdr = new DataView(cs[0].data.buffer, cs[0].data.byteOffset);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), cs[0].data[8], cs[0].data[9]]).toEqual([3, 2, 8, 6]);
    const raw = inflateSync(Buffer.from(cs[1].data)); // also checks the zlib header and Adler-32
    expect(raw.length).toBe(h * (w * 4 + 1));
    expect(Array.from(raw.subarray(1, 13))).toEqual(Array.from(px.subarray(0, 12)));
    expect(raw[13]).toBe(0);
    expect(Array.from(raw.subarray(14, 26))).toEqual(Array.from(px.subarray(12, 24)));
  });

  it("splits data longer than one stored block, and checks the size", () => {
    const w = 200, h = 100;
    const px = new Uint8ClampedArray(w * h * 4).map((_, i) => i % 251);
    const raw = inflateSync(Buffer.from(chunks(encodePng(w, h, px))[1].data));
    expect(raw.length).toBe(h * (w * 4 + 1));
    expect(raw[raw.length - 1]).toBe(px[px.length - 1]);
    expect(() => encodePng(2, 2, new Uint8ClampedArray(3))).toThrow();
  });

  it("makes a data URI", () => {
    const uri = pngDataUri(encodePng(1, 1, Uint8ClampedArray.from([1, 2, 3, 4])));
    expect(uri.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
  });
});
