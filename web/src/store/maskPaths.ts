// Single source of truth for the supported SetProperties.mask paths. It mirrors
// EXACTLY the switch of core.applySetProps (Go, internal/core/apply.go:79-86)
// -- that switch is the AUTHORITY on what is supported, this list follows it,
// never the other way around. Do not add a path here without first verifying that Go
// accepts it: applyOp (TS) must remain semantically identical to core.Apply.
//
// WHY THIS FILE EXISTS (and not just a Set inside applyOp.ts): the
// transport is JSON -- connect-web's createConnectTransport uses JSON by
// default (no useBinaryFormat) -- and google.protobuf.FieldMask has a
// JSON encoding that REWRITES the path instead of carrying it verbatim:
//   - fieldMaskToJson (outbound) converts every path to lowerCamelCase and
//     THROWS if the conversion is not reversible, that is if
//     protoSnakeCase(protoCamelCase(p)) !== p (verified in
//     node_modules/@bufbuild/protobuf/dist/esm/to-json.js: fieldMaskToJson).
//   - fieldMaskFromJson (inbound) does the reverse and flatly REJECTS
//     any underscore on the wire (from-json.js: fieldMaskFromJson).
// So every path in this list MUST be written in the "library" snake_case
// form (identical to the one used by Go), NEVER in the camelCase form
// that comes naturally to someone writing TypeScript. For the 9 M0 paths the two
// forms coincide because they are all single-word -- which hid the
// problem until M1b, when "order_key" (the layers panel reordering,
// Task 8) became the first multi-word path. A path like that written here
// as "orderKey" would THROW at serialization time, not silently
// but still invisibly to the user (submit() applies it optimistically BEFORE
// serializing, so the error ends up in a console.error and the scene
// shows a change the server will never receive).
//
// THIS COMMENT IS NOT THE GUARD -- the tests in maskPaths.test.ts are, and
// it is worth knowing which ones before touching the list:
//   - it.each(MASK_PATHS) runs EVERY path through toJson -> fromJson and demands
//     that it comes back identical: an "orderKey" written here does not compile a
//     green list, it fails that case with the exact "irreversible" error that
//     would be seen in production. The same case also verifies that the path is a
//     real field name of opendesigner.v1.Node and that applyOp really applies it.
//   - a cross-language guard READS internal/core/apply.go and extracts the
//     literals of the `case`s: adding a path here (or only there) without the other
//     side makes the TypeScript suite fail. Go remains the authority; this list
//     exists so the same list does not have to be repeated at every call site.
//   - the mapped type PROBE in that test forces whoever adds a path to
//     also add a probe value, otherwise `tsc -b` does not pass.
export const MASK_PATHS = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "name",
  "visible",
  "fills",
  // M2, track 2 (stroke). Repeated like "fills" and with the SAME write
  // semantics: the mask replaces the WHOLE list, it does not merge element by
  // element. Single-word, so the round-trip on the wire is the identity -- but the
  // fixture testdata/golden/strokes.json exists anyway, because the risk here
  // is not the encoding: it is that the two apply implementations diverge on
  // replacement (a shorter list that leaves the old strokes at the tail is
  // only noticed by looking at the canvas).
  "strokes",
  // Effects (shadow, blur). Repeated like "fills" and "strokes", with the same
  // replacement semantics for the whole list. Single-word.
  "effects",
  // First MULTI-WORD path of the mask (M1b, Task 8: the layers panel
  // reordering). Written snake_case as Go writes it; on the JSON wire it becomes
  // "orderKey" and comes back as it is -- it is the whole reason this
  // file exists, see the comment at the top.
  "order_key",
  // M1b, Task 10 (properties panel, appearance). The ONLY mask path that
  // addresses a field INSIDE the `shape` oneof -- RectNode.corner_radius --
  // instead of a top-level field of the Node: the patch carries it nested
  // in the shape (`{ shape: { case: "rect", value: { cornerRadius } } }`) and
  // the op only applies to a rectangle (on an ellipse or a text Go replies
  // ErrNotRectNode and rejects the whole op, see applyOp). Multi-word like
  // order_key: on the JSON wire it travels as "cornerRadius" and comes back
  // as it is -- writing it camelCase here would THROW at serialization.
  "corner_radius",
  // Auto layout of a FRAME. Like corner_radius it lives INSIDE the `shape` oneof
  // (FrameNode.auto_layout) and only applies to a frame: on another node Go
  // replies ErrNotFrameNode and rejects the whole op. Writing a patch without
  // auto layout TURNS IT OFF. Multi-word: on the JSON wire it travels as "autoLayout".
  "auto_layout",
  // Free-form node metadata (flow.kind, code.route, test.id, ...). Like lists,
  // the mask REPLACES the whole map. Single-word.
  "meta",
  // Variable bindings (property -> variableId) and per-collection mode pins.
  // Like `meta`, the mask REPLACES the whole map, and an empty patch clears it.
  // Validated against the document's variables/collections on both sides.
  "bindings",
  "modes",
  // Shared text style: only a text node takes one, and it must exist (or be empty
  // to detach). Multi-word like order_key: on the JSON wire it is "textStyleId".
  "text_style_id",
  // Constraints (how a node follows its parent frame's resize) and layout sizing (how an
  // auto layout parent sizes it), per axis. The enums are closed: an out-of-range number is rejected.
  "constraint_x",
  "constraint_y",
  "layout_sizing_x",
  "layout_sizing_y",
  // Blend mode against what is behind the node. Closed enum: out of range is rejected.
  "blend_mode",
] as const;

// The ONLY type a mask path can have at an op's construction points
// (tools/ops.ts::makeSetPropsOp and whoever calls it). A path that Go does not
// support becomes a compile error there, not a silent runtime rejection
// discovered only by actually submitting the op.
export type MaskPath = (typeof MASK_PATHS)[number];

const MASK_PATH_SET: ReadonlySet<string> = new Set(MASK_PATHS);

// Type guard used by applyOp to validate paths that arrive from an already
// decoded Op (local or from the wire, via Subscribe) -- there the type is
// `readonly string[]` whatever the code that originated them says, so
// a runtime check is needed besides the compile-time protection above.
export function isMaskPath(path: string): path is MaskPath {
  return MASK_PATH_SET.has(path);
}
