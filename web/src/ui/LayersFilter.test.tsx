import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { LayersPanel, filterRows, visibleRows } from "@/ui/LayersPanel";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import type { NodeLite } from "@/store/types";

const node = (id: string, parentId: string, orderKey: string, name: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId, orderKey, name, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 100, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});

function install() {
  const scene = emptyScene("d", "D");
  const nodes: NodeLite[] = [
    node("hero", "page1", "a", "Hero", { kind: "frame" }),
    node("title", "hero", "a", "Title"),
    node("cta", "hero", "b", "Call to action"),
    node("footer", "page1", "b", "Footer", { kind: "frame" }),
    node("logo", "footer", "a", "Logo"),
  ];
  for (const n of nodes) scene.nodes = scene.nodes.set(n.id, n);
  useScene.getState().setScene(scene);
  useScene.setState({ currentPageId: "page1", selection: [], gesture: null });
}

beforeEach(install);
afterEach(cleanup);

describe("filterRows", () => {
  const all = () => visibleRows(useScene.getState().scene!, "page1", () => false);

  it("keeps everything for an empty query", () => {
    expect(filterRows(all(), "  ").map((r) => r.id)).toEqual(all().map((r) => r.id));
  });

  it("keeps a match and the containers that lead to it, in tree order", () => {
    expect(filterRows(all(), "logo").map((r) => r.id)).toEqual(["footer", "logo"]);
    expect(filterRows(all(), "TITLE").map((r) => [r.id, r.depth])).toEqual([["hero", 0], ["title", 1]]);
  });

  it("matches several branches, and a container that matches does not drag its children along", () => {
    expect(filterRows(all(), "o").map((r) => r.id)).toEqual(["footer", "logo", "hero", "cta"]);
    expect(filterRows(all(), "hero").map((r) => r.id)).toEqual(["hero"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterRows(all(), "zzz")).toEqual([]);
  });
});

describe("LayersPanel find layers", () => {
  it("filters the list as you type, and Escape brings it all back", () => {
    render(<LayersPanel />);
    expect(screen.getByText("Title")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Find layers" });
    fireEvent.change(field, { target: { value: "logo" } });
    const list = screen.getByRole("grid");
    expect(within(list).queryByText("Title")).toBeNull();
    expect(within(list).getByText("Logo")).toBeInTheDocument();
    expect(within(list).getByText("Footer")).toBeInTheDocument();
    // while filtering, containers cannot be collapsed and rows cannot be reordered
    expect(within(list).queryByRole("button", { name: /Collapse/ })).toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("");
    expect(screen.getByText("Title")).toBeInTheDocument();
  });
});
