import { describe, it, expect } from "vitest";
import { emptyScene } from "@/store/types";
import type { SceneState } from "@/store/types";
import { buildGeneratePrompt, designKitOf, kitIsEmpty } from "@features/generate/prompt";

const scene = (): SceneState => ({
  ...emptyScene("d", "Doc"),
  components: { c1: { rootNodeId: "n1", name: "Button" }, c2: { rootNodeId: "n2", name: "Avatar" } },
  variables: {
    v1: { id: "v1", collectionId: "k", name: "color/primary", type: "color", values: {} },
    v2: { id: "v2", collectionId: "k", name: "space/md", type: "number", values: {} },
  },
  textStyles: {
    t1: { id: "t1", name: "Heading", style: { fontSize: 28 } as never },
    t2: { id: "t2", name: "Bold run", kind: "character", style: { fontSize: 16 } as never },
  },
});

describe("designKitOf", () => {
  it("lists components, color variables only, and paragraph text styles, sorted", () => {
    expect(designKitOf(scene())).toEqual({ components: ["Avatar", "Button"], colorVariables: ["color/primary"], textStyles: ["Heading"] });
  });
  it("is empty without a document or a kit", () => {
    expect(kitIsEmpty(designKitOf(null))).toBe(true);
    expect(kitIsEmpty(designKitOf(emptyScene("d", "Doc")))).toBe(true);
  });
});

describe("buildGeneratePrompt", () => {
  const kit = designKitOf(scene());
  it("carries the description, the kit's names and the tools to use", () => {
    const p = buildGeneratePrompt("A sign in form", kit, { width: 390 });
    for (const s of ["A sign in form", '"Button"', '"color/primary"', '"Heading"', "generate_screen", "get_design_kit", "width 390", "Never write a literal color"]) expect(p).toContain(s);
  });
  it("says (none) for an empty list and defaults the width", () => {
    const p = buildGeneratePrompt("x", { components: [], colorVariables: [], textStyles: [] });
    expect(p).toContain("Components: (none)");
    expect(p).toContain("width 393");
  });
  it("points the agent at the attached screenshot", () => {
    expect(buildGeneratePrompt("", designKitOf(scene()), { screenshot: true })).toContain("attached screenshot");
  });
});
