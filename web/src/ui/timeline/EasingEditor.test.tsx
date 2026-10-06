import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CURVE_BOX, EasingEditor } from "./EasingEditor";
import { toPx } from "../../animation/easingEdit";

afterEach(cleanup);

// The mini-curve: the menu picks a named curve, the two points are dragged on a
// DRAFT and the release commits only ONCE.
const BOX = CURVE_BOX;

describe("EasingEditor", () => {
  it("the menu offers the named curves and 'Curve…' starts from a valid Bézier", async () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="easeOut" onCommit={onCommit} />);
    const sel = screen.getByRole("combobox", { name: "Easing" });
    expect(sel).toHaveValue("easeOut");
    await userEvent.selectOptions(sel, "spring");
    expect(onCommit).toHaveBeenLastCalledWith("spring");
    await userEvent.selectOptions(sel, "custom");
    expect(onCommit).toHaveBeenLastCalledWith("cubic-bezier(0.25,0.1,0.25,1)");
  });

  it("dragging a point: the draft shows immediately, the commit is ONE on release", () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="linear" onCommit={onCommit} />);
    const h2 = screen.getByRole("button", { name: "Control point 2" });
    const p = toPx(BOX, 0.7, 1.2);
    fireEvent.pointerDown(h2, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(screen.getByRole("group", { name: "Easing curve" }), { pointerId: 1, clientX: p.x, clientY: p.y });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("cubic-bezier(0,0,0.7,1.2)")).toBeInTheDocument(); // the label follows the draft
    fireEvent.pointerUp(screen.getByRole("group", { name: "Easing curve" }), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("cubic-bezier(0,0,0.7,1.2)");
  });

  it("a press without movement commits nothing", () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="easeIn" onCommit={onCommit} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Control point 1" }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByRole("group", { name: "Easing curve" }), { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("the arrows move a point from the keyboard", () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="linear" onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Control point 1" }), { key: "ArrowUp" });
    expect(onCommit).toHaveBeenCalledWith("cubic-bezier(0,0.02,1,1)");
  });
});
