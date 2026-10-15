import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import type { NodeLite } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, makeSetPropsOp, uuid } from "../tools/ops";
import type { Permission } from "./manifest";

// THE PLUGIN API, host side. A plugin script calls `od.<method>(...)` inside a sandbox; each call
// arrives here as (method, args) and is checked, applied and answered. All a plugin writes goes in
// as ordinary ops, inside ONE gesture: one undo step for the whole run, and nothing at all if the
// run fails. Nothing here trusts the arguments: they are validated like any input.

export class PluginError extends Error {}

const READ = new Set(["selection", "getNode", "listNodes", "page"]);
const WRITE = new Set(["createRect", "createEllipse", "createText", "createFrame", "setProps", "deleteNode", "select"]);

/** The node as a plugin sees it: plain data, no store internals. */
export interface PluginNode {
  id: string; name: string; type: string; parentId: string;
  x: number; y: number; width: number; height: number; rotation: number; opacity: number; visible: boolean;
  fill: { r: number; g: number; b: number; a: number } | null;
  text?: string;
}

function view(n: NodeLite): PluginNode {
  const f = n.fills[0];
  return {
    id: n.id, name: n.name, type: n.kind, parentId: n.parentId,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation, opacity: n.opacity, visible: n.visible,
    fill: f && !f.gradient && !f.image && !f.mesh ? { r: f.r, g: f.g, b: f.b, a: f.a } : null,
    ...(n.kind === "text" && n.text ? { text: n.text.content } : {}),
  };
}

const num = (v: unknown, what: string, fallback?: number): number => {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new PluginError(`${what} must be a number`);
  return v;
};

const color = (v: unknown, what: string) => {
  if (typeof v !== "object" || v === null) throw new PluginError(`${what} must be {r,g,b,a} with values from 0 to 1`);
  const c = v as Record<string, unknown>;
  const ch = (k: string, d?: number) => Math.min(1, Math.max(0, num(c[k], `${what}.${k}`, d)));
  return { r: ch("r"), g: ch("g"), b: ch("b"), a: ch("a", 1) };
};

const str = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== "string" || v.length > max) throw new PluginError(`${what} must be a string of up to ${max} characters`);
  return v;
};

/** The properties setProps accepts, and the mask path each one writes. */
const SETTABLE: Record<string, (v: unknown) => { patch: Record<string, unknown>; path: "x" | "y" | "width" | "height" | "rotation" | "opacity" | "name" | "visible" | "fills" }> = {
  x: (v) => ({ patch: { x: num(v, "x") }, path: "x" }),
  y: (v) => ({ patch: { y: num(v, "y") }, path: "y" }),
  width: (v) => ({ patch: { width: Math.max(0, num(v, "width")) }, path: "width" }),
  height: (v) => ({ patch: { height: Math.max(0, num(v, "height")) }, path: "height" }),
  rotation: (v) => ({ patch: { rotation: num(v, "rotation") }, path: "rotation" }),
  opacity: (v) => ({ patch: { opacity: Math.min(1, Math.max(0, num(v, "opacity"))) }, path: "opacity" }),
  name: (v) => ({ patch: { name: str(v, "name", 120) }, path: "name" }),
  visible: (v) => {
    if (typeof v !== "boolean") throw new PluginError("visible must be true or false");
    return { patch: { visible: v }, path: "visible" };
  },
  fill: (v) => ({ patch: { fills: [{ kind: { case: "solid", value: { color: color(v, "fill") } } }] }, path: "fills" }),
};

/**
 * One run of one plugin. `call` is what the sandbox's `od.*` reaches; `finish` commits the whole
 * run as one gesture (or `abort` throws it away).
 */
export class PluginSession {
  private ops: Op[] = [];
  private open = false;
  constructor(private readonly permissions: readonly Permission[], private readonly onNotify: (message: string) => void = () => {}) {}

  private begin(): void {
    if (!this.open) {
      useScene.getState().beginGesture();
      this.open = true;
    }
  }

  private emit(op: Op): void {
    this.begin();
    useScene.getState().applyLocal(op);
    this.ops.push(op);
  }

  /** Commits what the run did as ONE undo step. */
  finish(): void {
    if (!this.open) return;
    this.open = false;
    useScene.getState().endGesture(this.ops);
  }

  /** Drops what the run did. */
  abort(): void {
    if (!this.open) return;
    this.open = false;
    useScene.getState().cancelGesture();
  }

  private nodeOf(id: unknown): NodeLite {
    const n = useScene.getState().scene?.nodes.get(str(id, "id", 100));
    if (!n) throw new PluginError(`there is no layer ${String(id)}`);
    return n;
  }

