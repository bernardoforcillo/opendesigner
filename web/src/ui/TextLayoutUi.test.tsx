import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { FindReplaceDialog } from "@/ui/FindReplaceDialog";
import { InsertTableDialog } from "@/ui/InsertTableDialog";
import { TableControls, TextOnPathControls, WrapControls } from "@/ui/TextLayoutControls";
import { useScene } from "@/store/store";
import { createTableOps, readTable } from "@/tools/tableOps";
import { emptyScene, type NodeLite, type SceneState } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
const STYLE = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a0", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
function install(nodes: NodeLite[], pages = [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }]) {
  let scene: SceneState = { ...emptyScene("d", "d"), pages };
  for (const n of nodes) scene = { ...scene, nodes: scene.nodes.set(n.id, n) };
  useScene.getState().setScene(scene);
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ currentPageId: "page1", selection: [], gesture: null, undoStack: [], redoStack: [], camera: { x: 0, y: 0, zoom: 1 } });
}
const scene = () => useScene.getState().scene!;
afterEach(cleanup);

describe("FindReplaceDialog", () => {
  beforeEach(() => install([
    node({ id: "a", kind: "text", text: { content: "The cat sat", style: STYLE } }),
    node({ id: "b", parentId: "page2", kind: "text", y: 10, text: { content: "A cat again, cat", style: STYLE } }),
  ]));
  const open = () => render(<FindReplaceDialog isOpen onOpenChange={() => {}} />);

  it("counts the matches and lists them with their pages", () => {
    open();
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "cat" } });
    expect(screen.getByText(/3 matches/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Page/ })).toHaveLength(3);
  });
  it("jumps to a match: opens its page and selects the text", () => {
    open();
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "cat" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(useScene.getState().currentPageId).toBe("page2");
    expect(useScene.getState().selection).toEqual(["b"]);
  });
  it("changes one match, then all the rest, each in one undo step", () => {
    open();
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "cat" } });
    fireEvent.change(screen.getByLabelText("Change to"), { target: { value: "dog" } });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(scene().nodes.get("a")!.text!.content).toBe("The dog sat");
    fireEvent.click(screen.getByRole("button", { name: "Change all" }));
    expect(scene().nodes.get("b")!.text!.content).toBe("A dog again, dog");
    useScene.getState().undo();
    expect(scene().nodes.get("b")!.text!.content).toBe("A cat again, cat");
  });
  it("explains a bad regular expression", () => {
    open();
    fireEvent.click(screen.getByLabelText("Regular expression"));
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "(" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("InsertTableDialog", () => {
  beforeEach(() => install([]));
  it("inserts a table of the size asked and selects it", () => {
    render(<InsertTableDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    const id = useScene.getState().selection[0];
    const t = readTable(scene(), id)!;
    expect([t.rows.length, t.cols.length, t.head]).toEqual([4, 3, 1]);
  });
});

describe("layout controls", () => {
  it("toggles the wrap of an object and sets its gap", () => {
    install([node({ id: "pic" })]);
    useScene.setState({ selection: ["pic"] });
    render(<WrapControls />);
    fireEvent.click(screen.getByLabelText("Wrap text around this object"));
    expect(scene().nodes.get("pic")!.meta).toEqual({ "wrap.mode": "box" });
    const gap = screen.getByRole("textbox", { name: "Gap" });
    fireEvent.change(gap, { target: { value: "12" } });
    fireEvent.blur(gap);
    expect(scene().nodes.get("pic")!.meta).toEqual({ "wrap.mode": "box", "wrap.offset": "12" });
    fireEvent.click(screen.getByLabelText("Wrap text around this object"));
    expect(scene().nodes.get("pic")!.meta).toBeUndefined();
  });
  it("offers no wrap for a text", () => {
    install([node({ id: "t", kind: "text", text: { content: "x", style: STYLE } })]);
    useScene.setState({ selection: ["t"] });
    expect(render(<WrapControls />).container).toBeEmptyDOMElement();
  });
  it("runs a text along a vector and releases it", () => {
    install([
      node({ id: "t", kind: "text", text: { content: "x", style: STYLE } }),
      node({ id: "v", kind: "vector", vector: { subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 50, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }] } }),
    ]);
    useScene.setState({ selection: ["t", "v"] });
    const { unmount } = render(<TextOnPathControls />);
    fireEvent.click(screen.getByRole("button", { name: "Run the text along the path" }));
    expect(scene().nodes.get("t")!.meta).toEqual({ "text.path": "v" });
    unmount();
    useScene.setState({ selection: ["t"] });
    render(<TextOnPathControls />);
    fireEvent.click(screen.getByRole("button", { name: "Release from the path" }));
    expect(scene().nodes.get("t")!.meta).toBeUndefined();
  });
  it("edits the rows and columns of the table the selection is in", () => {
    install([]);
    const made = createTableOps(scene(), "page1", 0, 0, 2, 2)!;
    made.ops.forEach((o) => new FakeSync().submit(o));
    const id = made.selection[0];
    const cell = readTable(scene(), id)!.cells.get("0,0")!.text!;
    useScene.setState({ selection: [cell.id] });
    render(<TableControls />);
    fireEvent.click(screen.getByRole("button", { name: "Row below" }));
    fireEvent.click(screen.getByRole("button", { name: "Column right" }));
    expect(readTable(scene(), id)).toMatchObject({ rows: [36, 36, 36], cols: [120, 120, 120] });
    fireEvent.click(screen.getByRole("button", { name: "Delete column" }));
    expect(readTable(scene(), id)!.cols).toHaveLength(2);
  });
});
