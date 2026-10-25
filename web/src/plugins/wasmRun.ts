import { PluginError, PluginSession, type PluginNode } from "./api";
import type { Plugin } from "./manifest";
import type { RunResult } from "./run";
import { bytesFromBase64, IO_MAX, parseCommands, WasmError } from "./wasm";

// RUNNING A WEBASSEMBLY PLUGIN. The module runs in a Worker that is terminated if it does not answer in
// time (an endless loop cannot freeze the editor). It answers a list of commands; the commands then go
// through PluginSession.call, one by one, exactly like the calls of a script plugin: same permissions,
// same validation, ONE undo step for the run, nothing kept if any command fails.

export const WASM_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_NODES = 200;

/** The bit of a Worker the runner needs (so a test can stand in for it). */
export interface WasmWorker {
  postMessage(message: { bytes: Uint8Array; input: string }): void;
  onmessage: ((e: { data: { output?: string; error?: string } }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}

export function spawnWasmWorker(): WasmWorker {
  return new Worker(new URL("./wasmWorker.ts", import.meta.url), { type: "module" }) as unknown as WasmWorker;
}

/** What the plugin may read: the selection and the page, through the same bridge (so only with "read"). */
export function snapshot(session: PluginSession, canRead: boolean): string {
  if (!canRead) return "{}";
  const ids = session.call("selection", []) as string[];
  const page = session.call("page", []);
  const selection: PluginNode[] = ids.slice(0, MAX_SNAPSHOT_NODES).map((id) => session.call("getNode", [id]) as PluginNode);
  // The input has a size limit: drop the last layers until it fits.
  for (;;) {
    const text = JSON.stringify({ selection, page });
    if (new TextEncoder().encode(text).length <= IO_MAX || selection.length === 0) return text;
    selection.pop();
  }
}

export function runWasmPlugin(
  plugin: Plugin,
  opts: { notify?: (message: string) => void; timeoutMs?: number; spawn?: () => WasmWorker } = {},
): Promise<RunResult> {
  const bytes = plugin.wasm === undefined ? null : bytesFromBase64(plugin.wasm);
  if (!bytes) return Promise.resolve({ ok: false, error: "This plugin has no WebAssembly module." });
  const session = new PluginSession(plugin.permissions, opts.notify);
  let input: string;
  try { input = snapshot(session, plugin.permissions.includes("read")); } catch (err) {
    session.abort();
    return Promise.resolve({ ok: false, error: err instanceof PluginError ? err.message : "no document is open" });
  }
  const timeoutMs = opts.timeoutMs ?? WASM_TIMEOUT_MS;
  const worker = (opts.spawn ?? spawnWasmWorker)();
  return new Promise<RunResult>((resolve) => {
    let over = false;
    const end = (result: RunResult) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      worker.terminate();
      if (result.ok) session.finish(); else session.abort();
      resolve(result);
    };
    const timer = setTimeout(() => end({ ok: false, error: `The plugin took longer than ${timeoutMs / 1000} seconds and was stopped.` }), timeoutMs);
    worker.onerror = (e) => end({ ok: false, error: String(e.message ?? "the plugin failed").slice(0, 300) });
    worker.onmessage = (e) => {
      if (e.data.error !== undefined) { end({ ok: false, error: String(e.data.error).slice(0, 300) }); return; }
      try {
        for (const c of parseCommands(e.data.output ?? "")) session.call(c.method, c.args);
        end({ ok: true });
      } catch (err) {
        end({ ok: false, error: err instanceof PluginError || err instanceof WasmError ? err.message : "a command failed" });
      }
    };
    worker.postMessage({ bytes, input });
  });
}
