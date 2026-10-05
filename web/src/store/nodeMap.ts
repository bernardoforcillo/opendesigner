import type { NodeLite } from "./types";

// PERSISTENT MAP id -> value (used for the scene nodes and for the extents
// of the scene index).
//
// `SceneState` is immutable and every op produces a new one. With `nodes` as a
// plain object every op copied ALL entries ({...nodes}): ~9 ms at 20,000
// nodes, for every step of a drag, even when the op touched only one.
//
// Here entries live in BUCKET_COUNT buckets (plain objects, chosen by the hash
// of the id). A change copies the buckets array (256 pointers) and only the touched
// buckets (~N/256 entries each): O(√N) instead of O(N), and everything that does not change
// shares identity -- a bucket equal to the previous version's
// does not need to be compared entry by entry (see diff).
//
// Reads cost one id hash and two accesses. The shape is CANONICAL: an empty
// bucket is "absent", so two maps with the same entries are
// structurally equal whatever the history (toEqual in tests).
const BUCKET_COUNT = 256;
type Bucket<V> = Record<string, V>;

function bucketOf(id: string): number {
  // FNV-1a over all characters: ids are uuids, but even short sequential ids
  // ("n1", "n2", …) must distribute well.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & (BUCKET_COUNT - 1);
}

export class PMap<V> {
  // Internal constructor: start from PMap.emptyOf / PMap.from.
  constructor(
    readonly buckets: readonly (Bucket<V> | undefined)[],
    readonly size: number,
  ) {}

  static emptyOf<V>(): PMap<V> {
    return new PMap<V>(new Array<Bucket<V> | undefined>(BUCKET_COUNT).fill(undefined), 0);
  }

  static from<V>(entries: Iterable<readonly [string, V]> | Record<string, V>): PMap<V> {
    const e = new PEditor<V>(PMap.emptyOf<V>());
    const pairs = Symbol.iterator in entries ? (entries as Iterable<readonly [string, V]>) : Object.entries(entries);
    for (const [id, v] of pairs) e.set(id, v);
    return e.done();
  }

  get(id: string): V | undefined {
    const b = this.buckets[bucketOf(id)];
    return b ? b[id] : undefined;
  }

  // Like index access on the old map: typed as present. For
  // call sites that already check existence (or for which the id is an invariant).
  at(id: string): V {
    return this.get(id) as V;
  }

  has(id: string): boolean {
    const b = this.buckets[bucketOf(id)];
    return b !== undefined && id in b;
  }

  set(id: string, v: V): PMap<V> {
    const e = new PEditor<V>(this);
    e.set(id, v);
    return e.done();
  }

  delete(id: string): PMap<V> {
    if (!this.has(id)) return this;
    const e = new PEditor<V>(this);
    e.delete(id);
    return e.done();
  }

  // Several changes with a single copy of the touched buckets.
  edit(): PEditor<V> {
    return new PEditor<V>(this);
  }

  *ids(): IterableIterator<string> {
    for (const b of this.buckets) if (b) for (const id in b) yield id;
  }

  *values(): IterableIterator<V> {
    for (const b of this.buckets) if (b) for (const id in b) yield b[id];
  }

  *entries(): IterableIterator<[string, V]> {
    for (const b of this.buckets) if (b) for (const id in b) yield [id, b[id]];
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  forEach(fn: (v: V, id: string) => void): void {
    for (const b of this.buckets) if (b) for (const id in b) fn(b[id], id);
  }

  toRecord(): Record<string, V> {
    const out: Record<string, V> = {};
    this.forEach((v, id) => { out[id] = v; });
    return out;
  }

  // The ids whose entry differs (or is absent) compared to `prev`: new and changed
  // in `changed`, present only in `prev` in `removed`. Skips every bucket with the
  // same identity, so it costs as much as the touched buckets. Returns false if
  // it exceeds `limit` entries.
  diff(prev: PMap<V>, changed: string[], removed: string[], limit = Infinity): boolean {
    for (let i = 0; i < BUCKET_COUNT; i++) {
      const a = this.buckets[i];
      const b = prev.buckets[i];
      if (a === b) continue;
      if (a) for (const id in a) {
        if (!b || b[id] !== a[id]) {
          changed.push(id);
          if (changed.length > limit) return false;
        }
      }
      if (b) for (const id in b) {
        if (!a || !(id in a)) {
          removed.push(id);
          if (removed.length > limit) return false;
        }
      }
    }
    return true;
  }
}

// A transient editor: copies each bucket only once, on the first
// write. Must be closed with done(); not reused afterwards.
export class PEditor<V> {
  private buckets: (Bucket<V> | undefined)[];
  private owned = new Set<number>();
  private size: number;
  private touched = false;
  private readonly base: PMap<V>;

  constructor(base: PMap<V>) {
    this.buckets = base.buckets.slice();
    this.size = base.size;
    this.base = base;
  }

  get(id: string): V | undefined {
    const b = this.buckets[bucketOf(id)];
    return b ? b[id] : undefined;
  }

  private own(i: number): Bucket<V> {
    let b = this.buckets[i];
    if (!this.owned.has(i)) {
      b = b ? { ...b } : {};
      this.buckets[i] = b;
      this.owned.add(i);
    }
    return b as Bucket<V>;
  }

  set(id: string, v: V): void {
    const i = bucketOf(id);
    const cur = this.buckets[i];
    if (cur && cur[id] === v) return;
    const had = cur !== undefined && id in cur;
    this.own(i)[id] = v;
    if (!had) this.size++;
    this.touched = true;
  }

  delete(id: string): void {
    const i = bucketOf(id);
    const cur = this.buckets[i];
    if (!cur || !(id in cur)) return;
    const b = this.own(i);
    delete b[id];
    this.size--;
    this.touched = true;
    // Canonical: an empty bucket is "absent".
    for (const _ in b) return;
    this.buckets[i] = undefined;
    this.owned.delete(i);
  }

  // A READ-ONLY and TRANSIENT view of the current state (no copy):
  // subsequent writes mutate it, so it must be used immediately and discarded.
  view(): PMap<V> {
    return new PMap<V>(this.buckets, this.size);
  }

  done(): PMap<V> {
    if (!this.touched) return this.base;
    return new PMap<V>(this.buckets, this.size);
  }
}

// The scene's node map.
export type NodeMap = PMap<NodeLite>;
export type NodeEditor = PEditor<NodeLite>;
export const NodeMap = {
  empty: PMap.emptyOf<NodeLite>(),
  from: (entries: Iterable<readonly [string, NodeLite]> | Record<string, NodeLite>): NodeMap => PMap.from<NodeLite>(entries),
};

// For the points that already have an id -> node object (fixtures, import).
export function nodesOf(record: Record<string, NodeLite>): NodeMap {
  return NodeMap.from(record);
}

export function nodesFromEntries(entries: Iterable<readonly [string, NodeLite]>): NodeMap {
  return NodeMap.from(entries);
}

// `base` with the entries of `patch` replaced or added (fixtures).
export function nodesWith(base: NodeMap, patch: Record<string, NodeLite>): NodeMap {
  const e = base.edit();
  for (const [id, n] of Object.entries(patch)) e.set(id, n);
  return e.done();
}
