import { assemble, I32, op } from "@/plugins/wasmAsm";
import { bytesToBase64 } from "@/plugins/wasm";

// THE EXAMPLE WEBASSEMBLY PLUGIN. In text format it is:
//
//   (module
//     (memory (export "memory") 1 2)
//     (data (i32.const 16384) "<the commands below>")
//     (func (export "od_input")  (result i32) (i32.const 0))
//     (func (export "od_output") (result i32) (i32.const 16384))
//     (func (export "od_run") (param i32) (result i32) (i32.const <length of the commands>)))
//
// It ignores its input and answers with two commands: draw a badge, and say so. A real plugin would be
// written in Rust, C, Zig or AssemblyScript and read the input JSON at od_input().

const OUT = 16384;

export const EXAMPLE_COMMANDS = [
  { method: "createRect", args: [{ x: 0, y: 0, width: 120, height: 40, cornerRadius: 8, fill: { r: 0.2, g: 0.4, b: 1 }, name: "Badge" }] },
  { method: "notify", args: ["Badge added by a WebAssembly plugin."] },
];

export function exampleModule(commands: unknown = EXAMPLE_COMMANDS): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(commands));
  return assemble({
    memory: { min: 1, max: 2 },
    funcs: [
      { name: "od_input", results: [I32], body: op.i32const(0) },
      { name: "od_output", results: [I32], body: op.i32const(OUT) },
      { name: "od_run", params: [I32], results: [I32], body: op.i32const(json.length) },
    ],
    data: [{ offset: OUT, bytes: json }],
  });
}

/** A plugin file worth installing to see how one works. */
export function exampleWasmPlugin() {
  return {
    name: "Add a badge (WebAssembly)",
    version: "1.0.0",
    description: "Draws a blue badge and says so. A hand-assembled module: see plugins/wasmExample.ts.",
    permissions: ["write"],
    wasm: bytesToBase64(exampleModule()),
  };
}
