import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { invertOp } from "./history";
import { emptyScene, type SceneState } from "./types";
import { resolveNode, resolveScene } from "./variables";

type Kind = MessageInitShape<typeof OpSchema>["kind"];
const op = (kind: Kind): Op => create(OpSchema, { opId: crypto.randomUUID(), docId: "d", kind });
const textNode = (id: string) => op({ case: "createNode", value: { node: create(NodeSchema, {
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, width: 100, height: 20,
  shape: { case: "text", value: { content: "Hi", style: { fontFamily: "Inter, sans-serif", fontSize: 16 } } },
}) } });
const font = (id: string, family: string, weight: string, style: string, assetHash: string) =>
  op({ case: "setFont", value: { font: { id, family, weight, style, assetHash } } });
const styleDef = (id: string, fontSize: number, family = "Brand") =>
  op({ case: "setTextStyleDef", value: { textStyle: { id, name: id, style: { fontFamily: family, fontSize, fontWeight: "700" } } } });
const useStyle = (id: string, styleId: string) =>
  op({ case: "setProps", value: { id, mask: { paths: ["text_style_id"] }, patch: create(NodeSchema, { textStyleId: styleId }) } });

const run = (ops: Op[], from: SceneState = emptyScene("d", "d")) => ops.reduce(applyOp, from);
const H = (c: string) => c.repeat(64);

describe("fonts", () => {
  it("refuses unsafe families, bad weights, styles and hashes, and duplicates", () => {
    const base = run([font("f1", "Brand Sans", "700", "normal", H("a"))]);
    for (const bad of [
      font("f2", "Brand Sans", "700", "normal", H("b")),       // same family/weight/style
      font("f2", 'A"; evil', "400", "normal", H("b")),
      font("f2", "A{B}", "400", "normal", H("b")),
      font("f2", "   ", "400", "normal", H("b")),
      font("f2", "X".repeat(65), "400", "normal", H("b")),
      font("f2", "Brand Sans", "450", "normal", H("b")),
      font("f2", "Brand Sans", "400", "oblique", H("b")),
      font("f2", "Brand Sans", "400", "italic", "ABC"),
      font("", "Brand Sans", "400", "italic", H("b")),
    ]) expect(applyOp(base, bad), JSON.stringify(bad.kind)).toBe(base);
    expect(applyOp(base, font("f2", "Noto Sans 日本語", "400", "normal", H("b"))).fonts.f2).toBeDefined();
    // Upserting the same id with the same triple is fine (an absolute replace).
    expect(applyOp(base, font("f1", "Brand Sans", "700", "normal", H("c"))).fonts.f1.assetHash).toBe(H("c"));
  });

  it("undo restores a replaced and a deleted font", () => {
    const base = run([font("f1", "Brand Sans", "700", "normal", H("a"))]);
    for (const direct of [font("f1", "Brand Sans", "700", "italic", H("c")), op({ case: "deleteFont", value: { id: "f1" } }), font("f9", "Other", "400", "normal", H("d"))]) {
      const inverse = invertOp(base, direct);
      expect(inverse).not.toBeNull();
      expect(run(inverse!, applyOp(base, direct)).fonts).toEqual(base.fonts);
    }
    expect(invertOp(base, op({ case: "deleteFont", value: { id: "ghost" } }))).toBeNull();
  });
});

describe("text styles", () => {
  const base = () => run([textNode("t"), styleDef("h", 32), useStyle("t", "h")]);

  it("a node draws with its shared style while its own style stays as the fallback", () => {
    const s = base();
    expect(resolveNode(s, s.nodes.at("t")).text!.style.fontSize).toBe(32);
    expect(s.nodes.at("t").text!.style.fontSize).toBe(16);
    // Editing the shared style changes every node that uses it, through the resolved scene.
    const edited = applyOp(s, styleDef("h", 48));
    expect(resolveScene(edited).nodes.at("t").text!.style.fontSize).toBe(48);
  });

  it("only a text node takes a style, and it must exist", () => {
    const s = base();
    const rect = applyOp(s, op({ case: "createNode", value: { node: create(NodeSchema, { id: "r", parentId: "page1", orderKey: "r", visible: true, opacity: 1, width: 10, height: 10, shape: { case: "rect", value: {} } }) } }));
    expect(applyOp(rect, useStyle("r", "h"))).toBe(rect);
    expect(applyOp(s, useStyle("t", "ghost"))).toBe(s);
    expect(applyOp(s, useStyle("t", "")).nodes.at("t").textStyleId).toBeUndefined();
  });

  it("refuses a style with a negative size or an unsafe family", () => {
    const s = run([textNode("t")]);
    for (const bad of [styleDef("x", -1), styleDef("x", 12, "a{b}"), styleDef("", 12), op({ case: "setTextStyleDef", value: { textStyle: { id: "x", name: "x" } } })]) {
      expect(applyOp(s, bad)).toBe(s);
    }
    expect(applyOp(s, styleDef("x", 12, "Inter, sans-serif")).textStyles.x).toBeDefined();
  });

  it("deleting a style clears it on the nodes, and undo restores both", () => {
    const s = base();
    const direct = op({ case: "deleteTextStyleDef", value: { id: "h" } });
    const inverse = invertOp(s, direct)!;
    const after = applyOp(s, direct);
    expect(after.nodes.at("t").textStyleId).toBeUndefined();
    const back = run(inverse, after);
    expect(back.textStyles).toEqual(s.textStyles);
    expect(back.nodes.at("t")).toEqual(s.nodes.at("t"));
  });

  it("resolveScene is free without variables or styles", () => {
    const plain = run([textNode("t")]);
    expect(resolveScene(plain)).toBe(plain);
  });
});
