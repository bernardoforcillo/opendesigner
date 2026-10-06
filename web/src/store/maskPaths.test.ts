import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create, toJson, fromJson, type MessageInitShape } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema, BlendMode, Constraint, LayoutSizing, StrokeAlign, VariableType, LayoutAlign, LayoutDirection } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { emptyScene, type NodeLite } from "./types";
import { MASK_PATHS, isMaskPath, type MaskPath } from "./maskPaths";
import { makeSetPropsOp } from "../tools/ops";

// ---------------------------------------------------------------------------
// Helper condivisi
// ---------------------------------------------------------------------------

function createRectOp(id: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

// Starting scene: a single node "n1" whose values are ALL different from the
// probe values used below, so "the field was written" and "the field was
// already like that" are never confused.
function baseScene() {
  return applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1"));
}

// auto_layout only applies to a FRAME: that path's probe needs n1 to be a
// frame instead of a rectangle, all the others stay on the rectangle.
function frameScene() {
  const node = create(NodeSchema, {
    id: "n1", parentId: "page1", orderKey: "a0", name: "Frame", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "frame", value: { clipsContent: true } },
  });
  return applyOp(emptyScene("doc1", "Untitled"), create(OpSchema, {
    opId: "op-frame", docId: "doc1", kind: { case: "createNode", value: { node } },
  }));
}
// bindings / modes are validated against the document, so their probes need a
// collection and a variable to point to.
function themedScene() {
  const ops = [
    create(OpSchema, { opId: "c", docId: "doc1", kind: { case: "setCollection", value: { collection: {
      id: "theme", name: "Theme", modes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }],
    } } } }),
    create(OpSchema, { opId: "v", docId: "doc1", kind: { case: "setVariable", value: { variable: {
      id: "dim", collectionId: "theme", name: "dim", type: VariableType.NUMBER,
      values: { light: { kind: { case: "number", value: 1 } }, dark: { kind: { case: "number", value: 0.5 } } },
    } } } }),
  ];
  return ops.reduce(applyOp, baseScene());
}
// text_style_id only applies to a TEXT node and needs a style to point to.
function textScene() {
  const node = create(NodeSchema, {
    id: "n1", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 20,
    shape: { case: "text", value: { content: "Hi", style: { fontSize: 16 } } },
  });
  return [
    create(OpSchema, { opId: "t", docId: "doc1", kind: { case: "createNode", value: { node } } }),
    create(OpSchema, { opId: "s", docId: "doc1", kind: { case: "setTextStyleDef", value: { textStyle: { id: "h", name: "Heading", style: { fontSize: 32 } } } } }),
  ].reduce(applyOp, emptyScene("doc1", "Untitled"));
}
const sceneFor = (path: string) =>
  path === "auto_layout" ? frameScene()
    : path === "bindings" || path === "modes" ? themedScene()
    : path === "text_style_id" ? textScene()
    : baseScene();

function setPropsOp(paths: readonly string[], patch: MessageInitShape<typeof NodeSchema> = {}): Op {
  return create(OpSchema, {
    opId: "op1", docId: "doc1",
    kind: { case: "setProps", value: { id: "n1", patch: create(NodeSchema, patch), mask: { paths: [...paths] } } },
  });
}

// The road the op REALLY takes: createConnectTransport (connect-web) does not pass
// useBinaryFormat, so every SubmitOp is serialized to JSON and every
// OpRecord coming back from Subscribe is deserialized from JSON. No test
// should build the message and hand it to applyOp without going through here: it is
// exactly in the middle that google.protobuf.FieldMask rewrites the paths.
function overWire(op: Op): Op {
  return fromJson(OpSchema, toJson(OpSchema, op));
}

function maskOf(op: Op): readonly string[] {
  if (op.kind.case !== "setProps") throw new Error("not a setProps op");
  return op.kind.value.mask?.paths ?? [];
}

