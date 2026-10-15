import { describe, it, expect } from "vitest";
import { emptyScene } from "../store/types";
import type { SceneState } from "../store/types";
import { colorToHex, fromDtcg, toCssVariables, toDtcg } from "./tokens";

const scene = (): SceneState => ({
  ...emptyScene("d", "t"),
  collections: { c1: { id: "c1", name: "Theme", modes: [{ id: "m1", name: "Light" }, { id: "m2", name: "Dark" }] } },
  variables: {
    v1: { id: "v1", collectionId: "c1", name: "color/surface", type: "color", values: { m1: { r: 1, g: 1, b: 1, a: 1 }, m2: { r: 0, g: 0, b: 0, a: 1 } } },
    v2: { id: "v2", collectionId: "c1", name: "color/accent/primary", type: "color", values: { m1: { r: 0.2, g: 0.4, b: 0.8, a: 0.5 }, m2: { r: 0.2, g: 0.4, b: 0.8, a: 0.5 } } },
    v3: { id: "v3", collectionId: "c1", name: "radius/card", type: "number", values: { m1: 12, m2: 16 } },
  },
});

describe("tokens out", () => {
  it("colorToHex adds alpha only when not opaque", () => {
    expect(colorToHex({ r: 1, g: 0, b: 0.2, a: 1 })).toBe("#ff0033");
    expect(colorToHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("#00000080");
  });

  it("DTCG: groups by '/', first mode as $value, the others in the extension", () => {
    const t = JSON.parse(toDtcg(scene()));
    expect(t.Theme.color.surface).toEqual({
      $type: "color", $value: "#ffffff", $extensions: { "com.opendesigner": { modes: { Dark: "#000000" } } },
    });
    expect(t.Theme.color.accent.primary.$value).toBe("#3366cc80");
    expect(t.Theme.radius.card).toMatchObject({ $type: "number", $value: 12 });
    expect(t.Theme.$extensions["com.opendesigner"].modes).toEqual(["Light", "Dark"]);
  });

  it("CSS: :root has the first mode; other modes only override what they change", () => {
    expect(toCssVariables(scene())).toBe(
      `:root {\n  --color-accent-primary: #3366cc80;\n  --color-surface: #ffffff;\n  --radius-card: 12;\n}\n\n` +
      `[data-theme="dark"] {\n  --color-surface: #000000;\n  --radius-card: 16;\n}\n`,
    );
    expect(toCssVariables(emptyScene("d", "t"))).toBe("");
  });
});

describe("tokens in", () => {
  it("round trip: what we export is what we import, modes included", () => {
    const back = fromDtcg(toDtcg(scene()), emptyScene("d", "t"));
    expect(back.skipped).toEqual([]);
    expect(back.collections).toHaveLength(1);
    const [col] = back.collections;
    expect(col.name).toBe("Theme");
    expect(col.modes.map((m) => m.name)).toEqual(["Light", "Dark"]);
    const byName = Object.fromEntries(back.variables.map((v) => [v.name, v]));
    expect(Object.keys(byName).sort()).toEqual(["color/accent/primary", "color/surface", "radius/card"]);
    const [light, dark] = col.modes.map((m) => m.id);
    expect(byName["color/surface"].values[dark]).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(byName["radius/card"].values).toEqual({ [light]: 12, [dark]: 16 });
    expect((byName["color/accent/primary"].values[light] as { a: number }).a).toBeCloseTo(0.5, 1);
  });

  it("reads a plain DTCG file: inherited $type, px strings, a single mode, name clashes", () => {
    const text = JSON.stringify({
      brand: { $type: "color", blue: { $value: "#0a84ff" }, red: { $value: "rgb(255, 0, 0)" } },
      space: { $type: "dimension", sm: { $value: "8px" }, md: { $value: "1.5rem" } },
      bad: { oops: { $type: "color", $value: "not a color" }, font: { $type: "fontFamily", $value: "Inter" } },
    });
    const s = { ...emptyScene("d", "t"), collections: { x: { id: "x", name: "brand", modes: [{ id: "m", name: "A" }] } } };
    const r = fromDtcg(text, s);
    expect(r.collections.map((c) => c.name)).toEqual(["brand 2", "space"]);
    expect(r.collections[0].modes.map((m) => m.name)).toEqual(["Default"]);
    const v = Object.fromEntries(r.variables.map((x) => [x.name, Object.values(x.values)[0]]));
    expect(v["blue"]).toMatchObject({ r: expect.closeTo(10 / 255, 3), b: 1 });
    expect(v["red"]).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(v["sm"]).toBe(8);
    expect(v["md"]).toBe(1.5);
    expect(r.skipped).toEqual(["bad/oops: unreadable value", "bad/font: type fontFamily"]);
    expect(r.collections.some((c) => c.name === "bad")).toBe(false);
  });

  it("refuses text that is not a token file", () => {
    expect(() => fromDtcg("[1,2]", emptyScene("d", "t"))).toThrow("not a design tokens file");
    expect(() => fromDtcg("nope", emptyScene("d", "t"))).toThrow();
  });
});
