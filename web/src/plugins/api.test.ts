import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import { PluginError, PluginSession } from "./api";
import { EXAMPLE_PLUGIN, parsePlugin } from "./manifest";
import { runPlugin, type Frame } from "./run";

const sync = { submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } };
const rect = (id: string, key: string, x: number): NodeLite => ({
  id, parentId: "page1", orderKey: key, name: id, visible: true, opacity: 1, x, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});

beforeEach(() => {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null, undoStack: [], redoStack: [] });
  useScene.getState().setScene({ ...emptyScene("d", "t"), nodes: nodesOf({ a: rect("a", "a0", 0), b: rect("b", "a1", 100) }) });
  useScene.setState({ sync: sync as never, selection: ["a", "b"] });
});

describe("PluginSession", () => {
  it("reads the selection and the layers, and needs the permission to do so", () => {
    const s = new PluginSession(["read"]);
    expect(s.call("selection", [])).toEqual(["a", "b"]);
    expect(s.call("getNode", ["a"])).toMatchObject({ id: "a", type: "rect", x: 0, fill: { r: 1, g: 0, b: 0, a: 1 } });
    expect((s.call("listNodes", []) as { id: string }[]).map((n) => n.id)).toEqual(["a", "b"]);
    expect(() => s.call("createRect", [{}])).toThrow(/"write" permission/);
    expect(() => new PluginSession([]).call("selection", [])).toThrow(/"read" permission/);
    expect(() => s.call("nope", [])).toThrow(PluginError);
  });

  it("writes through ops, all in ONE undo step, and sees its own edits", () => {
    const s = new PluginSession(["read", "write"]);
    s.call("setProps", ["a", { x: 10, name: "A" }]);
    const made = s.call("createRect", [{ x: 5, y: 6, width: 20, height: 30, fill: { r: 0, g: 1, b: 0 }, name: "New" }]) as { id: string };
    expect(s.call("getNode", ["a"])).toMatchObject({ x: 10, name: "A" });
    s.call("deleteNode", ["b"]);
    s.finish();
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("a").x).toBe(10);
    expect(scene.nodes.at(made.id)).toMatchObject({ name: "New", x: 5, width: 20, parentId: "page1" });
    expect(scene.nodes.get("b")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("throws the run away on abort", () => {
    const s = new PluginSession(["read", "write"]);
    s.call("setProps", ["a", { x: 77 }]);
    s.abort();
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("validates what it is given", () => {
    const s = new PluginSession(["read", "write"]);
    expect(() => s.call("setProps", ["a", { x: "far" }])).toThrow(/x must be a number/);
    expect(() => s.call("setProps", ["a", { cornerRadius: 3 }])).toThrow(/cannot change "cornerRadius"/);
    expect(() => s.call("setProps", ["zzz", { x: 1 }])).toThrow(/no layer/);
    expect(() => s.call("createRect", [{ parentId: "nowhere" }])).toThrow(/no parent/);
    expect(() => s.call("createRect", [{ fill: "red" }])).toThrow(/fill must be/);
    expect(() => s.call("setProps", ["a", { name: "x".repeat(500) }])).toThrow(/name must be a string/);
    s.abort();
  });

  it("creates text and frames, and clamps opacity", () => {
    const s = new PluginSession(["read", "write"]);
    const t = s.call("createText", [{ text: "Hello", fontSize: 20, x: 3 }]) as { id: string; type: string; text: string };
    expect(t).toMatchObject({ type: "text", text: "Hello", x: 3 });
    s.call("createFrame", [{ width: 300, height: 200 }]);
    s.call("setProps", ["a", { opacity: 5 }]);
    s.finish();
    expect(useScene.getState().scene!.nodes.at("a").opacity).toBe(1);
  });

  it("relays notifications", () => {
    const seen: string[] = [];
    new PluginSession([], (m) => seen.push(m)).call("notify", ["hi"]);
    expect(seen).toEqual(["hi"]);
  });
});

describe("parsePlugin", () => {
  it("accepts the example, and refuses what is not a plugin", () => {
    const ok = parsePlugin(JSON.stringify(EXAMPLE_PLUGIN), () => "id1");
    expect("plugin" in ok && ok.plugin).toMatchObject({ id: "id1", name: "Number the selection", permissions: ["read", "write"] });
    expect(parsePlugin("{")).toEqual({ error: "That is not valid JSON." });
    expect(parsePlugin("[]")).toHaveProperty("error");
    expect(parsePlugin(JSON.stringify({ name: "x" }))).toEqual({ error: "A plugin needs `code`." });
    expect(parsePlugin(JSON.stringify({ code: "1" }))).toHaveProperty("error");
    expect(parsePlugin(JSON.stringify({ name: "x", code: "1", permissions: ["network"] }))).toHaveProperty("error");
    const dflt = parsePlugin(JSON.stringify({ name: "x", code: "1" }));
    expect("plugin" in dflt && dflt.plugin.permissions).toEqual(["read"]);
  });
});

// A frame that plays the sandbox's part: it speaks the same messages.
function fakeFrame() {
  const sent: unknown[] = [];
  const win = { postMessage: (m: unknown) => sent.push(m) };
  const frame: Frame & { removed: boolean } = { window: win, removed: false, remove() { this.removed = true; } };
  const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: win as unknown as MessageEventSource }));
  return { frame, sent, say };
}

describe("runPlugin", () => {
  const plugin = { id: "p", name: "p", version: "1", description: "", permissions: ["read", "write"] as ("read" | "write")[], code: "// run" };

  it("runs the code once the sandbox is ready, answers its calls and commits on done", async () => {
    const { frame, sent, say } = fakeFrame();
    const result = runPlugin(plugin, { frame });
    say({ od: 1, ready: true });
    expect(sent[0]).toEqual({ od: 2, run: "// run" });
    say({ od: 1, id: 1, method: "setProps", args: ["a", { x: 42 }] });
    expect(sent[1]).toMatchObject({ od: 2, id: 1, result: { id: "a", x: 42 } });
    say({ od: 1, id: 2, method: "setProps", args: ["a", { x: "bad" }] });
    expect(sent[2]).toMatchObject({ od: 2, id: 2, error: expect.stringContaining("must be a number") });
    say({ od: 1, done: true });
    await expect(result).resolves.toEqual({ ok: true });
    expect(frame.removed).toBe(true);
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(42);
    expect(useScene.getState().undoStack).toHaveLength(1);
  });

  it("keeps nothing when the script fails, and ignores messages from anyone else", async () => {
    const { frame, say } = fakeFrame();
    const result = runPlugin(plugin, { frame });
    say({ od: 1, id: 1, method: "setProps", args: ["a", { x: 9 }] });
    window.dispatchEvent(new MessageEvent("message", { data: { od: 1, done: true }, source: window }));
    say({ od: 1, error: "boom" });
    await expect(result).resolves.toEqual({ ok: false, error: "boom" });
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
  });

  it("stops a plugin that never finishes", async () => {
    vi.useFakeTimers();
    const { frame, say } = fakeFrame();
    const result = runPlugin(plugin, { frame, timeoutMs: 1000 });
    say({ od: 1, id: 1, method: "setProps", args: ["a", { x: 9 }] });
    vi.advanceTimersByTime(1500);
    await expect(result).resolves.toMatchObject({ ok: false, error: expect.stringContaining("took longer") });
    expect(frame.removed).toBe(true);
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
    vi.useRealTimers();
  });
});
