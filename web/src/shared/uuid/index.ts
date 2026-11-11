// RFC 4122 version 4 UUID that also works outside a secure context.
//
// `crypto.randomUUID` exists only over https and on localhost: opened from the
// LAN at http://<ip>:<port> it is undefined, and the editor died on load with
// "crypto.randomUUID is not a function". `crypto.getRandomValues` has no such
// restriction, so it builds the same UUID when randomUUID is missing.
//
// This module imports nothing, so store/ and tools/ can both use it without
// closing a module cycle.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function uuidFromBytes(b: Uint8Array): string {
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b.subarray(0, 16), (x) => HEX[x]);
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)));
}
