import { describe, it, expect, vi } from "vitest";
import type { CanvasKit } from "canvaskit-wasm";
import { FONT_WEIGHTS, FontBook, nearestWeight } from "./canvaskit";
import { skMatrix } from "./ckRenderer";

describe("nearestWeight", () => {
  it.each([
    ["", 400], ["normal", 400], ["lighter", 400], ["100", 400], ["300", 400], ["400", 400],
    ["500", 500], ["600", 600], ["700", 700], ["bold", 700], ["bolder", 700], ["800", 700], ["900", 700],
    ["  BOLD ", 700], ["garbage", 400],
  ])("%j -> %i", (css, want) => {
    expect(nearestWeight(css)).toBe(want);
  });

  it("without a value it falls back to normal, and the result is always a weight with a file", () => {
    expect(nearestWeight(undefined)).toBe(400);
    for (const css of ["", "1", "450", "550", "650", "750", "1000", "-5"]) {
      expect(FONT_WEIGHTS).toContain(nearestWeight(css));
    }
  });
});

// A fake CanvasKit, just enough for FontBook: it tracks what is created and freed.
function fakeCK() {
  const faces: { weight: string; deleted: boolean }[] = [];
  const fonts: { size: number; face: unknown; deleted: boolean }[] = [];
  const CK = {
    Typeface: {
      MakeFreeTypeFaceFromData: (data: ArrayBuffer) => {
        if (data.byteLength === 0) return null;
        const f = { weight: new TextDecoder().decode(data), deleted: false, delete() { this.deleted = true; } };
        faces.push(f);
        return f;
      },
    },
    Font: class {
      deleted = false;
      constructor(public face: unknown, public size: number) { fonts.push(this as never); }
      setSubpixel() {}
      setHinting() {}
      setEdging() {}
      delete() { this.deleted = true; }
    },
    FontHinting: { None: 0 },
    FontEdging: { SubpixelAntiAlias: 2 },
  } as unknown as CanvasKit;
  return { CK, faces, fonts };
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("FontBook", () => {
  it("without the base weight there is no font: ready() throws if it does not arrive", async () => {
    const { CK } = fakeCK();
    const book = new FontBook(CK, () => {}, async () => new ArrayBuffer(0));
    expect(book.fontFor("400", 16)).toBeNull();
    await expect(book.ready()).rejects.toThrow();
  });

  it("after ready() 400 is there; a missing weight uses the nearest and then arrives", async () => {
    const { CK, faces } = fakeCK();
    const onLoad = vi.fn();
    const urls: string[] = [];
    const book = new FontBook(CK, onLoad, async (u) => { urls.push(u); return enc(u); }, "/fonts/");
    await book.ready();
    expect(urls).toEqual(["/fonts/Inter-400.ttf"]);

    // 700 is not there: it draws with 400 and the download starts.
    const f1 = book.fontFor("bold", 20);
    expect(f1).not.toBeNull();
    expect((f1 as unknown as { face: { weight: string } }).face.weight).toBe("/fonts/Inter-400.ttf");
    await vi.waitFor(() => expect(urls).toContain("/fonts/Inter-700.ttf"));
    await vi.waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2)); // 400 e 700

    // Now 700 is ready and is used.
    const f2 = book.fontFor("bold", 20);
    expect((f2 as unknown as { face: { weight: string } }).face.weight).toBe("/fonts/Inter-700.ttf");
    expect(faces).toHaveLength(2);
  });

  it("does not download the same weight twice and reuses the Fonts per (weight, size)", async () => {
    const { CK, fonts } = fakeCK();
    let calls = 0;
    const book = new FontBook(CK, () => {}, async (u) => { calls++; return enc(u); });
    await book.ready();
    book.fontFor("600", 16);
    book.fontFor("600", 16);
    book.fontFor("600", 16);
    await vi.waitFor(() => expect(calls).toBe(2)); // 400 + 600, once
    expect(book.fontFor("400", 16)).toBe(book.fontFor("400", 16));
    expect(book.fontFor("400", 16)).not.toBe(book.fontFor("400", 17));
    expect(fonts.length).toBeGreaterThan(0);
  });

  it("a weight that does not download does not break the drawing: it stays on the nearest", async () => {
    const { CK } = fakeCK();
    const book = new FontBook(CK, () => {}, async (u) => {
      if (u.includes("700")) throw new Error("rete");
      return enc(u);
    });
    await book.ready();
    expect(() => book.fontFor("bold", 16)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    const f = book.fontFor("bold", 16) as unknown as { face: { weight: string } };
    expect(f.face.weight).toContain("400");
  });

  it("dispose() libera font e facce", async () => {
    const { CK, faces, fonts } = fakeCK();
    const book = new FontBook(CK, () => {}, async (u) => enc(u));
    await book.ready();
    book.fontFor("400", 16);
    book.dispose();
    expect(faces.every((f) => f.deleted)).toBe(true);
    expect(fonts.every((f) => f.deleted)).toBe(true);
    expect(book.fontFor("400", 16)).toBeNull();
  });
});

describe("skMatrix", () => {
  it("reorders (a b c d e f) from canvas 2D into a Skia 3x3 by rows", () => {
    // x' = a x + c y + e ; y' = b x + d y + f
    expect(skMatrix({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })).toEqual([1, 3, 5, 2, 4, 6, 0, 0, 1]);
  });

  it("applied to a point it gives the same result as the canvas formula", () => {
    const t = { a: 0.8, b: 0.6, c: -0.6, d: 0.8, e: 10, f: -4 }; // rotation + translation
    const m = skMatrix(t);
    const x = 7, y = 3;
    const sx = m[0] * x + m[1] * y + m[2];
    const sy = m[3] * x + m[4] * y + m[5];
    expect(sx).toBeCloseTo(t.a * x + t.c * y + t.e, 12);
    expect(sy).toBeCloseTo(t.b * x + t.d * y + t.f, 12);
  });
});
