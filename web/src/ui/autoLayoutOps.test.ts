import { nodesOf } from "../store/nodeMap";
import { describe, it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import { DEFAULT_AUTO_LAYOUT, autoLayoutOps } from "./autoLayoutOps";

function frameScene(autoLayout?: NodeLite["autoLayout"]): SceneState {
  const frame: NodeLite = {
    id: "f", parentId: "page1", orderKey: "a0", name: "f", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 100, rotation: 0, fills: [], strokes: [], kind: "frame",
    cornerRadius: 0, clipsContent: true, ...(autoLayout ? { autoLayout } : {}),
  };
  const kid = (id: string, key: string): NodeLite => ({
    ...frame, id, parentId: "f", orderKey: key, kind: "rect", clipsContent: false, width: 20, height: 10,
    x: 999, y: 999,
  });
  delete (kid("x", "x") as { autoLayout?: unknown }).autoLayout;
  const a = kid("a", "a"); const b = kid("b", "b");
  delete a.autoLayout; delete b.autoLayout;
  return { ...emptyScene("d", "t"), nodes: nodesOf({ f: frame, a, b }) };
}
const look = (s: SceneState) => (id: string) => s.nodes.at(id);
const run = (s: SceneState, ops: ReturnType<typeof autoLayoutOps>) => ops.reduce(applyOp, s);

describe("autoLayoutOps", () => {
  it("turning on writes the default and the server lays out the children right away", () => {
    const s = frameScene();
    const next = run(s, autoLayoutOps(["f"], look(s), { enabled: true }));
    expect(next.nodes.at("f").autoLayout).toEqual(DEFAULT_AUTO_LAYOUT);
    expect(next.nodes.at("a")).toMatchObject({ x: 0, y: 0 });
    expect(next.nodes.at("b")).toMatchObject({ x: 28, y: 0 }); // 20 + default spacing 8
  });

  it("turning it off removes the field and leaves the children where they are", () => {
    const s0 = frameScene();
    const on = run(s0, autoLayoutOps(["f"], look(s0), { enabled: true }));
    const off = run(on, autoLayoutOps(["f"], look(on), { enabled: false }));
    expect("autoLayout" in off.nodes.at("f")).toBe(false);
    expect(off.nodes.at("b").x).toBe(28);
  });

  it("turning on an already-on frame, or turning off an off one, writes nothing", () => {
    const on = frameScene({ ...DEFAULT_AUTO_LAYOUT });
    expect(autoLayoutOps(["f"], look(on), { enabled: true })).toEqual([]);
    const off = frameScene();
    expect(autoLayoutOps(["f"], look(off), { enabled: false })).toEqual([]);
  });

  it("changes one field at a time and the layout follows", () => {
    const s = frameScene({ ...DEFAULT_AUTO_LAYOUT });
    let n = run(s, autoLayoutOps(["f"], look(s), { direction: "vertical" }));
    expect(n.nodes.at("b")).toMatchObject({ x: 0, y: 18 }); // 10 + 8
    n = run(n, autoLayoutOps(["f"], look(n), { spacing: 2, paddingLeft: 5 }));
    expect(n.nodes.at("b")).toMatchObject({ x: 5, y: 12 });
    n = run(n, autoLayoutOps(["f"], look(n), { crossAlign: "end", mainAlign: "end" }));
    expect(n.nodes.at("b").x).toBe(5 + (200 - 5 - 0 - 20));
  });

  it("a patch on an off frame turns it on with the default plus the patch", () => {
    const s = frameScene();
    const n = run(s, autoLayoutOps(["f"], look(s), { spacing: 3 }));
    expect(n.nodes.at("f").autoLayout).toEqual({ ...DEFAULT_AUTO_LAYOUT, spacing: 3 });
  });

  it("negative values are brought to 0; a patch that changes nothing produces no op", () => {
    const s = frameScene({ ...DEFAULT_AUTO_LAYOUT });
    const n = run(s, autoLayoutOps(["f"], look(s), { spacing: -5, paddingTop: -1 }));
    expect(n.nodes.at("f").autoLayout).toMatchObject({ spacing: 0, paddingTop: 0 });
    expect(autoLayoutOps(["f"], look(n), { spacing: 0 })).toEqual([]);
  });

  it("hug fits the frame to the content", () => {
    const s = frameScene({ ...DEFAULT_AUTO_LAYOUT });
    const n = run(s, autoLayoutOps(["f"], look(s), { hugWidth: true, hugHeight: true }));
    expect(n.nodes.at("f")).toMatchObject({ width: 48, height: 10 });
  });

  it("ignores what is not a frame", () => {
    const s = frameScene();
    expect(autoLayoutOps(["a", "ghost"], look(s), { enabled: true })).toEqual([]);
  });
});
