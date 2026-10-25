import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { nodesOf } from "../store/nodeMap";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import { parsePlugin, type Plugin } from "./manifest";
import { runPlugin } from "./run";
import { checkMemory, executeWasm, IO_MAX, parseCommands, validateWasm, WasmError, bytesToBase64 } from "./wasm";
import { assemble, I32, op } from "./wasmAsm";
import { exampleModule, exampleWasmPlugin } from "./wasmExample";
import { runWasmPlugin, snapshot, type WasmWorker } from "./wasmRun";
import { PluginSession } from "./api";

const sync = { submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } };
const rect = (id: string): NodeLite => ({
  id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null, undoStack: [], redoStack: [] });
  useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ a: rect("a") }) });
  useScene.setState({ sync: sync as never, selection: ["a"] });
});

/** A module that answers with `json` (a constant), with the given memory. */
const answering = (json: string, memory = { min: 1, max: 2 }) => assemble({
  memory,
  funcs: [
    { name: "od_input", results: [I32], body: op.i32const(0) },
    { name: "od_output", results: [I32], body: op.i32const(16384) },
    { name: "od_run", params: [I32], results: [I32], body: op.i32const(new TextEncoder().encode(json).length) },
  ],
  data: [{ offset: 16384, bytes: new TextEncoder().encode(json) }],
});

describe("the module", () => {
  it("runs the example in Node's WebAssembly and answers its commands", () => {
    const out = executeWasm(exampleModule(), "{}");
    expect(parseCommands(out).map((c) => c.method)).toEqual(["createRect", "notify"]);
  });

  it("is given the input at od_input()", () => {
    // od_run returns its argument: the answer is the input read back from od_output() == od_input().
    const echo = assemble({
      memory: { min: 1, max: 1 },
      funcs: [
        { name: "od_input", results: [I32], body: op.i32const(100) },
        { name: "od_output", results: [I32], body: op.i32const(100) },
        { name: "od_run", params: [I32], results: [I32], body: op.localGet(0) },
      ],
    });
    expect(executeWasm(echo, "[1,2,3]")).toBe("[1,2,3]");
  });

  it("refuses memory with no maximum or a big one, imports, and missing exports, before running anything", () => {
    const funcs = [
      { name: "od_input", results: [I32], body: op.i32const(0) },
      { name: "od_output", results: [I32], body: op.i32const(0) },
      { name: "od_run", params: [I32], results: [I32], body: op.i32const(0) },
    ];
    expect(() => validateWasm(assemble({ memory: { min: 1 }, funcs }))).toThrow(/declare a maximum/);
    expect(() => validateWasm(assemble({ memory: { min: 1, max: 65536 }, funcs }))).toThrow(/at most 64 pages/);
    expect(() => validateWasm(assemble({ funcs }))).toThrow(/no memory/);
    expect(() => validateWasm(assemble({ memory: { min: 1, max: 1 }, funcs, imports: [["env", "fetch"]] }))).toThrow(/may not import/);
    expect(() => validateWasm(assemble({ memory: { min: 1, max: 1 }, funcs: funcs.slice(0, 2) }))).toThrow(/od_run/);
    expect(() => validateWasm(assemble({ memory: { min: 1, max: 1 }, funcs, exportMemory: false }))).toThrow(/export `memory`/);
    expect(() => checkMemory(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a WebAssembly module/);
    expect(() => validateWasm(new Uint8Array(2 << 20))).toThrow(/up to 1024 KiB/);
    expect(() => validateWasm(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 1, 99]))).toThrow(WasmError);
  });

  it("turns a trap, an error code and an oversized answer into errors", () => {
    const trap = assemble({
      memory: { min: 1, max: 1 },
      funcs: [
        { name: "od_input", results: [I32], body: op.i32const(0) },
        { name: "od_output", results: [I32], body: op.i32const(0) },
        { name: "od_run", params: [I32], results: [I32], body: op.unreachable },
      ],
    });
    expect(() => executeWasm(trap, "{}")).toThrow(/unreachable/);
    const code = assemble({
      memory: { min: 1, max: 1 },
      funcs: [
        { name: "od_input", results: [I32], body: op.i32const(0) },
        { name: "od_output", results: [I32], body: op.i32const(0) },
        { name: "od_run", params: [I32], results: [I32], body: op.i32const(-7) },
      ],
    });
    expect(() => executeWasm(code, "{}")).toThrow(/error -7/);
    const big = assemble({
      memory: { min: 1, max: 1 },
      funcs: [
        { name: "od_input", results: [I32], body: op.i32const(0) },
        { name: "od_output", results: [I32], body: op.i32const(65000) },
        { name: "od_run", params: [I32], results: [I32], body: op.i32const(IO_MAX + 1) },
      ],
    });
    expect(() => executeWasm(big, "{}")).toThrow(/too large/);
    expect(() => executeWasm(exampleModule(), "x".repeat(IO_MAX + 1))).toThrow(/input is too large/);
  });

  it("checks the answer is a list of commands", () => {
    expect(parseCommands('[{"method":"notify","args":["hi"]},{"method":"select"}]')).toEqual([{ method: "notify", args: ["hi"] }, { method: "select", args: [] }]);
    expect(() => parseCommands("nope")).toThrow(/not JSON/);
    expect(() => parseCommands("{}")).toThrow(/list of commands/);
    expect(() => parseCommands("[{}]")).toThrow(/needs a method/);
    expect(() => parseCommands('[{"method":"x","args":1}]')).toThrow(/args must be a list/);
    expect(() => parseCommands(JSON.stringify(new Array(1001).fill({ method: "notify" })))).toThrow(/up to 1000/);
  });
});

