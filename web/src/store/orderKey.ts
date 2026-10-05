import type { SceneState } from "./types";

// Fractional index for the draw order / layers panel order.
//
// Order keys are ALWAYS compared lexicographically (that is how nodes
// are sorted everywhere, from the renderer to the panel). The M0/M1a format
// ("a" + 6 digits) sorted correctly but did not allow inserting anything
// between two neighbors: between "a000001" and "a000002" no string exists. Here a
// key is instead a FRACTION in base 36 over the ordered alphabet 0-9a-z:
// "a000001" is worth 0.a000001₃₆. Lexicographic order coincides with the order of
// values (missing digits are worth 0, and for equal values the shorter string
// wins), so already-persisted keys remain valid and keep
// sorting correctly next to the new ones.
//
// Invariant: no generated key ends with the lowest digit ("0").
// If a key ended with "0" no key could ever be inserted
// right before it — between "x" and "x0" no string exists. Legacy
// keys ending in "0" (e.g. "a000000") remain accepted as INPUT: we
// read them, we just do not emit new ones shaped like that.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const MAX_DIGIT = BASE - 1;

// First key of an empty document: M0/M1a format, so already
// saved documents and new ones share the same starting point.
const FIRST_KEY = "a000000";

function toDigits(key: string, label: string): number[] {
  const out: number[] = [];
  for (const ch of key) {
    const d = DIGITS.indexOf(ch);
    if (d < 0) throw new Error(`orderKeyBetween: ${label} order key "${key}" has an invalid digit "${ch}"`);
    out.push(d);
  }
  return out;
}

function toKey(digits: number[]): string {
  return digits.map((d) => DIGITS[d]).join("");
}

// Key immediately following `digits` (open upper bound).
// Increments the rightmost non-max digit and drops the tail: the tail was
// made only of max digits, so the value grows and the result cannot
// end with "0" (an incremented digit is worth at least 1). If all digits are
// max we lengthen the string: "zzz" < "zzzi" both as value and as
// string, because the value 1.0 is a bound that is never reached.
function keyAfterDigits(digits: number[]): number[] {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < MAX_DIGIT) {
      const out = [...digits.slice(0, i), digits[i] + 1];
      // The carry shortened the key: we bring it back to the starting
      // width with zeros closed by "1" (it stays > the incremented key and
      // < the next digit, and does not end with "0"). Without this every
      // carry would lose a digit and after a few hundred appends the key
      // would shrink to "z" forcing us to lengthen it continuously; this way instead
      // "a00000z" → "a000011" and the width stays stable.
      if (out.length < digits.length) {
        while (out.length < digits.length - 1) out.push(0);
        out.push(1);
      }
      return out;
    }
  }
  return [...digits, Math.floor(BASE / 2)];
}

// Value strictly between `a` and `b` (missing digits = 0), without a trailing
// "0". Requires value(a) < value(b).
function midpointDigits(a: number[], b: number[]): number[] {
  const prefix: number[] = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da === db) {
      prefix.push(da);
      continue;
    }
    // First differing digit: since the prefixes are equal and value(a) < value(b),
    // here da < db holds.
    if (db - da >= 2) {
      // There is room for a digit in between: key of the same length.
      return [...prefix, Math.floor((da + db) / 2)];
    }
    // Consecutive digits: we descend into the branch of `a` (whatever follows
    // stays below `b`) and look for the successor of its tail.
    return [...prefix, da, ...keyAfterDigits(a.slice(i + 1))];
  }
  // Same digits all the way ⇒ same value: between the two there is
  // literally no string (it is the "x" / "x0" case).
  throw new Error(`orderKeyBetween: no key exists between "${toKey(a)}" and "${toKey(b)}"`);
}

/**
 * Returns an order key strictly between `a` and `b` in lexicographic
 * order. `null` indicates an open bound: `orderKeyBetween(null, k)`
 * sorts before everything, `orderKeyBetween(k, null)` after everything.
 * Throws if `a >= b`, instead of emitting a key that would break the order.
 */
export function orderKeyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`orderKeyBetween: invalid range "${a}" >= "${b}"`);
  }
  if (a === null && b === null) return FIRST_KEY;
  if (b === null) return toKey(keyAfterDigits(toDigits(a as string, "lower")));
  const hi = toDigits(b, "upper");
  if (a === null) return toKey(midpointDigits([], hi));
  return toKey(midpointDigits(toDigits(a, "lower"), hi));
}

// Derives the next order key from the nodes already present in the scene, instead of from
// a module counter (M0 bug: the counter restarted from 0 after reload and
// re-emitted "a000000" on a document that already had one, making the
// draw order unstable). Lexicographic comparison on the existing maximum key,
// then the next key of the fractional index.
export function nextOrderKey(scene: SceneState | null): string {
  const keys = scene ? [...scene.nodes.values()].map((n) => n.orderKey) : [];
  if (keys.length === 0) return orderKeyBetween(null, null);

  const maxKey = keys.reduce((a, b) => (b > a ? b : a));
  return orderKeyBetween(maxKey, null);
}
