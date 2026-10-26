import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { LongDocumentDialog } from "@/ui/LongDocumentDialog";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";

beforeEach(() => {
  cleanup();
  act(() => {
    useScene.getState().setScene(emptyScene("d", "Doc"));
    useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
  });
});

describe("LongDocumentDialog", () => {
  it("renders nothing while closed", () => {
    expect(render(<LongDocumentDialog isOpen={false} onOpenChange={() => {}} />).container.innerHTML).toBe("");
  });

  it("adds, toggles and deletes a condition in the document settings", () => {
    render(<LongDocumentDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("New condition"), { target: { value: "Print" } });
    fireEvent.click(screen.getByText("Add condition"));
    expect(useScene.getState().scene!.settings!.conditions).toEqual([{ name: "Print", visible: true }]);
    fireEvent.click(screen.getByLabelText("Show Print"));
    expect(useScene.getState().scene!.settings!.conditions![0]!.visible).toBe(false);
    fireEvent.click(screen.getByLabelText("Delete condition Print"));
    expect(useScene.getState().scene!.settings?.conditions).toBeUndefined();
  });

  it("creates a table style", () => {
    render(<LongDocumentDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("New table style"));
    expect(useScene.getState().scene!.settings!.tableStyles).toHaveLength(1);
    expect(screen.getByText("Select a table to apply it")).toBeTruthy();
  });

  it("says so when there are no editorial notes and no slips", () => {
    render(<LongDocumentDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByLabelText("Editorial notes").textContent).toContain("None.");
    fireEvent.click(screen.getByText("Check the text"));
    expect(screen.getByLabelText("Text checks").textContent).not.toContain("the the");
  });
});