describe("installing", () => {
  it("accepts the example and keeps the module, and refuses a module the sandbox would refuse", () => {
    const ok = parsePlugin(JSON.stringify(exampleWasmPlugin()), () => "w");
    expect("plugin" in ok && ok.plugin).toMatchObject({ id: "w", code: "", permissions: ["write"], wasm: expect.any(String) });
    expect(parsePlugin(JSON.stringify({ name: "x", wasm: "***" }))).toEqual({ error: "`wasm` must be the module in base64." });
    expect(parsePlugin(JSON.stringify({ name: "x", wasm: 5 }))).toHaveProperty("error");
    const noMax = bytesToBase64(assemble({ memory: { min: 1 }, funcs: [{ name: "od_input", body: [] }] }));
    expect(parsePlugin(JSON.stringify({ name: "x", wasm: noMax }))).toEqual({ error: expect.stringContaining("declare a maximum") });
  });
});

/** A Worker that runs the module on the spot, as wasmWorker.ts does. */
function inlineWorker(): WasmWorker & { terminated: boolean; inputs: string[] } {
  const w: WasmWorker & { terminated: boolean; inputs: string[] } = {
    terminated: false, inputs: [], onmessage: null, onerror: null,
    postMessage({ bytes, input }) {
      w.inputs.push(input);
      let answer: { output?: string; error?: string };
      try { answer = { output: executeWasm(bytes, input) }; } catch (e) { answer = { error: (e as Error).message }; }
      queueMicrotask(() => w.onmessage?.({ data: answer }));
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

const wasmPlugin = (module: Uint8Array, permissions: ("read" | "write")[] = ["read", "write"]): Plugin => ({
  id: "w", name: "w", version: "1", description: "", permissions, code: "", wasm: bytesToBase64(module),
});

describe("runWasmPlugin", () => {
  it("applies the commands through the bridge as ONE undo step, then ends the worker", async () => {
    const worker = inlineWorker();
    const notes: string[] = [];
    const r = await runWasmPlugin(wasmPlugin(exampleModule()), { spawn: () => worker, notify: (m) => notes.push(m) });
    expect(r).toEqual({ ok: true });
    expect(notes).toEqual(["Badge added by a WebAssembly plugin."]);
    const scene = useScene.getState().scene!;
    const badge = [...scene.nodes.values()].find((n) => n.name === "Badge");
    expect(badge).toMatchObject({ width: 120, height: 40, kind: "rect", cornerRadius: 8 });
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("goes through runPlugin when a plugin has a module", async () => {
    // runPlugin would start a real Worker (not in jsdom): a plugin with a module that is missing is told so.
    await expect(runPlugin({ ...wasmPlugin(exampleModule()), wasm: "***" })).resolves.toEqual({ ok: false, error: "This plugin has no WebAssembly module." });
  });

  it("keeps nothing when a command fails, and the commands obey the permissions", async () => {
    const two = answering(JSON.stringify([{ method: "setProps", args: ["a", { x: 99 }] }, { method: "setProps", args: ["a", { x: "far" }] }]));
    const r = await runWasmPlugin(wasmPlugin(two), { spawn: inlineWorker });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("x must be a number") });
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
    expect(useScene.getState().undoStack).toHaveLength(0);

    const denied = await runWasmPlugin(wasmPlugin(exampleModule(), ["read"]), { spawn: inlineWorker });
    expect(denied).toEqual({ ok: false, error: expect.stringContaining('"write" permission') });
    expect(await runWasmPlugin(wasmPlugin(answering('[{"method":"fetch","args":["https://x"]}]')), { spawn: inlineWorker })).toEqual({ ok: false, error: "unknown method od.fetch" });
  });

  it("reports a trap and a bad answer, and keeps nothing", async () => {
    const bad = await runWasmPlugin(wasmPlugin(answering("not json")), { spawn: inlineWorker });
    expect(bad).toEqual({ ok: false, error: "the plugin's answer is not JSON" });
    const w = inlineWorker();
    const p = runWasmPlugin(wasmPlugin(exampleModule()), { spawn: () => w });
    w.onerror?.({ message: "boom" });
    await expect(p).resolves.toEqual({ ok: false, error: "boom" });
  });

  it("terminates a plugin that never answers", async () => {
    vi.useFakeTimers();
    const hung: WasmWorker & { terminated: boolean } = { terminated: false, onmessage: null, onerror: null, postMessage() {}, terminate() { hung.terminated = true; } };
    const p = runWasmPlugin(wasmPlugin(exampleModule()), { spawn: () => hung, timeoutMs: 1000 });
    vi.advanceTimersByTime(1500);
    await expect(p).resolves.toEqual({ ok: false, error: expect.stringContaining("took longer") });
    expect(hung.terminated).toBe(true);
    vi.useRealTimers();
  });

  it("gives the plugin the selection only with the read permission, and within the size limit", async () => {
    const w = inlineWorker();
    await runWasmPlugin(wasmPlugin(answering("[]")), { spawn: () => w });
    expect(JSON.parse(w.inputs[0])).toMatchObject({ selection: [{ id: "a", type: "rect", width: 50 }], page: { pages: expect.any(Array) } });
    const w2 = inlineWorker();
    await runWasmPlugin(wasmPlugin(answering("[]"), ["write"]), { spawn: () => w2 });
    expect(w2.inputs[0]).toBe("{}");

    const many: Record<string, NodeLite> = {};
    for (let i = 0; i < 150; i++) many[`n${i}`] = { ...rect(`n${i}`), name: "x".repeat(100) };
    useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf(many) });
    useScene.setState({ selection: Object.keys(many) });
    const text = snapshot(new PluginSession(["read"]), true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(IO_MAX);
    expect(JSON.parse(text).selection.length).toBeGreaterThan(0);
    expect(JSON.parse(text).selection.length).toBeLessThan(150);
  });
});
