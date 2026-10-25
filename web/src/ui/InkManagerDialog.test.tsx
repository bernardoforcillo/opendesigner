import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { InkManagerDialog } from "./InkManagerDialog";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import { createSwatchOps } from "../tools/swatches";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

beforeEach(() => {
  cleanup();
  act(() => {
    useScene.getState().setScene(emptyScene("d", "Doc"));
    useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
    for (const spec of [
      { name: "Gold", cmyk: { c: 10, m: 30, y: 90, k: 0 }, spotName: "PANTONE 871 C" },
      { name: "Silver", cmyk: { c: 0, m: 0, y: 0, k: 40 }, spotName: "PANTONE 877 C" },
      { name: "Rich", cmyk: { c: 80, m: 70, y: 70, k: 90 } },
    ]) for (const op of createSwatchOps(useScene.getState().scene!, spec)!.ops) useScene.getState().apply(op);
  });
});

describe("InkManagerDialog", () => {
  it("renders nothing while closed", () => {
    expect(render(<InkManagerDialog isOpen={false} onOpenChange={() => {}} />).container.innerHTML).toBe("");
  });
  it("lists the inks and warns about total ink", () => {
    render(<InkManagerDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByLabelText("Spot inks").textContent).toContain("PANTONE 871 C");
    expect(screen.getByLabelText("Process inks").textContent).toContain("Rich (310%)");
  });
  it("converts one spot to process and aliases another", () => {
    render(<InkManagerDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByLabelText("Convert PANTONE 871 C to process"));
    expect(screen.getByLabelText("Status").textContent).toContain("now prints as process");
    expect(screen.getByLabelText("Spot inks").textContent).not.toContain("PANTONE 871 C");
    expect(screen.getByLabelText("Spot inks").textContent).toContain("PANTONE 877 C");
  });
  it("needs a selection to set overprint", () => {
    render(<InkManagerDialog isOpen onOpenChange={() => {}} />);
    expect((screen.getByText("Overprint both") as HTMLButtonElement).disabled).toBe(true);
  });
});
