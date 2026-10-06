import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { NodeSchema, RenderDiagramResponseSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import { DiagramError, insertDiagram, renderDiagram, selectedDiagram, META_KIND, META_SOURCE } from "./insert";

// A response as the server would give it: group root + two children.
function response(source = "graph TD\nA-->B") {
  const root = create(NodeSchema, {
    id: crypto.randomUUID(), name: "Diagram", visible: true, opacity: 1, width: 200, height: 100,
    shape: { case: "group", value: {} }, meta: { [META_SOURCE]: source, [META_KIND]: "flowchart" },
  });
  const child = (name: string, x: number) =>
    create(NodeSchema, {
      id: crypto.randomUUID(), parentId: root.id, orderKey: name, name, visible: true, opacity: 1, x, y: 10, width: 50, height: 30,
      shape: { case: "rect", value: {} },
    });
  return create(RenderDiagramResponseSchema, { nodes: [root, child("a", 10), child("b", 100)], kind: "flowchart", width: 200, height: 100 });
}

function installScene(): void {
  useScene.setState({ gesture: null, lastError: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
}
const count = () => useScene.getState().scene?.nodes.size ?? 0;

describe("insertDiagram", () => {
  beforeEach(installScene);

  it("creates root and children under the page, centered, and selects the root", () => {
    const res = response();
    const id = insertDiagram(res, { x: 500, y: 300 });
    expect(id).toBe(res.nodes[0].id);
    const scene = useScene.getState().scene!;
    expect(count()).toBe(3);
    const root = scene.nodes.get(id!)!;
    expect(root.parentId).toBe(scene.pages[0].id);
    expect([root.x, root.y]).toEqual([400, 250]);
    expect(root.meta?.[META_SOURCE]).toContain("A-->B");
    expect([...scene.nodes.values()].filter((n) => n.parentId === id)).toHaveLength(2);
    expect(useScene.getState().selection).toEqual([id]);
  });

  it("is ONE gesture: one undo removes everything, one redo puts it back", () => {
    insertDiagram(response(), { x: 0, y: 0 });
    useScene.getState().undo();
    expect(count()).toBe(0);
    useScene.getState().redo();
    expect(count()).toBe(3);
  });

  it("redraws in place of an existing diagram, with a single undo", () => {
    const first = insertDiagram(response("graph TD\nA-->B"), { x: 300, y: 300 })!;
    const before = useScene.getState().scene!.nodes.get(first)!;
    const second = insertDiagram(response("graph TD\nX-->Y"), { x: 0, y: 0 }, first)!;
    const scene = useScene.getState().scene!;
    expect(scene.nodes.has(first)).toBe(false);
    expect(count()).toBe(3);
    const root = scene.nodes.get(second)!;
    expect([root.x, root.y, root.name]).toEqual([before.x, before.y, before.name]);
    expect(root.meta?.[META_SOURCE]).toContain("X-->Y");
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.has(first)).toBe(true);
    expect(useScene.getState().scene!.nodes.has(second)).toBe(false);
  });

  it("does nothing without a document or with a gesture open", () => {
    useScene.getState().beginGesture();
    expect(insertDiagram(response(), { x: 0, y: 0 })).toBeNull();
    expect(count()).toBe(0);
  });
});

describe("selectedDiagram", () => {
  beforeEach(installScene);
  it("recognizes the root of a selected diagram", () => {
    expect(selectedDiagram()).toBeNull();
    const id = insertDiagram(response("graph LR\nA-->B"), { x: 0, y: 0 })!;
    expect(selectedDiagram()).toEqual({ id, source: "graph LR\nA-->B", kind: "flowchart" });
    useScene.getState().setSelection([...useScene.getState().scene!.nodes.values()].map((n) => n.id).filter((k) => k !== id).slice(0, 1));
    expect(selectedDiagram()).toBeNull();
  });
});

describe("renderDiagram", () => {
  it("passes the text to the server and returns the response", async () => {
    const res = response();
    let got = "";
    const out = await renderDiagram("graph TD\nA-->B", { renderDiagram: async (r) => { got = r.source; return res; } });
    expect(got).toBe("graph TD\nA-->B");
    expect(out).toBe(res);
  });
  it("an unreadable text becomes a DiagramError with the server's message", async () => {
    const client = { renderDiagram: async () => { throw new ConnectError("unrecognized line", Code.InvalidArgument); } };
    await expect(renderDiagram("???", client)).rejects.toThrow(DiagramError);
    await expect(renderDiagram("???", client)).rejects.toThrow("unrecognized line");
  });
  it("a server that does not respond shows no technical details", async () => {
    const client = { renderDiagram: async () => { throw new ConnectError("boom", Code.Unavailable); } };
    await expect(renderDiagram("x", client)).rejects.toThrow("the server is not responding");
  });
});