  call(method: string, args: unknown[]): unknown {
    if (method === "notify") {
      this.onNotify(str(args[0], "the message", 300));
      return null;
    }
    const needs: Permission | null = READ.has(method) ? "read" : WRITE.has(method) ? "write" : null;
    if (needs === null) throw new PluginError(`unknown method od.${method}`);
    if (!this.permissions.includes(needs)) throw new PluginError(`this plugin does not have the "${needs}" permission`);
    const st = useScene.getState();
    if (!st.scene) throw new PluginError("no document is open");

    switch (method) {
      case "selection": return [...st.selection];
      case "page": return { id: st.currentPageId ?? st.scene.pages[0]?.id ?? "", pages: st.scene.pages.map((p) => ({ ...p })) };
      case "getNode": return view(this.nodeOf(args[0]));
      case "listNodes": {
        const parent = args[0] === undefined ? st.currentPageId ?? st.scene.pages[0]?.id ?? "" : str(args[0], "the parent id", 100);
        return [...st.scene.nodes.values()].filter((n) => n.parentId === parent).sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1)).map(view);
      }
      case "createRect": case "createEllipse": case "createFrame": return this.createShape(method, args[0]);
      case "createText": return this.createText(args[0]);
      case "setProps": {
        const n = this.nodeOf(args[0]);
        const props = args[1];
        if (typeof props !== "object" || props === null) throw new PluginError("setProps needs an object of properties");
        const patch: Record<string, unknown> = {};
        const paths: ("x" | "y" | "width" | "height" | "rotation" | "opacity" | "name" | "visible" | "fills")[] = [];
        for (const [k, v] of Object.entries(props)) {
          const f = SETTABLE[k];
          if (!f) throw new PluginError(`setProps cannot change "${k}" (it can change ${Object.keys(SETTABLE).join(", ")})`);
          const r = f(v);
          Object.assign(patch, r.patch);
          paths.push(r.path);
        }
        if (paths.length > 0) this.emit(makeSetPropsOp(n.id, patch, paths));
        return view(useScene.getState().scene?.nodes.get(n.id) ?? n);
      }
      case "deleteNode": {
        const n = this.nodeOf(args[0]);
        this.emit(makeDeleteOp(n.id));
        return null;
      }
      case "select": {
        const ids = Array.isArray(args[0]) ? args[0].map((i) => str(i, "an id", 100)) : [];
        useScene.getState().setSelection(ids.filter((i) => useScene.getState().scene?.nodes.has(i)));
        return null;
      }
    }
    return null;
  }

  private placement(o: Record<string, unknown>) {
    const st = useScene.getState();
    const parentId = o.parentId === undefined ? st.currentPageId ?? st.scene?.pages[0]?.id ?? "page1" : str(o.parentId, "parentId", 100);
    if (!st.scene?.pages.some((p) => p.id === parentId) && !st.scene?.nodes.has(parentId)) throw new PluginError(`there is no parent ${parentId}`);
    return {
      parentId,
      x: num(o.x, "x", 0), y: num(o.y, "y", 0),
      width: Math.max(0, num(o.width, "width", 100)), height: Math.max(0, num(o.height, "height", 100)),
    };
  }

  private createShape(kind: "createRect" | "createEllipse" | "createFrame", arg: unknown): PluginNode {
    const o = (typeof arg === "object" && arg !== null ? arg : {}) as Record<string, unknown>;
    const p = this.placement(o);
    const shape: MessageInitShape<typeof NodeSchema>["shape"] =
      kind === "createRect" ? { case: "rect" as const, value: { cornerRadius: Math.max(0, num(o.cornerRadius, "cornerRadius", 0)) } }
      : kind === "createEllipse" ? { case: "ellipse" as const, value: {} }
      : { case: "frame" as const, value: {} };
    const fill = o.fill === undefined ? (kind === "createFrame" ? null : { r: 0.6, g: 0.6, b: 0.65, a: 1 }) : color(o.fill, "fill");
    const node = create(NodeSchema, {
      id: uuid(), parentId: p.parentId, orderKey: nextOrderKey(useScene.getState().scene), visible: true, opacity: 1,
      name: o.name === undefined ? (kind === "createRect" ? "Rectangle" : kind === "createEllipse" ? "Ellipse" : "Frame") : str(o.name, "name", 120),
      x: p.x, y: p.y, width: p.width, height: p.height,
      fills: fill ? [{ kind: { case: "solid", value: { color: fill } } }] : [],
      shape,
    });
    this.emit(makeCreateNodeOp(node));
    return view(useScene.getState().scene!.nodes.get(node.id)!);
  }

  private createText(arg: unknown): PluginNode {
    const o = (typeof arg === "object" && arg !== null ? arg : {}) as Record<string, unknown>;
    const p = this.placement({ ...o, width: o.width ?? 200, height: o.height ?? 24 });
    const content = str(o.text ?? o.content ?? "", "text", 2000);
    const node = create(NodeSchema, {
      id: uuid(), parentId: p.parentId, orderKey: nextOrderKey(useScene.getState().scene), visible: true, opacity: 1,
      name: o.name === undefined ? content.slice(0, 40) || "Text" : str(o.name, "name", 120),
      x: p.x, y: p.y, width: p.width, height: p.height,
      fills: [{ kind: { case: "solid", value: { color: o.fill === undefined ? { r: 0, g: 0, b: 0, a: 1 } : color(o.fill, "fill") } } }],
      shape: { case: "text", value: { content, style: { fontFamily: "", fontSize: Math.max(1, num(o.fontSize, "fontSize", 16)), fontWeight: "", lineHeight: 0 } } },
    });
    this.emit(makeCreateNodeOp(node));
    return view(useScene.getState().scene!.nodes.get(node.id)!);
  }
}
