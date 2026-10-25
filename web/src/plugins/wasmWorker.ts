import { executeWasm } from "./wasm";

// The Worker a WebAssembly plugin runs in (wasmRun.ts starts it, and terminates it when time is up).
// It receives {bytes, input} once and answers {output} or {error}. It has no editor to call: the
// module itself imports nothing.

const scope = globalThis as unknown as {
  onmessage: ((e: { data: { bytes: Uint8Array; input: string } }) => void) | null;
  postMessage(message: { output: string } | { error: string }): void;
};

scope.onmessage = (e) => {
  try {
    scope.postMessage({ output: executeWasm(e.data.bytes, e.data.input) });
  } catch (err) {
    // A trap (RuntimeError) lands here as well.
    scope.postMessage({ error: err instanceof Error ? err.message : "the plugin failed" });
  }
};
