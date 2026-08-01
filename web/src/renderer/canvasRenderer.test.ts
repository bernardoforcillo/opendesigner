import { describe, it, expect } from "vitest";
import { hitTest } from "./canvasRenderer";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function rect(id: string, x: number, y: number, order: string): NodeLite {
  return { id, parentId: "page1", orderKey: order, name: id, visible: true, opacity: 1,
    x, y, width: 50, height: 50, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], kind: "rect", cornerRadius: 0 };
}

describe("hitTest", () => {
  it("returns the topmost node under the point", () => {
    const s = emptyScene("d", "n");
    s.nodes["a"] = rect("a", 0, 0, "a0");
    s.nodes["b"] = rect("b", 10, 10, "a1"); // sopra (orderKey maggiore)
    expect(hitTest(s, 25, 25)).toBe("b");
    expect(hitTest(s, 5, 5)).toBe("a");
    expect(hitTest(s, 200, 200)).toBeNull();
  });
});
