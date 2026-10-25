// A TINY WEBASSEMBLY ASSEMBLER. Just enough to write the example plugin and the modules the tests need
// without a toolchain: a module is memory, exported functions given as raw instruction bytes, and data
// segments. It checks nothing (WebAssembly.validate does).

export const I32 = 0x7f;

/** Signed LEB128. */
export function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

/** Unsigned LEB128. */
export function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

/** The few instructions the modules here use. */
export const op = {
  unreachable: [0x00], loop: (blockType = 0x40) => [0x03, blockType], br: (depth: number) => [0x0c, ...uleb(depth)], end: [0x0b],
  i32const: (n: number) => [0x41, ...sleb(n)], localGet: (i: number) => [0x20, ...uleb(i)],
};

export interface FuncSpec { name: string; params?: number[]; results?: number[]; body: number[] }
export interface ModuleSpec {
  /** Pages; `max` left out declares no maximum. */
  memory?: { min: number; max?: number };
  funcs: FuncSpec[];
  data?: { offset: number; bytes: Uint8Array }[];
  /** Imports as [module, name] of functions taking nothing, to build modules the host must refuse. */
  imports?: [string, string][];
  exportMemory?: boolean;
}

const section = (id: number, payload: number[]) => [id, ...uleb(payload.length), ...payload];
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const name = (s: string) => [...uleb(s.length), ...new TextEncoder().encode(s)];

export function assemble(spec: ModuleSpec): Uint8Array {
  const imports = spec.imports ?? [];
  const types = [...imports.map(() => [0x60, 0, 0]), ...spec.funcs.map((f) => [0x60, ...uleb((f.params ?? []).length), ...(f.params ?? []), ...uleb((f.results ?? []).length), ...(f.results ?? [])])];
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  out.push(...section(1, vec(types)));
  if (imports.length > 0) out.push(...section(2, vec(imports.map(([m, n], i) => [...name(m), ...name(n), 0x00, ...uleb(i)]))));
  out.push(...section(3, vec(spec.funcs.map((_, i) => uleb(imports.length + i)))));
  if (spec.memory) out.push(...section(5, vec([spec.memory.max === undefined ? [0x00, ...uleb(spec.memory.min)] : [0x01, ...uleb(spec.memory.min), ...uleb(spec.memory.max)]])));
  const exports = spec.funcs.map((f, i) => [...name(f.name), 0x00, ...uleb(imports.length + i)]);
  if (spec.memory && spec.exportMemory !== false) exports.push([...name("memory"), 0x02, 0x00]);
  out.push(...section(7, vec(exports)));
  out.push(...section(10, vec(spec.funcs.map((f) => { const b = [0x00, ...f.body, 0x0b]; return [...uleb(b.length), ...b]; }))));
  if (spec.data?.length) out.push(...section(11, vec(spec.data.map((d) => [0x00, ...op.i32const(d.offset), 0x0b, ...uleb(d.bytes.length), ...d.bytes]))));
  return Uint8Array.from(out);
}
