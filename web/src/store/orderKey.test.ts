import { describe, it, expect } from "vitest";
import { nextOrderKey } from "./orderKey";
import { emptyScene } from "./types";
import type { SceneState, NodeLite } from "./types";

function sceneWith(keys: string[]): SceneState {
  const s = emptyScene("d", "n");
  keys.forEach((k, i) => {
    s.nodes["n" + i] = { id: "n" + i, parentId: "page1", orderKey: k, name: "n", visible: true,
      opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], kind: "rect", cornerRadius: 0 } as NodeLite;
  });
  return s;
}

describe("nextOrderKey", () => {
  it("starts at a stable first key on an empty scene", () => {
    expect(nextOrderKey(emptyScene("d", "n"))).toBe("a000000");
  });

  it("REGRESSION: never collides with keys already in the document", () => {
    // Il bug M0: un contatore di modulo ripartiva da 0 dopo il reload e riemetteva a000000.
    const s = sceneWith(["a000000", "a000001", "a000002"]);
    const k = nextOrderKey(s);
    expect(Object.values(s.nodes).some((n) => n.orderKey === k)).toBe(false);
    expect(k > "a000002").toBe(true);
  });

  it("sorts after the highest existing key, not the count", () => {
    const s = sceneWith(["a000005"]);           // un solo nodo, ma chiave alta
    expect(nextOrderKey(s) > "a000005").toBe(true);
  });

  it("is monotonic when called repeatedly against a growing scene", () => {
    const s = sceneWith([]);
    let prev = "";
    for (let i = 0; i < 5; i++) {
      const k = nextOrderKey(s);
      expect(k > prev).toBe(true);
      s.nodes["x" + i] = { orderKey: k } as NodeLite;
      prev = k;
    }
  });
});
