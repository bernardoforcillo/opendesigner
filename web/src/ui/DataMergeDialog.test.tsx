import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { DataMergeDialog } from "./DataMergeDialog";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

beforeEach(() => {
  cleanup();
  const s = emptyScene("d", "Doc");
  s.nodes = s.nodes.set("t", { id: "t", parentId: "page1", orderKey: "a", name: "t", visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 20, rotation: 0, fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content: "Hi {{Name}}", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } } });
  act(() => {
    useScene.getState().setScene(s);
    useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
  });
});

describe("DataMergeDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<DataMergeDialog isOpen={false} onOpenChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("counts records, warns about a field with no column, and adds the pages", () => {
    render(<DataMergeDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByText(/\{\{Name\}\}/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Table"), { target: { value: "Other\n1" } });
    expect(screen.getByRole("alert").textContent).toMatch(/No column for \{\{Name\}\}/);
    fireEvent.change(screen.getByLabelText("Table"), { target: { value: "Name\nAda\nGrace" } });
    expect(screen.getByRole("status").textContent).toMatch(/2 records/);
    fireEvent.click(screen.getByText("Create merged pages"));
    const after = useScene.getState().scene!;
    expect(after.pages).toHaveLength(3);
    const contents = [...after.nodes.values()].map((n) => n.text?.content).sort();
    expect(contents).toEqual(["Hi Ada", "Hi Grace", "Hi {{Name}}"]);
  });
});
