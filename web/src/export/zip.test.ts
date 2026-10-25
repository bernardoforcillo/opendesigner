import { describe, it, expect } from "vitest";
import { crc32, zipStore } from "./zip";

const enc = new TextEncoder();

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("zipStore", () => {
  it("writes local headers, central directory and end record in order", () => {
    const zip = zipStore([
      { name: "mimetype", data: enc.encode("application/epub+zip") },
      { name: "a/b.txt", data: enc.encode("hello") },
    ]);
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    // First entry is stored (method 0) and its name is right at offset 30.
    expect(v.getUint16(8, true)).toBe(0);
    expect(new TextDecoder().decode(zip.slice(30, 38))).toBe("mimetype");
    // End of central directory: 2 entries.
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    // The central directory offset points to a central header signature.
    expect(v.getUint32(v.getUint32(eocd + 16, true), true)).toBe(0x02014b50);
  });
});
