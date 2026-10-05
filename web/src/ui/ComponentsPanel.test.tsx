import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { ComponentsPanel } from "./ComponentsPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

// SyncClient double: records the ops ON THE WIRE and models a server that accepts
// and ECHOES at once (applyPending + apply), like the other panel tests.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// A master FRAME at (100,100), 200x120: contentWorldBounds returns its
// own box (a frame has its own geometry), so the placed instance takes
// that size.
function frameNode(id: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a000001", name: "", visible: true, opacity: 1,
    x: 100, y: 100, width: 200, height: 120, rotation: 0,
    fills: [], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: false, ...over,
  };
}

function installWithComponent() {
  const scene = emptyScene("doc-1", "Untitled");
  scene.nodes = scene.nodes.set("master", frameNode("master"));
  scene.components["cmp1"] = { rootNodeId: "master", name: "Button" };
  // setScene: installs a COHERENT scene (view and confirmed aligned, queue
  // empty, history cleared), like in the other panel tests.
  useScene.getState().setScene(scene);
}

let sync: FakeSync;

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null });
  useScene.getState().setSync(sync);
});

afterEach(cleanup);

describe("empty state", () => {
  it("without components shows the empty state and lists nothing", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<ComponentsPanel />);
    expect(screen.getByText("No components")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("component list", () => {
  it("shows a button for each component, with its name", () => {
    installWithComponent();
    render(<ComponentsPanel />);
    expect(screen.getByRole("button", { name: "Button" })).toBeInTheDocument();
  });
});

describe("placing an instance", () => {
  it("emits ONE CreateNode of a node of kind instance, under the current page, and selects it", async () => {
    installWithComponent();
    render(<ComponentsPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Button" }));

    // ONE single op on the wire: a CreateNode with an `instance` shape that points to the
    // component.
    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("createNode");
    if (op.kind.case !== "createNode") throw new Error("wrong kind");
    const node = op.kind.value.node!;
    expect(node.parentId).toBe("page1"); // the current page
    expect(node.shape.case).toBe("instance");
    if (node.shape.case === "instance") {
      expect(node.shape.value.componentId).toBe("cmp1");
      expect(node.shape.value.overrides).toEqual([]);
    }
    // Size from the master (200x120 frame) and position shifted by 20 from its
    // corner, so it does not land on top of it.
    expect(node.width).toBe(200);
    expect(node.height).toBe(120);
    expect(node.x).toBe(120);
    expect(node.y).toBe(120);

    // Selected after creation, and it really is an instance in the scene.
    const scene = useScene.getState().scene!;
    expect(useScene.getState().selection).toEqual([node.id]);
    expect(scene.nodes.at(node.id)?.kind).toBe("instance");
    // One gesture, one undo entry.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("the placed instance is undone with Ctrl+Z (a single gesture)", async () => {
    installWithComponent();
    render(<ComponentsPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Button" }));
    const instId = useScene.getState().selection[0];
    expect(useScene.getState().scene!.nodes.at(instId)).toBeDefined();

    useScene.getState().undo();

    expect(useScene.getState().scene!.nodes.at(instId)).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });
});