// ---------------------------------------------------------------------------
// 1. CROSS-LANGUAGE guard: MASK_PATHS vs. the Go source, actually read.
//
// core.applySetProps (Go) is the AUTHORITY on which paths exist; maskPaths.ts
// mirrors it. A second hand-written copy INSIDE this test is not
// a guard: whoever adds a path updates it in the same commit and the test stays
// green. The only check that holds is reading internal/core/apply.go and
// extracting the literals of the `case`s -- the same technique golden.test.ts uses to
// read testdata/golden/. This way a `case "corner_radius"` added ONLY in Go makes
// the TypeScript suite fail, which is the point: without it, the client would silently
// reject an op the server accepts and would diverge from the authoritative
// document until reload.
// ---------------------------------------------------------------------------

const GO_APPLY_PATH = resolve(__dirname, "../../../internal/core/apply.go");
const GO_FN = "func applySetProps(";

// Returns the string literals of the `case`s of EVERY `switch path {` inside
// applySetProps, one slot per switch (today: the validation one and the application
// one). If apply.go is refactored into a shape this
// parser does not recognize, the result changes shape and the tests below fail
// loudly instead of becoming vacuous.
function goApplySetPropsSwitches(): string[][] {
  const src = readFileSync(GO_APPLY_PATH, "utf8");
  const at = src.indexOf(GO_FN);
  if (at < 0) {
    throw new Error(
      `${GO_APPLY_PATH} no longer contains "${GO_FN}": the cross-language guard no longer knows ` +
        `where to look. Update this parser along with the Go refactor.`,
    );
  }
  const after = src.slice(at + GO_FN.length);
  const nextFn = after.indexOf("\nfunc ");
  const body = nextFn < 0 ? after : after.slice(0, nextFn);

  return body
    .split(/switch\s+path\s*\{/)
    .slice(1)
    .map((block) => {
      const paths: string[] = [];
      for (const caseLine of block.matchAll(/\bcase\s+([^\n:]*):/g)) {
        for (const literal of caseLine[1].matchAll(/"([^"]*)"/g)) paths.push(literal[1]);
      }
      return paths;
    });
}

const uniqSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

describe("MASK_PATHS is anchored to core.applySetProps (Go), not to a local copy", () => {
  it("apply.go still exposes the two switches on `path` that this guard can read", () => {
    const switches = goApplySetPropsSwitches();
    // One validates the whole mask, the other applies the fields. If Go gains or
    // loses one, the parser must be reviewed BEFORE trusting the comparison below.
    expect(switches).toHaveLength(2);
    expect(switches[0].length).toBeGreaterThan(0);
    expect(switches[1].length).toBeGreaterThan(0);
  });

  it("the two Go switches list the same set (validation and application do not diverge)", () => {
    const [validated, applied] = goApplySetPropsSwitches();
    expect(uniqSorted(validated)).toEqual(uniqSorted(applied));
  });

  it("MASK_PATHS is EXACTLY the set of cases read from the Go source", () => {
    expect(uniqSorted(MASK_PATHS)).toEqual(uniqSorted(goApplySetPropsSwitches().flat()));
  });
});

// ---------------------------------------------------------------------------
// 2. Every path of MASK_PATHS, one by one: it is a real field, it survives the JSON
//    wire, and applyOp really applies it (and only it).
//
// It is the line that was missing. The wire is JSON and google.protobuf.FieldMask has an
// encoding that REWRITES the path instead of carrying it verbatim: fieldMaskToJson
// converts to lowerCamelCase and THROWS if protoSnakeCase(protoCamelCase(p)) !== p;
// fieldMaskFromJson flatly rejects underscores on the wire. With the 9
// single-word paths of M0 the two forms coincide, so the pitfall is
// invisible -- until someone writes "cornerRadius" in MASK_PATHS: it would pass
// every gate (the comparison with Go included, if updated in the same edit) and
// then would throw inside toJson during submitOp, with the reject swallowed by
// syncClient.ts. it.each(MASK_PATHS) makes it impossible to add a path without
// the wire round trip being verified for THAT path.
// ---------------------------------------------------------------------------

const NODE_FIELD_NAMES = NodeSchema.fields.map((f) => f.name);

// The field names of the SHAPES (RectNode/EllipseNode/TextNode), read from the `shape`
// oneof of the generated Node instead of listed by hand -- a list written here
// would stop following the .proto at the first field added.
//
// They are needed because "corner_radius" (M1b, Task 10) is the only mask path that
// is NOT a top-level field of the Node: it lives inside RectNode. The rest of the
// guard (b) below stays intact -- an invented camelCase or a field
// renamed in the .proto still does not appear in either list --
// but the accepted list stops being "Node only" and becomes "the model",
// that is exactly what NodeLite flattens into a single object.
const SHAPE_FIELD_NAMES = NodeSchema.fields
  .filter((f) => f.oneof?.name === "shape")
  .flatMap((f) => (f.fieldKind === "message" ? f.message.fields.map((sf) => sf.name) : []));

const MODEL_FIELD_NAMES = [...NODE_FIELD_NAMES, ...SHAPE_FIELD_NAMES];

// The path is snake_case (the .proto convention, and the form in which Go and
// MASK_PATHS write it); NodeLite's field is camelCase. For single-word
// paths the two forms coincide, for "order_key" they do not -- and without this
// conversion the probe below would demand an "order_key" field that NodeLite
// does not have (at compile time) and the assert would compare a nonexistent key
// (at runtime).
type CamelCase<S extends string> = S extends `${infer H}_${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : S;
const camelOf = (path: string): string => path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// A probe value for each path, different from the value baseScene() gives n1.
// The mapped type is NOT decorative: adding a path to MASK_PATHS without
// adding its probe here is a compile error (`tsc -b` in
// `pnpm build`), so the new path cannot escape it.each. And
// `NodeLite[CamelCase<P>]` forces MaskPath to remain a subset of the
// keys of NodeLite: a path that matches no field of the model
// falls to `never`, and there is no value to write in `expected`.
type Field<P extends MaskPath> = CamelCase<P> extends keyof NodeLite ? NodeLite[CamelCase<P>] : never;
type Probe = { [P in MaskPath]: { patch: MessageInitShape<typeof NodeSchema>; expected: Field<P> } };

const PROBE: Probe = {
  x: { patch: { x: 42 }, expected: 42 },
  y: { patch: { y: 7 }, expected: 7 },
  width: { patch: { width: 123 }, expected: 123 },
  height: { patch: { height: 456 }, expected: 456 },
  rotation: { patch: { rotation: 1.5 }, expected: 1.5 },
  opacity: { patch: { opacity: 0.25 }, expected: 0.25 },
  name: { patch: { name: "Rinominato" }, expected: "Rinominato" },
  visible: { patch: { visible: false }, expected: false },
  fills: {
    patch: { fills: [{ kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 1 } } } }] },
    expected: [{ r: 1, g: 0, b: 0, a: 1 }],
  },
  // The stroke is repeated like fills and travels with the same shape: a nested
  // Paint plus weight and alignment. The enum on the wire is its NAME
  // ("STROKE_ALIGN_OUTSIDE"), here it is the generated constant.
  strokes: {
    patch: {
      strokes: [{
        paint: { kind: { case: "solid", value: { color: { r: 0, g: 0, b: 1, a: 1 } } } },
        weight: 4,
        align: StrokeAlign.OUTSIDE,
      }],
    },
    expected: [{ color: { r: 0, g: 0, b: 1, a: 1 }, weight: 4, align: "outside" }],
  },
  // Effects: repeated like fills and strokes. The Effect's `kind` oneof travels
  // nested like the Paint's.
  effects: {
    patch: {
      effects: [
        { kind: { case: "dropShadow", value: { color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 2, offsetY: 4, blur: 8 } } },
        { kind: { case: "layerBlur", value: { radius: 3 } } },
      ],
    },
    expected: [
      { kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 2, offsetY: 4, blur: 8 },
      { kind: "layerBlur", radius: 3 },
    ],
  },
  order_key: { patch: { orderKey: "a5" }, expected: "a5" },
  // Auto layout: nested in the frame shape, and only applies to a frame (sceneFor).
  // Without hug: with hug the frame would change size and exact equality with
  // `before` plus only the written field would not hold.
  auto_layout: {
    patch: {
      shape: {
        case: "frame",
        value: {
          clipsContent: false,
          autoLayout: {
            direction: LayoutDirection.VERTICAL, spacing: 8,
            paddingLeft: 1, paddingTop: 2, paddingRight: 3, paddingBottom: 4,
            mainAlign: LayoutAlign.CENTER, crossAlign: LayoutAlign.END,
          },
        },
      },
    },
    expected: {
      direction: "vertical", spacing: 8, paddingLeft: 1, paddingTop: 2, paddingRight: 3, paddingBottom: 4,
      mainAlign: "center", crossAlign: "end", hugWidth: false, hugHeight: false,
    },
  },
  // The only probe whose patch is NESTED: corner_radius sits inside RectNode,
  // that is inside the `shape` oneof, not among the Node's top-level fields.
  // baseScene() creates n1 as a rectangle, so the shape matches (on
  // an ellipse or a text the op would be rejected as a whole, see block 6).
  corner_radius: {
    patch: { shape: { case: "rect", value: { cornerRadius: 12 } } },
    expected: 12,
  },
  // Free-form map: the mask replaces the whole map.
  meta: { patch: { meta: { "code.route": "/cart" } }, expected: { "code.route": "/cart" } },
  // Variable bindings and mode pins: maps like meta, validated against themedScene().
  bindings: { patch: { bindings: { opacity: "dim" } }, expected: { opacity: "dim" } },
  modes: { patch: { modes: { theme: "dark" } }, expected: { theme: "dark" } },
  // Shared text style: validated against textScene().
  text_style_id: { patch: { textStyleId: "h" }, expected: "h" },
  // Constraints and layout sizing: plain enums on any node.
  constraint_x: { patch: { constraintX: Constraint.MAX }, expected: "max" },
  constraint_y: { patch: { constraintY: Constraint.SCALE }, expected: "scale" },
  layout_sizing_x: { patch: { layoutSizingX: LayoutSizing.FILL }, expected: "fill" },
  layout_sizing_y: { patch: { layoutSizingY: LayoutSizing.FILL }, expected: "fill" },
  is_mask: { patch: { isMask: true }, expected: true },
  blend_mode: { patch: { blendMode: BlendMode.MULTIPLY }, expected: "multiply" },
};

describe("every MASK_PATHS path survives the JSON wire and is applied", () => {
  it.each(MASK_PATHS)(
    "%s: identical after toJson -> fromJson, real field of opendesigner.v1.Node, applied by applyOp",
    (path) => {
      // (a) the path goes out and comes back IDENTICAL from the FieldMask's JSON encoding.
      // This is the assertion a "cornerRadius" in MASK_PATHS cannot
      // pass: toJson throws HERE, in a test, instead of in production
      // inside submitOp with the reject swallowed by syncClient.
      const wired = overWire(setPropsOp([path], PROBE[path].patch));
      expect(maskOf(wired)).toEqual([path]);

      // (b) and it is a field name that really exists in the generated model --
      // on the Node, or on one of the shapes of the `shape` oneof (it is the case of
      // corner_radius) -- not an invented camelCase, not a field renamed
      // in the .proto and never propagated here. Surviving the wire is not enough:
      // "bogus" survives.
      expect(MODEL_FIELD_NAMES).toContain(path);

      // (c) and after that round trip applyOp REALLY applies it, writing that field
      // and no other (a `case "y": next.x = ...` would fail here).
      const before = sceneFor(path).nodes.at("n1");
      const after = applyOp(sceneFor(path), wired).nodes.at("n1");
      expect(after).toEqual({ ...before, [camelOf(path)]: PROBE[path].expected });
    },
  );
});

// ---------------------------------------------------------------------------
// 3. The complement: what is NOT in MASK_PATHS must not touch the scene.
//    Together with block 2 this pins the set accepted by applyOp to
//    exactly MASK_PATHS -- behavior, not source shape.
// ---------------------------------------------------------------------------

// All round-trippable on the wire (no irreversible underscore): the reason
// they are rejected is that core.applySetProps does not have them, not that the
// encoding breaks them. This list has already shortened twice -- "order_key"
// left it with the layers panel reordering (Task 8) and
// "corner_radius" with the properties panel (Task 10): in both cases it was
// the cross-language guard of block 1 that failed first and
// forced MASK_PATHS, PROBE and this list to be updated together.
const NOT_IN_GO_SWITCH = ["parent_id", "id", "shape", "bogus"];

describe("a path outside MASK_PATHS makes the WHOLE op rejected", () => {
  it.each(NOT_IN_GO_SWITCH)("%s: isMaskPath false, and the scene stays unchanged even in a mixed mask", (path) => {
    expect(isMaskPath(path)).toBe(false);

    const wired = overWire(setPropsOp(["x", path], { x: 999 }));
    // The path arrives intact: the rejection is applyOp's decision, not a
    // side effect of the encoding.
    expect(maskOf(wired)).toEqual(["x", path]);

    // Parity with core.applySetProps: validates the whole mask BEFORE mutating, so
    // "x" does not even move if it is in the same mask as an unknown path.
    expect(applyOp(baseScene(), wired).nodes.at("n1")).toEqual(baseScene().nodes.at("n1"));
  });
});

// ---------------------------------------------------------------------------
// 4. The construction point: makeSetPropsOp accepts only MaskPath.
//
// This is a type constraint, so the test that proves it is compile-time.
// `@ts-expect-error` is a real assertion verified by `tsc -b` (pnpm build,
// tsconfig includes "src", so the .test.ts files too): if `paths` went back to
// `string[]`, the line would stop being an error and TypeScript would fail
// with "Unused '@ts-expect-error' directive". A grep on the source, instead,
// would pass on any reformatting and fail on a line break.
// ---------------------------------------------------------------------------

describe("makeSetPropsOp does not let you build an op with an unsupported path", () => {
  it("a camelCase path is a compile error at the construction point, and at runtime it does not reach the wire", () => {
    // @ts-expect-error "cornerRadius" is not a MaskPath.
    const bad = makeSetPropsOp("n1", { shape: { case: "rect", value: { cornerRadius: 12 } } }, ["cornerRadius"]);

    // If someone circumvented the type (an `as MaskPath`, a hand-built op),
    // here is what would really happen in submitOp: toJson throws, the op never
    // leaves, and the local scene shows a change the server will not see.
    expect(() => toJson(OpSchema, bad)).toThrow(/irreversible/);
  });

  it("a valid snake_case path passes the type, the wire and applyOp", () => {
    const op = makeSetPropsOp("n1", { x: 42, y: 7 }, ["x", "y"]);
    const wired = overWire(op);
    expect(maskOf(wired)).toEqual(["x", "y"]);

    const after = applyOp(baseScene(), wired).nodes.at("n1");
    expect(after.x).toBe(42);
    expect(after.y).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 5. The shape of the FieldMask on the wire, pinned on a real multi-word path.
//    Documents WHY the blocks above exist: the conversion is not the identity
//    as soon as a path has more than one word.
// ---------------------------------------------------------------------------

describe("FieldMask shape on the JSON wire", () => {
  it("snake_case in TS/Go, lowerCamelCase on the wire, snake_case again on return", () => {
    const op = setPropsOp(["corner_radius"], { shape: { case: "rect", value: { cornerRadius: 12 } } });

    // On the wire the FieldMask is a single STRING (not an array), paths joined by
    // comma, in lowerCamelCase -- like "x,y" in the existing golden fixtures,
    // only here the conversion is not the identity.
    const wire = toJson(OpSchema, op) as { setProps?: { mask?: string } };
    expect(wire.setProps?.mask).toBe("cornerRadius");

    // fieldMaskFromJson converts back: the round trip returns EXACTLY to the starting
    // path, not to the wire form.
    expect(maskOf(fromJson(OpSchema, wire))).toEqual(["corner_radius"]);
  });

  it("an underscore on the wire is rejected on input (nobody can bypass the convention)", () => {
    const wire = { opId: "op1", docId: "doc1", setProps: { id: "n1", mask: "corner_radius" } };
    expect(() => fromJson(OpSchema, wire)).toThrow();
  });
});
