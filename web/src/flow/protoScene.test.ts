import { describe, it, expect } from "vitest";
import { PROTO_PAGE_ID, sceneForScreen } from "./protoScene";
import { baseScene } from "./testSupport";
import { topLevelScreens } from "./screens";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { rootsOf } from "../renderer/canvasRenderer";

describe("sceneForScreen", () => {
  const s = baseScene();

  it("the derived scene has ONE page and ONE single root: the chosen screen", () => {
    const d = sceneForScreen(s, "B")!;
    expect(d.pages).toEqual([{ id: PROTO_PAGE_ID, name: "Prototype" }]);
    const roots = rootsOf(d, sceneIndexOf(d).children, PROTO_PAGE_ID);
    expect(roots.map((n) => n.id)).toEqual(["B"]);
    // the other screens are not reachable: no page contains them
    expect(topLevelScreens(d, PROTO_PAGE_ID).map((n) => n.id)).toEqual(["B"]);
  });

  it("the screen's children stay in place", () => {
    const d = sceneForScreen(s, "A")!;
    expect(d.nodes.at("btn").parentId).toBe("A");
  });

  it("does not mutate the starting scene", () => {
    sceneForScreen(s, "B");
    expect(s.nodes.at("B").parentId).toBe("page1");
    expect(s.pages.map((p) => p.id)).toEqual(["page1"]);
  });

  it("is memoized on the last pair (scene, screen)", () => {
    expect(sceneForScreen(s, "A")).toBe(sceneForScreen(s, "A"));
    expect(sceneForScreen(s, "A")).not.toBe(sceneForScreen(s, "B"));
  });

  it("nonexistent screen: null; hidden screen: it is shown anyway", () => {
    expect(sceneForScreen(s, "ghost")).toBeNull();
    const hidden = { ...s, nodes: s.nodes.set("A", { ...s.nodes.at("A"), visible: false }) };
    expect(sceneForScreen(hidden, "A")!.nodes.at("A").visible).toBe(true);
  });
});
