import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { ObjectToolsDialog } from "@/ui/ObjectToolsDialog";
import { NodeSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "@/store/store";
import { emptyScene, toPbFills } from "@/store/types";
import { orderKeyBetween } from "@/store/orderKey";
import { makeCreateNodeOp } from "@/tools/ops";

const rect = (id: string, x: number, key: string) => makeCreateNodeOp(create(NodeSchema, { id, parentId: "page1", orderKey: key, name: id, visible: true, opacity: 1, x, y: 0, width: 40, height: 20, fills: toPbFills([{ r: 1, g: 0, b: 0, a: 1 }]), shape: { case: "rect", value: {} } }));

beforeEach(() => {
  cleanup();
  const k1 = orderKeyBetween(null, null);
  act(() => {
    useScene.getState().setScene(emptyScene("d", "Doc"));
    useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
    useScene.getState().apply(rect("a", 0, k1));
    useScene.getState().apply(rect("b", 100, orderKeyBetween(k1, null)));
    useScene.getState().setSelection(["a", "b"]);
  });
});
const nodes = () => [...useScene.getState().scene!.nodes.values()];
const status = () => screen.getByLabelText("Status").textContent;

describe("ObjectToolsDialog", () => {
  it("renders nothing while closed", () => {
    expect(render(<ObjectToolsDialog isOpen={false} onOpenChange={() => {}} />).container.innerHTML).toBe("");
  });
  it("repeats the selection and selects the copies", () => {
    render(<ObjectToolsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Copies"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("Repeat"));
    expect(nodes()).toHaveLength(6);
    expect(useScene.getState().selection).toHaveLength(4);
  });
  it("sets the gap and reports a refusal", () => {
    render(<ObjectToolsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Gap size"), { target: { value: "10" } });
    fireEvent.click(screen.getByText("Set gap"));
    expect(useScene.getState().scene!.nodes.get("b")!.x).toBe(50);
    act(() => useScene.getState().setSelection(["a"]));
    fireEvent.click(screen.getByText("Set gap"));
    expect(status()).toMatch(/at least two/);
  });
  it("adds a QR code, finds and recolours objects", () => {
    render(<ObjectToolsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("QR text"), { target: { value: "https://example.org" } });
    fireEvent.click(screen.getByText("Add"));
    expect(nodes().some((n) => n.name === "QR modules")).toBe(true);
    fireEvent.change(screen.getByLabelText("Fill colour"), { target: { value: "#ff0000" } });
    fireEvent.change(screen.getByLabelText("Name matches"), { target: { value: "^[ab]$" } });
    fireEvent.click(screen.getByText("Find"));
    expect(status()).toBe("2 found and selected.");
    fireEvent.change(screen.getByLabelText("Change fill to"), { target: { value: "#0000ff" } });
    fireEvent.click(screen.getByText("Change fill"));
    expect(useScene.getState().scene!.nodes.get("a")!.fills[0]).toMatchObject({ r: 0, b: 1 });
  });
  it("round-trips a snippet", () => {
    render(<ObjectToolsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("From selection"));
    expect((screen.getByLabelText("Snippet") as HTMLTextAreaElement).value).toContain("opendesigner/snippet");
    fireEvent.click(screen.getByText("Place"));
    expect(nodes()).toHaveLength(4);
  });
});
