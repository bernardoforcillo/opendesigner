import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ActionsPalette } from "@/ui/shell/ActionsPalette";
import { buildPaletteActions } from "@/ui/shell/paletteActions";
import { rankActions, useActionsPalette, type PaletteAction } from "@/store/actions";
import { useScene } from "@/store/store";

const act1 = (id: string, label: string, group = "Tools", run: () => void = () => {}): PaletteAction => ({ id, label, group, run });

describe("rankActions", () => {
  const list = [act1("a", "Zoom to fit", "View"), act1("b", "Fit text", "Tools"), act1("c", "Rectangle", "Tools"), act1("d", "Zoom in", "View"), act1("e", "Undo", "Edit")];

  it("lists everything in order for an empty query, capped", () => {
    expect(rankActions(list, "").map((a) => a.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(rankActions(list, " ", 2).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("ranks a prefix before a word start before a substring before a group, shortest first", () => {
    expect(rankActions(list, "fit").map((a) => a.id)).toEqual(["b", "a"]); // "Fit text" starts with it; "Zoom to fit" has the word
    expect(rankActions(list, "ect").map((a) => a.id)).toEqual(["c"]); // substring
    expect(rankActions(list, "view").map((a) => a.id)).toEqual(["d", "a"]); // by group, the shorter label first
    expect(rankActions(list, "zzz")).toEqual([]);
  });
});

describe("buildPaletteActions", () => {
  const base = { tools: [{ id: "select" as const, label: "Select" }, { id: "text" as const, label: "Text" }], chooseTool: () => {}, modes: ["design" as const, "flows" as const] };

  it("offers the tools of the mode, the modes of the vertical, zoom and history", () => {
    const ids = buildPaletteActions({ ...base, publishing: false }).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["tool:select", "tool:text", "mode:design", "mode:flows", "zoom:fit", "zoom:selection", "edit:undo", "edit:redo"]));
    expect(ids).not.toContain("view:spread");
  });

  it("adds spreads and the dock tabs in the Publishing workspace", () => {
    const ids = buildPaletteActions({ ...base, publishing: true }).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["view:spread", "dock:styles", "dock:preflight"]));
  });

  it("runs the tool it names", () => {
    const chooseTool = vi.fn();
    buildPaletteActions({ ...base, chooseTool, publishing: false }).find((a) => a.id === "tool:text")!.run();
    expect(chooseTool).toHaveBeenCalledWith("text");
  });
});

describe("ActionsPalette", () => {
  beforeEach(() => { useActionsPalette.getState().setOpen(false); useScene.setState({ camera: { x: 0, y: 0, zoom: 1 } }); });
  afterEach(cleanup);

  it("opens with Ctrl+K, filters as you type and runs the highlighted action on Enter", () => {
    const run = vi.fn();
    render(<ActionsPalette actions={[act1("a", "Rectangle", "Tools", run), act1("b", "Undo", "Edit")]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })); });
    const box = screen.getByRole("combobox", { name: "Search actions" });
    fireEvent.change(box, { target: { value: "rect" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(useActionsPalette.getState().open).toBe(false);
  });

  it("moves the highlight with the arrows and runs it on a click", () => {
    const runB = vi.fn();
    render(<ActionsPalette actions={[act1("a", "Alpha"), act1("b", "Beta", "Tools", runB)]} />);
    act(() => useActionsPalette.getState().setOpen(true));
    const box = screen.getByRole("combobox", { name: "Search actions" });
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: /Beta/ }));
    expect(runB).toHaveBeenCalled();
  });

  it("says so when nothing matches", () => {
    render(<ActionsPalette actions={[act1("a", "Alpha")]} />);
    act(() => useActionsPalette.getState().setOpen(true));
    fireEvent.change(screen.getByRole("combobox", { name: "Search actions" }), { target: { value: "zzz" } });
    expect(screen.getByText("No matching action")).toBeInTheDocument();
  });
});
