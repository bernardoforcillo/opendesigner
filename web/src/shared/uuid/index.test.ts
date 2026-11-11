import { afterEach, describe, expect, it, vi } from "vitest";
import { uuid, uuidFromBytes } from "@/shared/uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a v4 UUID when crypto.randomUUID is available", () => {
    expect(uuid()).toMatch(V4);
  });

  it("falls back to getRandomValues outside a secure context", () => {
    // Over plain http on a LAN address the browser leaves randomUUID undefined.
    const real = globalThis.crypto;
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(a: T) => real.getRandomValues(a as never) as T);
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = new Set(Array.from({ length: 100 }, () => uuid()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(V4);
    expect(getRandomValues).toHaveBeenCalledTimes(100);
  });

  it("sets the version and variant bits", () => {
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidFromBytes(new Uint8Array(16))).toBe("00000000-0000-4000-8000-000000000000");
  });
});
