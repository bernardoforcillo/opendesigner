import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, type NodeLite } from "@/store/types";
import { detachInstanceOps, goToMainComponent, mainComponentOf, resetInstanceOps, swapInstanceOps } from "@/tools/instanceActions";
import { InstanceActions } from "@/ui/InstanceActions";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const base = (id: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id.replace(/\d$/, ""), visible: true, opacity: 1,
  x: 0, y: 0, width: 100, height: 40, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const textNode = (id: string, parentId: string, content: string): NodeLite =>
  base(id, { parentId, kind: "text", text: { content, style: { fontFamily: "", fontSize: 14, fontWeight: "", lineHeight: 0, align: "left" } } });

function install() {
  const scene = emptyScene("doc-1", "Untitled");
  scene.pages = [{ id: "page1", name: "One" }, { id: "page2", name: "Two" }];
  const put = (n: NodeLite) => { scene.nodes = scene.nodes.set(n.id, n); };
  put(base("m1", { kind: "frame" })); put(textNode("label", "m1", "Button"));
  put(base("m2", { kind: "frame", parentId: "page2", width: 200, height: 120 })); put(textNode("label2", "m2", "Card"));
  put(base("i", {
    kind: "instance", fills: [], instance: { componentId: "c1", overrides: [{ masterNodeId: "label", text: "Pay" }] },
  }));
  scene.components = { c1: { rootNodeId: "m1", name: "Button" }, c2: { rootNodeId: "m2", name: "Card" } };
  useScene.getState().setScene(scene);
  return useScene.getState().scene!;
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, gesture: null, editingNodeId: null });
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

describe("instance command ops", () => {
  it("swap keeps the matching override and takes the new size", () => {
    const s = install();
    const ops = swapInstanceOps(s, ["i"], "c2");
    expect(ops.map((o) => o.kind.case)).toEqual(["setInstance", "setProps"]);
    expect(swapInstanceOps(s, ["i"], "c1")).toEqual([]);
    const next = ops.reduce((acc, op) => { useScene.getState().apply(op); return useScene.getState().scene!; }, s);
    expect(next.nodes.at("i")).toMatchObject({ width: 200, height: 120, instance: { componentId: "c2", overrides: [{ masterNodeId: "label2", text: "Pay" }] } });
  });

  it("reset clears one override or everything; detach replaces the node; main component finds the page", () => {
    const s = install();
    expect(resetInstanceOps(s, ["i"], "label")).toHaveLength(1);
    expect(resetInstanceOps(s, ["i"], "icon")).toEqual([]);
    expect(resetInstanceOps(s, ["i"])).toHaveLength(1);
    expect(detachInstanceOps(s, ["i", "label"]).map((o) => o.kind.case)).toEqual(["deleteNode", "createNode", "createNode"]);
    expect(mainComponentOf(s, "i")).toEqual({ rootId: "m1", pageId: "page1" });
    expect(mainComponentOf(s, "label")).toBeNull();
  });
});

describe("InstanceActions", () => {
  it("is shown only for instances", () => {
    install();
    useScene.setState({ selection: ["label"] });
    const { container } = render(<InstanceActions />);
    expect(container).toBeEmptyDOMElement();
  });

  it("swaps, resets and detaches in one undoable gesture each", async () => {
    const user = userEvent.setup();
    install();
    useScene.setState({ selection: ["i"] });
    render(<InstanceActions />);
    fireEvent.change(screen.getByRole("combobox", { name: "Swap instance" }), { target: { value: "c2" } });
    expect(useScene.getState().scene!.nodes.at("i").instance!.componentId).toBe("c2");
    expect(useScene.getState().undoStack).toHaveLength(1);
    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("i").instance!.componentId).toBe("c1");
    await user.click(screen.getByRole("button", { name: "Reset override on label" }));
    expect(useScene.getState().scene!.nodes.at("i").instance!.overrides).toEqual([]);
    cleanup();
    useScene.setState({ selection: ["i"] });
    render(<InstanceActions />);
    await user.click(screen.getByRole("button", { name: "Detach instance" }));
    const after = useScene.getState().scene!;
    expect(after.nodes.at("i").kind).toBe("frame");
    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("i").kind).toBe("instance");
  });

  it("goes to the main component, switching page", () => {
    install();
    useScene.getState().setCurrentPage("page1");
    useScene.setState({ selection: ["i"] });
    expect(goToMainComponent()).toBe(true);
    expect(useScene.getState().selection).toEqual(["m1"]);
    useScene.getState().setScene({ ...useScene.getState().scene!, nodes: useScene.getState().scene!.nodes.set("i", { ...useScene.getState().scene!.nodes.at("i"), instance: { componentId: "c2", overrides: [] } }) });
    useScene.setState({ selection: ["i"] });
    expect(goToMainComponent()).toBe(true);
    expect(useScene.getState().currentPageId).toBe("page2");
    expect(useScene.getState().selection).toEqual(["m2"]);
  });
});
