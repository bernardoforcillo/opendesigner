// WEBASSEMBLY PLUGINS, the module side. A .wasm plugin is a pure function from a JSON snapshot of the
// document to a JSON list of commands; it never calls the editor. That is the whole host ABI:
//
//   (memory)        exported, with a declared maximum of at most 64 pages (4 MiB), not shared, not 64-bit
//   od_input()  -> i32   where the host writes the input JSON (UTF-8, at most IO_MAX bytes)
//   od_output() -> i32   where the plugin writes its answer (UTF-8 JSON, at most IO_MAX bytes)
//   od_run(n)   -> i32   the input is n bytes long; returns the answer's length, or a negative error code
//
// A module may import NOTHING: it has no clock, no network, no files, no way to call back. What it
// writes is a list of {method, args} commands that the host runs through the same bridge as script
// plugins (plugins/api.ts), with the same permission checks and validation. The module runs in a Worker
// (plugins/wasmRun.ts), which the host terminates when the time is up; memory is capped by the
// maximum the module declares, which is checked here from the binary itself.

export const WASM_MAX_BYTES = 1 << 20;
export const WASM_MAX_PAGES = 64;
export const IO_MAX = 16 * 1024;
export const MAX_COMMANDS = 1000;

export class WasmError extends Error {}

export interface Command { method: string; args: unknown[] }

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Bytes from base64, or null when it is not base64. */
export function bytesFromBase64(text: string): Uint8Array | null {
  try { return b64(text); } catch { return null; }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Reads an unsigned LEB128 number at `at`: [value, next offset]. */
function leb(bytes: Uint8Array, at: number): [number, number] {
  let value = 0, shift = 0;
  for (let i = at; i < bytes.length && shift < 35; i++) {
    value += (bytes[i] & 0x7f) * 2 ** shift;
    if ((bytes[i] & 0x80) === 0) return [value, i + 1];
    shift += 7;
  }
  throw new WasmError("the module is damaged");
}

/**
 * The module's memory limits, read from its memory section. Memory is capped by what the module
 * DECLARES (it imports nothing, so the host cannot hand it a smaller one), hence modules without a
 * maximum, or with a big one, are refused before they are compiled.
 */
export function checkMemory(bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new WasmError("that is not a WebAssembly module");
  let at = 8, memories = 0;
  while (at < bytes.length) {
    const id = bytes[at];
    const [size, body] = leb(bytes, at + 1);
    if (body + size > bytes.length) throw new WasmError("the module is damaged");
    if (id === 5) {
      let [count, p] = leb(bytes, body);
      memories = count;
      if (count !== 1) throw new WasmError("a plugin has exactly one memory");
      const flags = bytes[p++];
      if (flags & 0x02) throw new WasmError("shared memory is not allowed");
      if (flags & 0x04) throw new WasmError("64-bit memory is not allowed");
      const [min, q] = leb(bytes, p);
      if ((flags & 0x01) === 0) throw new WasmError(`the memory must declare a maximum (at most ${WASM_MAX_PAGES} pages)`);
      const [max] = leb(bytes, q);
      if (max > WASM_MAX_PAGES || min > max) throw new WasmError(`the memory may be at most ${WASM_MAX_PAGES} pages (${WASM_MAX_PAGES * 64} KiB)`);
    }
    at = body + size;
  }
  if (memories === 0) throw new WasmError("the module has no memory of its own");
}

/** Checks a module without running it: size, memory, imports, and the functions it must export. */
export function validateWasm(bytes: Uint8Array): WebAssembly.Module {
  if (bytes.length === 0 || bytes.length > WASM_MAX_BYTES) throw new WasmError(`a module is up to ${WASM_MAX_BYTES / 1024} KiB`);
  checkMemory(bytes);
  let mod: WebAssembly.Module;
  try { mod = new WebAssembly.Module(bytes as BufferSource); } catch (e) { throw new WasmError(`the module is not valid: ${(e as Error).message}`); }
  if (WebAssembly.Module.imports(mod).length > 0) throw new WasmError("a plugin may not import anything");
  const exports = new Map(WebAssembly.Module.exports(mod).map((e) => [e.name, e.kind]));
  if (exports.get("memory") !== "memory") throw new WasmError("the module must export `memory`");
  for (const f of ["od_input", "od_output", "od_run"]) if (exports.get(f) !== "function") throw new WasmError(`the module must export the function ${f}`);
  return mod;
}

/**
 * Runs the module once: writes `input` at od_input(), calls od_run, reads the answer at od_output().
 * Synchronous and self-contained, so a Worker runs exactly this (and can be killed while it does).
 */
export function executeWasm(bytes: Uint8Array, input: string): string {
  const mod = validateWasm(bytes);
  const inst = new WebAssembly.Instance(mod, {});
  const ex = inst.exports as { memory: WebAssembly.Memory; od_input(): number; od_output(): number; od_run(n: number): number };
  const data = new TextEncoder().encode(input);
  if (data.length > IO_MAX) throw new WasmError("the input is too large");
  const inPtr = ex.od_input() >>> 0;
  if (inPtr + data.length > ex.memory.buffer.byteLength) throw new WasmError("od_input points outside the memory");
  new Uint8Array(ex.memory.buffer, inPtr, data.length).set(data);
  const n = ex.od_run(data.length);
  if (!Number.isInteger(n) || n < 0) throw new WasmError(`the plugin reported error ${n}`);
  if (n > IO_MAX) throw new WasmError("the plugin's answer is too large");
  const outPtr = ex.od_output() >>> 0;
  // The memory may have grown during the run: read the buffer again.
  if (outPtr + n > ex.memory.buffer.byteLength) throw new WasmError("od_output points outside the memory");
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(ex.memory.buffer, outPtr, n));
}

/** The commands in a plugin's answer, or why it is not a list of them. */
export function parseCommands(output: string): Command[] {
  let raw: unknown;
  try { raw = JSON.parse(output); } catch { throw new WasmError("the plugin's answer is not JSON"); }
  if (!Array.isArray(raw)) throw new WasmError("the plugin's answer must be a list of commands");
  if (raw.length > MAX_COMMANDS) throw new WasmError(`a plugin may give up to ${MAX_COMMANDS} commands`);
  return raw.map((c, i) => {
    const o = c as { method?: unknown; args?: unknown };
    if (typeof c !== "object" || c === null || typeof o.method !== "string") throw new WasmError(`command ${i + 1} needs a method`);
    if (o.args !== undefined && !Array.isArray(o.args)) throw new WasmError(`command ${i + 1}: args must be a list`);
    return { method: o.method, args: (o.args as unknown[] | undefined) ?? [] };
  });
}
