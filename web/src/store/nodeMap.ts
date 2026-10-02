import type { NodeLite } from "./types";

// MAPPA PERSISTENTE id -> valore (usata per i nodi della scena e per gli extent
// dell'indice di scena).
//
// `SceneState` è immutabile e ogni op ne produce una nuova. Con `nodes` come
// oggetto semplice ogni op copiava TUTTE le voci ({...nodes}): ~9 ms a 20.000
// nodi, per ogni passo di un trascinamento, anche quando l'op ne toccava uno.
//
// Qui le voci stanno in BUCKET_COUNT secchi (oggetti semplici, scelti dall'hash
// dell'id). Una modifica copia l'array dei secchi (256 puntatori) e i soli secchi
// toccati (~N/256 voci l'uno): O(√N) invece di O(N), e tutto ciò che non cambia
// condivide l'identità -- un secchio uguale a quello della versione precedente
// non ha bisogno di essere confrontato voce per voce (vedi diff).
//
// Le letture costano un hash dell'id e due accessi. La forma è CANONICA: un
// secchio vuoto è "assente", quindi due mappe con le stesse voci sono
// strutturalmente uguali qualunque sia la storia (toEqual nei test).
const BUCKET_COUNT = 256;
type Bucket<V> = Record<string, V>;

function bucketOf(id: string): number {
  // FNV-1a su tutti i caratteri: gli id sono uuid, ma anche id corti e sequenziali
  // ("n1", "n2", …) devono distribuirsi.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & (BUCKET_COUNT - 1);
}

export class PMap<V> {
  // Costruttore interno: si parte da PMap.emptyOf / PMap.from.
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

  // Come l'accesso a indice della vecchia mappa: tipato come presente. Per i
  // call site che già verificano l'esistenza (o per cui l'id è un invariante).
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

  // Più modifiche con una sola copia dei secchi toccati.
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

  // Gli id la cui voce è diversa (o assente) rispetto a `prev`: nuove e cambiate
  // in `changed`, presenti solo in `prev` in `removed`. Salta ogni secchio con la
  // stessa identità, quindi costa quanto i secchi toccati. Ritorna false se
  // supera `limit` voci.
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

// Un editor transitorio: copia ciascun secchio una volta sola, alla prima
// scrittura. Va chiuso con done(); non si riusa dopo.
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
    // Canonica: un secchio vuoto è "assente".
    for (const _ in b) return;
    this.buckets[i] = undefined;
    this.owned.delete(i);
  }

  // Una vista di SOLA LETTURA e TRANSITORIA dello stato corrente (nessuna copia):
  // le scritture successive la mutano, quindi va usata subito e scartata.
  view(): PMap<V> {
    return new PMap<V>(this.buckets, this.size);
  }

  done(): PMap<V> {
    if (!this.touched) return this.base;
    return new PMap<V>(this.buckets, this.size);
  }
}

// La mappa dei nodi di una scena.
export type NodeMap = PMap<NodeLite>;
export type NodeEditor = PEditor<NodeLite>;
export const NodeMap = {
  empty: PMap.emptyOf<NodeLite>(),
  from: (entries: Iterable<readonly [string, NodeLite]> | Record<string, NodeLite>): NodeMap => PMap.from<NodeLite>(entries),
};

// Per i punti che hanno già un oggetto id -> nodo (fixture, import).
export function nodesOf(record: Record<string, NodeLite>): NodeMap {
  return NodeMap.from(record);
}

export function nodesFromEntries(entries: Iterable<readonly [string, NodeLite]>): NodeMap {
  return NodeMap.from(entries);
}

// `base` con le voci di `patch` sostituite o aggiunte (fixture).
export function nodesWith(base: NodeMap, patch: Record<string, NodeLite>): NodeMap {
  const e = base.edit();
  for (const [id, n] of Object.entries(patch)) e.set(id, n);
  return e.done();
}
