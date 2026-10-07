import { NodeMap } from "./nodeMap";
import { create } from "@bufbuild/protobuf";
import { BlendMode, ImageScaleMode, LayoutGridKind, CommentSchema, ClipSchema, Constraint, LayoutSizing, ComponentPropertySchema, ComponentPropertyType, ComponentSetSchema, FlowSchema, FontFaceSchema, TextStyleDefSchema, VariableCollectionSchema, VariableSchema, VariableType, TransitionSchema, LayoutAlign, LayoutDirection, NodeSchema, StrokeAlign, TextAlign } from "../gen/opendesigner/v1/opendesigner_pb";
import type {
  Document, Component as PbComponent, ComponentProperty as PbComponentProperty, ComponentSet as PbComponentSet, FontFace as PbFont, TextStyleDef as PbTextStyleDef, VariableCollection as PbCollection, Variable as PbVariable, Clip as PbClip, Flow as PbFlow, Transition as PbTransition, Node as PbNode, Comment as PbComment, LayoutGrid as PbLayoutGrid, Paint as PbPaint, Stroke as PbStroke, Effect as PbEffect, AutoLayout as PbAutoLayout,
  TextNode as PbTextNode, TextStyle as PbTextStyle,
  SubPath as PbSubPath, VectorNode as PbVectorNode,
  InstanceNode as PbInstanceNode, InstanceOverride as PbInstanceOverride,
} from "../gen/opendesigner/v1/opendesigner_pb";

export interface PageLite { id: string; name: string; }
export interface GradientStopLite { color: { r: number; g: number; b: number; a: number }; position: number; }
// A gradient in NORMALIZED box coordinates (see GradientPaint in the proto).
// Linear: axis (x1,y1)->(x2,y2). Radial: center (x1,y1), radius = |p2-p1| in
// world coordinates.
export interface GradientLite {
  kind: "linear" | "radial";
  stops: GradientStopLite[];
  x1: number; y1: number; x2: number; y2: number;
}
// r,g,b,a remain the "fallback" color: for a solid fill they ARE the
// color, for a gradient they are the first stop. All code that only knows
// flat tints (text, strokes, panels) keeps working without knowing about
// gradients; whoever can draw them looks at `gradient`.
// A mesh gradient (see MeshPaint in the proto): a rows x cols grid of colors, row-major, blended
// bilinearly over the node's box. r,g,b,a of the fill hold the AVERAGE color, the fallback for whoever
// cannot draw a mesh.
export interface MeshLite { rows: number; cols: number; colors: { r: number; g: number; b: number; a: number }[] }
export interface FillLite { r: number; g: number; b: number; a: number; gradient?: GradientLite; image?: ImagePaintLite; mesh?: MeshLite; }

// An image as a paint (see ImagePaint in the proto). r/g/b/a stay as the base color the
// renderers fall back to while the image has not arrived.
export type ImageScaleModeLite = "fill" | "fit" | "tile";
export interface ImagePaintLite { assetHash: string; mode: ImageScaleModeLite }

// The stroke alignment as a string, for the same reason as
// TextAlignLite: the in-memory model is what renderer and panels read, and
// a string is readable (and writable in a test) without importing the generated code.
// STROKE_ALIGN_UNSPECIFIED collapses to "center" -- it is the canvas 2D default,
// so the distinction is not observable.
export type StrokeAlignLite = "center" | "inside" | "outside";

// A FLATTENED stroke, as FillLite is for a Paint: the resolved color and
// nothing else. The weight is in WORLD coordinates (like fontSize), so a stroke of 4
// stays 4 units thick at every zoom -- it scales with the node, not with the
// screen. The default 0 is "no stroke to draw", not "very thin":
// a non-positive weight produces neither pixels nor bounds overhang (see
// canvas/geometry.ts::strokeOutsetOf).
export interface StrokeLite { color: FillLite; weight: number; align: StrokeAlignLite; }

// Auto layout of a frame (see AutoLayout in the proto and store/layout.ts). As
// for StrokeAlignLite, enums are strings: UNSPECIFIED collapses to
// "horizontal" / "start", which is what the computation would do anyway.
export type LayoutDirectionLite = "horizontal" | "vertical";
export type LayoutAlignLite = "start" | "center" | "end" | "space-between";
export interface AutoLayoutLite {
  direction: LayoutDirectionLite;
  spacing: number;
  paddingLeft: number; paddingTop: number; paddingRight: number; paddingBottom: number;
  mainAlign: LayoutAlignLite;
  crossAlign: LayoutAlignLite;
  hugWidth: boolean; hugHeight: boolean;
  // Present only when set (like the optional fields of NodeLite), so a layout that never
  // used them stays identical field by field: `wrap` flows the children onto lines,
  // `crossSpacing` is the gap between the lines.
  wrap?: true;
  crossSpacing?: number;
}

// How a node follows its parent frame's resize (CONSTRAINTS), and how an auto layout parent
// sizes it (LAYOUT SIZING), per axis. Absent = the proto default: "min" / fixed.
export type BlendModeLite =
  | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn"
  | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
// A layout grid of a frame (see LayoutGrid in the proto).
export interface LayoutGridLite {
  kind: "grid" | "columns" | "rows";
  size: number; count: number; gutter: number; margin: number;
  color: { r: number; g: number; b: number; a: number };
}
export type ConstraintLite = "min" | "max" | "stretch" | "center" | "scale";

// A node effect. Shadow and blur are in WORLD coordinates, like a stroke's
// weight: they scale with the zoom. The renderer draws the FIRST
// shadow and the FIRST blur of a node (canvas 2D has a single shadow state);
// the model and the wire nonetheless keep the whole list.
export type EffectLite =
  | { kind: "dropShadow"; color: { r: number; g: number; b: number; a: number }; offsetX: number; offsetY: number; blur: number }
  | { kind: "layerBlur"; radius: number }
  | { kind: "innerShadow"; color: { r: number; g: number; b: number; a: number }; offsetX: number; offsetY: number; blur: number }
  | { kind: "backgroundBlur"; radius: number };

// The alignment as a string and not as a numeric enum, for the same reason
// that `kind` is "rect" | "ellipse" | "text" instead of the oneof's
// discriminant: the in-memory model is what renderer and panels read, and a
// string is readable (and writable in a test) without importing the generated code.
// TEXT_ALIGN_UNSPECIFIED collapses to "left" -- it is the default the renderer
// should apply anyway, so the distinction is not observable.
export type TextAlignLite = "left" | "center" | "right";

// No default is resolved here: `lineHeight: 0` stays 0 and does not become 1.2.
// The default belongs to the RENDERER (see the comment in the proto), and applying it in
// the model would make this side diverge from core.Apply (Go), which preserves
// the zero.
export interface TextStyleLite {
  fontFamily: string; fontSize: number; fontWeight: string;
  lineHeight: number; align: TextAlignLite;
  // Absent when upright (not `false`): a style that never had it stays identical, field by field.
  italic?: boolean;
}
export interface TextLite { content: string; style: TextStyleLite; }

// An image is a REFERENCE, never bytes: `assetHash` is the sha256
// (lowercase hex) of the bytes, which live in <doc>.opendesigner/assets/ and are
// loaded from the URL built by rpc/assets.ts::assetUrl.
//
// The model contains no pixels, and this is the property not to lose: a
// NodeLite ends up inside ops, inside the snapshot and inside the clipboard
// payload, and none of those three places must ever carry an image.
export interface ImageLite { assetHash: string; }

// Vector geometry. Mirrors opendesigner.v1.Anchor/SubPath/VectorNode one to
// one: no default resolved here and no "convenient" shape (no precomputed
// segments, no relative handles), for the same reason
// TextStyleLite does not resolve lineHeight -- this model must remain
// indistinguishable from what core.Apply (Go) keeps in memory, and every
// derivation made here would be one more rule to keep identical over there.
//
// THE TWO SPACES (full, reasoned rule in the proto, on `Anchor`; the only
// implementation is ./vectorGeometry.ts, and nothing else must redo it by hand):
//   - x/y are LOCAL to the node: the world point is (node.x + a.x, node.y + a.y).
//     This way the geometry moves with the node, and a drag stays the setProps{x,y}
//     that selectTool already sends today.
//   - inX/inY and outX/outY are OFFSETS RELATIVE to the anchor: the incoming
//     control is (x + inX, y + inY). (0,0) means handle coincident with
//     the anchor, that is NO handle -- the segment is a straight line. It is also
//     the proto3 default, so a corner anchor is written by omitting
//     the fields instead of filling them.
export interface AnchorLite {
  x: number; y: number;
  inX: number; inY: number;
  outX: number; outY: number;
}
export interface SubPathLite { anchors: AnchorLite[]; closed: boolean; }
export interface VectorLite { subpaths: SubPathLite[]; }

// M4 — a per-instance override on ONE node of the master, FLATTENED like the other
// Lite types. PRESENCE is the optional, not two boolean flags: `fills` is defined if and
// only if the proto has fills_present, `text` if and only if text_present. This way
// the ABSENCE of the field in the model IS the proto's "not overridden", and distinguishes
// "I do not override the fill" from "I override the fill with an empty list" (or the text with an
// empty string) without carrying along a fill the user has not touched --
// like style_present for SetText. An override with neither fills nor text does not exist
// in the model: in the proto it is the REMOVAL (goes back to inheriting from the master), and
// applyOp/core remove it instead of keeping it.
export interface InstanceOverrideLite {
  masterNodeId: string;
  fills?: FillLite[];
  text?: string;
  // DERIVED only, never stored or on the wire: set by instances.ts::instanceOverrideMap when a
  // boolean component property hides this master node for the instance.
  hidden?: boolean;
}

// M4 — an instance of a component: the componentId it renders, plus the per-node
// overrides of the master. Children are NOT here (nor in `nodes`): they are derived from the
// master on every read (renderer, hit-test, bounds).
export interface InstanceLite {
  componentId: string;
  overrides: InstanceOverrideLite[];
  // Values of the component's properties by property NAME, and the variant choice by axis
  // name; absent when empty. See internal/core/components.go.
  propertyValues?: Record<string, string>;
  variantProps?: Record<string, string>;
}

// M4 — a component indexed in SceneState.components (componentId ->
// master): the master's root, which is a LIVE node in `nodes`, plus a name. It does not
// copy the subtree -- it references it, so master->instances propagation
// is free.
export interface ComponentLite {
  rootNodeId: string;
  name: string;
  // Variants: the set this component belongs to and its option on every axis; absent when standalone.
  setId?: string;
  variant?: Record<string, string>;
  // Properties an instance can set; absent when none.
  properties?: ComponentPropertyLite[];
}
export interface ComponentPropertyLite {
  name: string;
  type: "boolean" | "text";
  defaultValue: string;
  targetNodeIds: string[];
}
export interface VariantAxisLite { name: string; options: string[] }
export interface ComponentSetLite { id: string; name: string; axes: VariantAxisLite[] }

export interface NodeLite {
  id: string; parentId: string; orderKey: string; name: string;
  visible: boolean; opacity: number;
  x: number; y: number; width: number; height: number; rotation: number;
  // "unknown" = the `shape` oneof carries a PRESENT shape that this model does not
  // know. It is NOT the same as an ABSENT shape, which stays "rect": Go
  // accepts a Node without shape as an implicit rectangle and it must be accepted
  // here too. It exists because the "everything else is rect" fallback made the two
  // sides diverge in the way core.applySetProps's whitelist exists to prevent: a
  // setProps{corner_radius} on a GroupNode would have been ACCEPTED here (kind
  // fell back to "rect", cornerRadius written) and rejected by core.Apply with
  // ErrNotRectNode. A default that GIVES AWAY a shape is the same mistake as
  // a blacklist, only from the other side of the wire.
  //
  // "group" is a CONTAINER, not a shape: it is not drawn and not hit,
  // and its bounds are the union of the children (see store/groups.ts). It sits in the
  // same field as the shapes because in the proto it is the same `shape` oneof: what
  // a node IS, not a separate flag that could contradict it.
  // "frame" is the complement of the group: a container WITH its own geometry
  // (the box is its own, not the union of the children), drawn and hit like a shape.
  // It is the artboard, and `clipsContent` says whether it clips the children to its own box.
  fills: FillLite[]; strokes: StrokeLite[];
  // Absent when the node has no effects (not `[]`): this way a node without
  // effects is identical, field by field, to how it was before they existed.
  effects?: EffectLite[];
  // "instance" is an INSTANCE of a component (proto: InstanceNode = 37): it sits in the
  // `shape` oneof like the shapes, but its subtree is VIRTUAL -- derived from the
  // master on every read, never in `nodes`. The payload is in `instance`.
  kind: "rect" | "ellipse" | "text" | "image" | "vector" | "unknown" | "group" | "frame" | "instance"; cornerRadius: number;
  // Meaningful if and only if kind === "frame" (for all others it is false,
  // like the proto3 default): the clipping applies to drawing, hit-test
  // and rubber band together -- what is not seen is not clicked.
  clipsContent: boolean;
  // Present if and only if kind === "frame" AND the frame lays out the children. Absent
  // (not an "off" value) when there is no auto layout.
  autoLayout?: AutoLayoutLite;
  // Present if and only if kind === "text": the content lives INSIDE the `shape`
  // oneof of the proto, so it is by construction exclusive with rect/ellipse.
  text?: TextLite;
  // Present if and only if kind === "image", and exclusive with `text` for the
  // same reason (they are two branches of the same oneof).
  image?: ImageLite;
  // Present if and only if kind === "vector", for the same reason: the
  // geometry is a branch of the `shape` oneof, so exclusive with the other shapes.
  vector?: VectorLite;
  // Present if and only if kind === "instance", and exclusive with the other shapes
  // for the same reason (it is a branch of the `shape` oneof). It carries the rendered
  // componentId and the per-node overrides of the master.
  instance?: InstanceLite;
  // Present if and only if kind === "unknown": the oneof branch exactly as it
  // arrived, OPAQUE. It is never read -- it only serves toPbNode to put it back
  // where it was. Without it, the inverse of a delete (history.invertOp rebuilds the
  // Node from NodeLite) would bring back to life a GroupNode turned into a
  // rectangle: a silent shape change inside a Ctrl+Z.
  unknownShape?: PbNode["shape"];
  // Free-form metadata (see Node.meta in the proto). Absent when empty.
  meta?: Record<string, string>;
  // Variable bindings (property -> variableId) and mode overrides (collectionId
  // -> modeId); see Node.bindings / Node.modes in the proto. Absent when empty.
  bindings?: Record<string, string>;
  modes?: Record<string, string>;
  // Shared text style id (text nodes only); absent when none. See TextStyleDefLite.
  textStyleId?: string;
  // Constraints and layout sizing (see ConstraintLite); absent = the default (unspecified / fixed).
  constraintX?: ConstraintLite;
  constraintY?: ConstraintLite;
  layoutSizingX?: "fill";
  layoutSizingY?: "fill";
  // Blend mode against what is behind; absent = normal.
  blendMode?: BlendModeLite;
  // A mask is not drawn: its outline clips the siblings above it. Absent = not a mask.
  isMask?: true;
  // Layout grids (frames only); absent when none.
  layoutGrids?: LayoutGridLite[];
  // TRANSIENT animation FIELDS: written ONLY by animation/pose.ts when it
  // derives the scene to show while a clip runs or is scrubbed. They are not
  // document: toPbNode does not read them, no op carries them, and a snapshot never
  // contains them. `animScale` is a multiplier (base 1) around `animPivot`
  // (parent space; absent = center of the box); `animDraw` is the 0..1 fraction
  // of stroke drawn (`pathLength` semantics).
  animScale?: number;
  animPivot?: { x: number; y: number };
  animDraw?: number;
}

// What the renderer needs to know about a scene DERIVED from playback: which
// nodes have an animated scale (their extent in the scene index does not know
// about it, so no off-screen culling for them and their subtree), their
// ancestors (the ancestor's extent is the union of the children) and whether there is a `draw`
// (the GPU renderer does not draw it: it falls back to the CPU). Absent in real scenes.
export interface AnimInfo {
  scaled: ReadonlySet<string>;
  ancestors: ReadonlySet<string>;
  hasDraw: boolean;
}

// FLOWS: the user's paths between screens (document nodes,
// referenced by id). See proto Flow/Transition and internal/core/flows.go.
export interface FlowLite { id: string; name: string; description: string; startId: string }
export interface TransitionLite {
  id: string; flowId: string; fromId: string; toId: string;
  label: string; trigger: string; elementId: string; guard: string; effect: string;
  // Animation to the destination (see Transition.animation); absent = a cut.
  animation?: string; durationMs?: number; easing?: string; delayMs?: number;
}

/** The closed set of Transition.animation values (parity with core.TransitionAnimations). */
export const TRANSITION_ANIMATIONS = [
  "dissolve", "slide-left", "slide-right", "slide-up", "slide-down",
  "push-left", "push-right", "push-up", "push-down", "smart",
] as const;

// VARIABLES (design tokens): see proto VariableCollection / Variable and
// internal/core/variables.go. A value is a color (FillLite, solid) or a number.
// A comment pinned on the canvas (see Comment in the proto and internal/core/comments.go).
export interface CommentLite {
  id: string; parentId: string; nodeId: string; pageId: string; x: number; y: number;
  author: string; text: string; createdAt: number; resolved: boolean;
}
export interface ModeLite { id: string; name: string }
export interface CollectionLite { id: string; name: string; modes: ModeLite[] }
export type VariableTypeLite = "color" | "number";
export interface VariableLite {
  id: string; collectionId: string; name: string; type: VariableTypeLite;
  // modeId -> value. A color is {r,g,b,a}; a number is a plain number.
  values: Record<string, FillLite | number>;
}

// TYPOGRAPHY: uploaded font faces and shared text styles. See proto FontFace /
// TextStyleDef and internal/core/typography.go.
export interface FontLite { id: string; family: string; weight: string; style: "normal" | "italic"; assetHash: string }
export interface TextStyleDefLite { id: string; name: string; style: TextStyleLite }

// ANIMATION: the document's clips (animated properties of nodes referenced by
// id). See proto Clip/Track/Keyframe and internal/core/animation.go.
export interface KeyframeLite { time: number; value: number; easing: string }
export interface TrackLite { nodeId: string; prop: string; keyframes: KeyframeLite[] }
export interface ClipLite {
  id: string; name: string; duration: number; trigger: string; delay: number;
  repeat: number; yoyo: boolean; tracks: TrackLite[]; targetId: string;
}

export interface SceneState {
  id: string; name: string; schemaVersion: number;
  pages: PageLite[]; nodes: NodeMap;
  flows: Record<string, FlowLite>;
  transitions: Record<string, TransitionLite>;
  clips: Record<string, ClipLite>;
  // Variables, like clips: absent keys mean none (an empty record, never undefined).
  collections: Record<string, CollectionLite>;
  variables: Record<string, VariableLite>;
  // Typography, like variables: an empty record when there are none.
  fonts: Record<string, FontLite>;
  textStyles: Record<string, TextStyleDefLite>;
  // Comments, like clips: an empty record when there are none.
  comments: Record<string, CommentLite>;
  // Only in scenes derived from playback (animation/pose.ts): see AnimInfo.
  anim?: AnimInfo;
  // M4 — components indexed by id (componentId -> master). It is part of the
  // document as much as `nodes` and `pages`: a CreateComponent populates it, and
  // fromDocument rebuilds it from the snapshot.
  components: Record<string, ComponentLite>;
  // Component sets (variants), like components: an empty record when there are none.
  componentSets: Record<string, ComponentSetLite>;
}

export function emptyScene(id: string, name: string): SceneState {
  return { id, name, schemaVersion: 1, pages: [{ id: "page1", name: "Page 1" }], nodes: NodeMap.empty, flows: {}, transitions: {}, clips: {}, collections: {}, variables: {}, fonts: {}, textStyles: {}, comments: {}, components: {}, componentSets: {} };
}

const ALIGN_TO_LITE: Record<TextAlign, TextAlignLite> = {
  [TextAlign.UNSPECIFIED]: "left",
  [TextAlign.LEFT]: "left",
  [TextAlign.CENTER]: "center",
  [TextAlign.RIGHT]: "right",
};
const ALIGN_TO_PB: Record<TextAlignLite, TextAlign> = {
  left: TextAlign.LEFT,
  center: TextAlign.CENTER,
  right: TextAlign.RIGHT,
};

const STROKE_ALIGN_TO_LITE: Record<StrokeAlign, StrokeAlignLite> = {
  [StrokeAlign.UNSPECIFIED]: "center",
  [StrokeAlign.CENTER]: "center",
  [StrokeAlign.INSIDE]: "inside",
  [StrokeAlign.OUTSIDE]: "outside",
};
const STROKE_ALIGN_TO_PB: Record<StrokeAlignLite, StrokeAlign> = {
  center: StrokeAlign.CENTER,
  inside: StrokeAlign.INSIDE,
  outside: StrokeAlign.OUTSIDE,
};

// An ABSENT style is not an error: in Go `t.Text.GetStyle()` is nil-safe and
// returns the zeros of every field (and it is exactly what remains after a
// SetText with style_present=true and no style). Here the counterpart is an
// all-zero style, so the two implementations remain indistinguishable.
export function toTextStyleLite(s: PbTextStyle | undefined): TextStyleLite {
  return {
    fontFamily: s?.fontFamily ?? "",
    fontSize: s?.fontSize ?? 0,
    fontWeight: s?.fontWeight ?? "",
    lineHeight: s?.lineHeight ?? 0,
    align: ALIGN_TO_LITE[s?.align ?? TextAlign.UNSPECIFIED] ?? "left",
    ...(s?.italic ? { italic: true } : {}),
  };
}

export function toTextLite(t: PbTextNode): TextLite {
  return { content: t.content, style: toTextStyleLite(t.style) };
}

// The wire's subpaths in the model's shape. Field by field and not a spread:
// a `{...a}` would also copy `$typeName` (protobuf-es puts it on every
// message) into the model, and from there into test comparisons and write-backs.
// The explicit list is also the guard: a field added to Anchor
// in the .proto does not show up here on its own, and the round-trip discovers it.
export function toSubPathsLite(subpaths: readonly PbSubPath[]): SubPathLite[] {
  return subpaths.map((sp) => ({
    anchors: sp.anchors.map((a) => ({
      x: a.x, y: a.y, inX: a.inX, inY: a.inY, outX: a.outX, outY: a.outY,
    })),
    closed: sp.closed,
  }));
}

export function toVectorLite(v: PbVectorNode): VectorLite {
  return { subpaths: toSubPathsLite(v.subpaths) };
}

// M4 — a FLATTENED wire override. PRESENCE follows the proto's *_present flags,
// not the values: `fills` appears only if fills_present, `text` only if
// text_present. This way the absence of the field in the model IS the proto's "not overridden"
// (see InstanceOverrideLite), and a text-only override does not carry
// an empty fill along (nor vice versa). Exact inverse of toPbInstanceOverride.
export function toInstanceOverrideLite(o: PbInstanceOverride): InstanceOverrideLite {
  return {
    masterNodeId: o.masterNodeId,
    ...(o.fillsPresent ? { fills: o.fills.map(toFillLite) } : {}),
    ...(o.textPresent ? { text: o.text } : {}),
  };
}

export function toInstanceLite(n: PbInstanceNode): InstanceLite {
  return {
    componentId: n.componentId,
    overrides: n.overrides.map(toInstanceOverrideLite),
    ...(Object.keys(n.propertyValues).length > 0 ? { propertyValues: { ...n.propertyValues } } : {}),
    ...(Object.keys(n.variantProps).length > 0 ? { variantProps: { ...n.variantProps } } : {}),
  };
}

export function toComponentPropertyLite(p: PbComponentProperty): ComponentPropertyLite {
  return {
    name: p.name,
    type: p.type === ComponentPropertyType.BOOLEAN ? "boolean" : "text",
    defaultValue: p.defaultValue,
    targetNodeIds: [...p.targetNodeIds],
  };
}
export function toPbComponentProperty(p: ComponentPropertyLite): PbComponentProperty {
  return create(ComponentPropertySchema, {
    name: p.name,
    type: p.type === "boolean" ? ComponentPropertyType.BOOLEAN : ComponentPropertyType.TEXT,
    defaultValue: p.defaultValue,
    targetNodeIds: [...p.targetNodeIds],
  });
}
export function toComponentLite(c: PbComponent): ComponentLite {
  return {
    rootNodeId: c.rootNodeId,
    name: c.name,
    ...(c.setId !== "" ? { setId: c.setId } : {}),
    ...(Object.keys(c.variant).length > 0 ? { variant: { ...c.variant } } : {}),
    ...(c.properties.length > 0 ? { properties: c.properties.map(toComponentPropertyLite) } : {}),
  };
}
export function toComponentSetLite(s: PbComponentSet): ComponentSetLite {
  return { id: s.id, name: s.name, axes: s.axes.map((a) => ({ name: a.name, options: [...a.options] })) };
}
export function toPbComponentSet(s: ComponentSetLite): PbComponentSet {
  return create(ComponentSetSchema, { id: s.id, name: s.name, axes: s.axes.map((a) => ({ name: a.name, options: [...a.options] })) });
}

// Inverse of toSubPathsLite. Like toPbTextStyle it returns the INIT shape (not created
// messages): callers nest it inside the `create(...)` of a Node
// (toPbNode) or an Op (history.invertOp, and the pen tool when it arrives).
export function toPbSubPaths(subpaths: readonly SubPathLite[]) {
  return subpaths.map((sp) => ({
    anchors: sp.anchors.map((a) => ({
      x: a.x, y: a.y, inX: a.inX, inY: a.inY, outX: a.outX, outY: a.outY,
    })),
    closed: sp.closed,
  }));
}

// Inverse of toTextStyleLite. Returns the init shape (not a created
// message): callers nest it inside `create(...)` of a Node or an Op.
export function toPbTextStyle(s: TextStyleLite) {
  return {
    fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
    lineHeight: s.lineHeight, align: ALIGN_TO_PB[s.align] ?? TextAlign.LEFT,
    italic: s.italic === true,
  };
}

// The model's tints in the init shape of opendesigner.v1.Node.fills.
//
// NodeLite only knows FLAT tints (toNodeLite flattens any non-solid
// paint into a color), so the return is always a list of SolidPaint.
// Extracted from toPbNode because the properties panel (ui/PropertiesPanel.tsx)
// builds the SAME patch for its fill op: two independent mappings
// of the same field would diverge at the first non-solid paint.
export function toPbFills(fills: readonly FillLite[]) {
  return fills.map(toPbPaint);
}

// The model's STROKES in the init shape of opendesigner.v1.Node.strokes. Twin of
// toPbFills, and exported for the same reason: the properties panel
// (ui/PropertiesPanel.tsx) builds the SAME patch for its stroke op.
export function toPbStrokes(strokes: readonly StrokeLite[]) {
  return strokes.map((s) => ({
    paint: toPbPaint(s.color),
    weight: s.weight,
    align: STROKE_ALIGN_TO_PB[s.align] ?? StrokeAlign.CENTER,
  }));
}

// The model's EFFECTS in the init shape of opendesigner.v1.Node.effects.
// Twin of toPbFills/toPbStrokes: the panel builds the SAME patch.
export function toPbEffects(effects: readonly EffectLite[]) {
  return effects.map((e) => {
    switch (e.kind) {
      case "dropShadow":
        return { kind: { case: "dropShadow" as const, value: { color: { ...e.color }, offsetX: e.offsetX, offsetY: e.offsetY, blur: e.blur } } };
      case "innerShadow":
        return { kind: { case: "innerShadow" as const, value: { color: { ...e.color }, offsetX: e.offsetX, offsetY: e.offsetY, blur: e.blur } } };
      case "backgroundBlur":
        return { kind: { case: "backgroundBlur" as const, value: { radius: e.radius } } };
      default:
        return { kind: { case: "layerBlur" as const, value: { radius: e.radius } } };
    }
  });
}

const LAYOUT_ALIGN_TO_LITE: Partial<Record<LayoutAlign, LayoutAlignLite>> = {
  [LayoutAlign.START]: "start", [LayoutAlign.CENTER]: "center", [LayoutAlign.END]: "end",
  [LayoutAlign.SPACE_BETWEEN]: "space-between",
};
const LAYOUT_ALIGN_TO_PB: Record<LayoutAlignLite, LayoutAlign> = {
  start: LayoutAlign.START, center: LayoutAlign.CENTER, end: LayoutAlign.END,
  "space-between": LayoutAlign.SPACE_BETWEEN,
};

export function toAutoLayoutLite(a: PbAutoLayout): AutoLayoutLite {
  return {
    direction: a.direction === LayoutDirection.VERTICAL ? "vertical" : "horizontal",
    spacing: a.spacing,
    paddingLeft: a.paddingLeft, paddingTop: a.paddingTop, paddingRight: a.paddingRight, paddingBottom: a.paddingBottom,
    mainAlign: LAYOUT_ALIGN_TO_LITE[a.mainAlign] ?? "start",
    crossAlign: LAYOUT_ALIGN_TO_LITE[a.crossAlign] ?? "start",
    hugWidth: a.hugWidth, hugHeight: a.hugHeight,
    ...(a.wrap ? { wrap: true as const } : {}),
    ...(a.crossSpacing ? { crossSpacing: a.crossSpacing } : {}),
  };
}

export function toPbAutoLayout(a: AutoLayoutLite) {
  return {
    direction: a.direction === "vertical" ? LayoutDirection.VERTICAL : LayoutDirection.HORIZONTAL,
    spacing: a.spacing,
    paddingLeft: a.paddingLeft, paddingTop: a.paddingTop, paddingRight: a.paddingRight, paddingBottom: a.paddingBottom,
    mainAlign: LAYOUT_ALIGN_TO_PB[a.mainAlign], crossAlign: LAYOUT_ALIGN_TO_PB[a.crossAlign],
    hugWidth: a.hugWidth, hugHeight: a.hugHeight,
    wrap: a.wrap === true, crossSpacing: a.crossSpacing ?? 0,
  };
}

export function toEffectLite(e: PbEffect): EffectLite {
  const k = e.kind;
  if (k.case === "dropShadow" || k.case === "innerShadow") {
    const c = k.value.color;
    return {
      kind: k.case,
      color: { r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 1 },
      offsetX: k.value.offsetX, offsetY: k.value.offsetY, blur: k.value.blur,
    };
  }
  if (k.case === "backgroundBlur") return { kind: "backgroundBlur", radius: k.value.radius };
  // An effect without `kind` (wire from a future version) reads as a
  // null blur: harmless to draw and keeps the position in the list.
  return { kind: "layerBlur", radius: k.case === "layerBlur" ? k.value.radius : 0 };
}

function toPbPaint(c: FillLite) {
  if (c.mesh) {
    return { kind: { case: "mesh" as const, value: { rows: c.mesh.rows, cols: c.mesh.cols, colors: c.mesh.colors.map((k) => ({ ...k })) } } };
  }
  if (c.image) {
    const mode = c.image.mode === "fit" ? ImageScaleMode.FIT : c.image.mode === "tile" ? ImageScaleMode.TILE : ImageScaleMode.UNSPECIFIED;
    return { kind: { case: "image" as const, value: { assetHash: c.image.assetHash, mode } } };
  }
  const g = c.gradient;
  if (g) {
    const value = {
      stops: g.stops.map((st) => ({ color: { ...st.color }, position: st.position })),
      x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
    };
    return g.kind === "linear"
      ? { kind: { case: "linear" as const, value } }
      : { kind: { case: "radial" as const, value } };
  }
  return { kind: { case: "solid" as const, value: { color: { r: c.r, g: c.g, b: c.b, a: c.a } } } };
}

// Inverse of toInstanceOverrideLite. Returns the INIT shape (not a created
// message): callers nest it inside `create(...)` of a Node (toPbNode) or
// of an Op (history.invertOp and applyOp do not need it, but the component
// pen does). The *_present flags are derived from the PRESENCE of the Lite field --
// `fills` defined => fills_present, `text` defined => text_present -- so the
// round-trip with toInstanceOverrideLite is LOSSLESS: a fill-only override
// does not gain an empty text passing through here, nor lose the distinction between
// "absent fill" and "emptied fill".
export function toPbInstanceOverride(o: InstanceOverrideLite) {
  return {
    masterNodeId: o.masterNodeId,
    fills: o.fills ? toPbFills(o.fills) : [],
    fillsPresent: o.fills !== undefined,
    text: o.text ?? "",
    textPresent: o.text !== undefined,
  };
}

// A FLATTENED wire Paint into the color the renderer draws. A single function
// for fills and strokes: they are the same message in the proto, and two independent
// flattenings would diverge at the first non-solid paint (today
// the only case is an ABSENT paint, but the `kind` oneof exists to grow).
function toFillLite(p: PbPaint | undefined): FillLite {
  const k = p?.kind;
  if (k?.case === "linear" || k?.case === "radial") {
    const g = k.value;
    const stops = g.stops.map((st) => ({
      color: { r: st.color?.r ?? 0, g: st.color?.g ?? 0, b: st.color?.b ?? 0, a: st.color?.a ?? 1 },
      position: st.position,
    }));
    const first = stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 };
    return {
      ...first,
      gradient: { kind: k.case, stops, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 },
    };
  }
  if (k?.case === "mesh") {
    const colors = k.value.colors.map((c) => ({ r: c.r, g: c.g, b: c.b, a: c.a }));
    const n = Math.max(1, colors.length);
    const avg = colors.reduce((s, c) => ({ r: s.r + c.r / n, g: s.g + c.g / n, b: s.b + c.b / n, a: s.a + c.a / n }), { r: 0, g: 0, b: 0, a: 0 });
    return { ...avg, mesh: { rows: k.value.rows, cols: k.value.cols, colors } };
  }
  if (k?.case === "image") {
    const mode = k.value.mode === ImageScaleMode.FIT ? "fit" : k.value.mode === ImageScaleMode.TILE ? "tile" : "fill";
    return { r: 0.8, g: 0.8, b: 0.8, a: 1, image: { assetHash: k.value.assetHash, mode } };
  }
  const c = k?.case === "solid" ? k.value.color : undefined;
  return c ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: 0, g: 0, b: 0, a: 1 };
}

export function toStrokeLite(s: PbStroke): StrokeLite {
  return {
    color: toFillLite(s.paint),
    weight: s.weight,
    align: STROKE_ALIGN_TO_LITE[s.align] ?? "center",
  };
}

// The node's shape in the model's vocabulary. The default is to REJECT, not to
// fall back to "rect": the same reason applies here as for why core.applySetProps (Go)
// lists the shapes it ACCEPTS instead of those it rejects. Other tracks
// are adding shapes to the oneof right now (33 Group, 34 Frame, 37 Instance), and
// with a fallback to "rect" each of those, as soon as merged, would make this
// side accept a setProps{corner_radius} that Go rejects -- the
// client/authoritative document divergence, simply mirrored.
//
// ABSENT shape => "rect", and it is not an exception to the rule but the rule itself:
// Go treats a Node without shape as an implicit rectangle (whitelist `nil` or
// `*opendesignerv1.Node_Rect`), so treating it differently here would be the
// divergence.
function kindOf(shape: PbNode["shape"]): NodeLite["kind"] {
  switch (shape.case) {
    case undefined: return "rect";
    case "rect": return "rect";
    case "ellipse": return "ellipse";
    case "text": return "text";
    case "image": return "image";
    case "vector": return "vector";
    case "group": return "group";
    case "frame": return "frame";
    case "instance": return "instance";
    default: return "unknown";
  }
}

const CONSTRAINT_TO_LITE: Partial<Record<Constraint, ConstraintLite>> = {
  [Constraint.MIN]: "min", [Constraint.MAX]: "max", [Constraint.STRETCH]: "stretch",
  [Constraint.CENTER]: "center", [Constraint.SCALE]: "scale",
};
const CONSTRAINT_TO_PB: Record<ConstraintLite, Constraint> = {
  min: Constraint.MIN, max: Constraint.MAX, stretch: Constraint.STRETCH, center: Constraint.CENTER, scale: Constraint.SCALE,
};

const GRID_KIND_TO_LITE: Partial<Record<LayoutGridKind, LayoutGridLite["kind"]>> = {
  [LayoutGridKind.GRID]: "grid", [LayoutGridKind.COLUMNS]: "columns", [LayoutGridKind.ROWS]: "rows",
};
const GRID_KIND_TO_PB: Record<LayoutGridLite["kind"], LayoutGridKind> = {
  grid: LayoutGridKind.GRID, columns: LayoutGridKind.COLUMNS, rows: LayoutGridKind.ROWS,
};
export function toLayoutGridLite(g: PbLayoutGrid): LayoutGridLite {
  const c = g.color;
  return {
    kind: GRID_KIND_TO_LITE[g.kind] ?? "grid",
    size: g.size, count: g.count, gutter: g.gutter, margin: g.margin,
    color: { r: c?.r ?? 1, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 0.1 },
  };
}
export function toPbLayoutGrids(grids: readonly LayoutGridLite[]) {
  return grids.map((g) => ({
    kind: GRID_KIND_TO_PB[g.kind], size: g.size, count: g.count, gutter: g.gutter, margin: g.margin, color: { ...g.color },
  }));
}

export const BLEND_MODES: readonly BlendModeLite[] = [
  "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];
// The wire enum is BLEND_MODE_UNSPECIFIED = 0 followed by BLEND_MODES in order.
const blendToLite = (b: BlendMode): BlendModeLite | undefined => (b > 0 ? BLEND_MODES[b - 1] : undefined);
export const toPbBlend = (b: BlendModeLite | undefined): BlendMode => (b ? BLEND_MODES.indexOf(b) + 1 : BlendMode.UNSPECIFIED);

export function toNodeLite(n: PbNode): NodeLite {
  const kind = kindOf(n.shape);
  return {
    id: n.id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
    visible: n.visible, opacity: n.opacity,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation,
    fills: n.fills.map(toFillLite),
    strokes: n.strokes.map(toStrokeLite),
    ...(n.effects.length > 0 ? { effects: n.effects.map(toEffectLite) } : {}),
    kind,
    cornerRadius: n.shape.case === "rect" ? n.shape.value.cornerRadius : 0,
    clipsContent: n.shape.case === "frame" ? n.shape.value.clipsContent : false,
    ...(n.shape.case === "frame" && n.shape.value.autoLayout ? { autoLayout: toAutoLayoutLite(n.shape.value.autoLayout) } : {}),
    ...(n.shape.case === "text" ? { text: toTextLite(n.shape.value) } : {}),
    ...(n.shape.case === "image" ? { image: { assetHash: n.shape.value.assetHash } } : {}),
    ...(n.shape.case === "vector" ? { vector: toVectorLite(n.shape.value) } : {}),
    ...(n.shape.case === "instance" ? { instance: toInstanceLite(n.shape.value) } : {}),
    // The unknown branch travels whole and intact: see NodeLite.unknownShape.
    ...(kind === "unknown" ? { unknownShape: n.shape } : {}),
    ...(Object.keys(n.meta).length > 0 ? { meta: { ...n.meta } } : {}),
    ...(Object.keys(n.bindings).length > 0 ? { bindings: { ...n.bindings } } : {}),
    ...(Object.keys(n.modes).length > 0 ? { modes: { ...n.modes } } : {}),
    ...(n.textStyleId !== "" ? { textStyleId: n.textStyleId } : {}),
    ...(n.constraintX !== Constraint.UNSPECIFIED ? { constraintX: CONSTRAINT_TO_LITE[n.constraintX] } : {}),
    ...(n.constraintY !== Constraint.UNSPECIFIED ? { constraintY: CONSTRAINT_TO_LITE[n.constraintY] } : {}),
    ...(n.layoutSizingX === LayoutSizing.FILL ? { layoutSizingX: "fill" as const } : {}),
    ...(n.layoutSizingY === LayoutSizing.FILL ? { layoutSizingY: "fill" as const } : {}),
    ...(blendToLite(n.blendMode) ? { blendMode: blendToLite(n.blendMode) } : {}),
    ...(n.isMask ? { isMask: true as const } : {}),
    ...(n.layoutGrids.length > 0 ? { layoutGrids: n.layoutGrids.map(toLayoutGridLite) } : {}),
  };
}

// Exact inverse of toNodeLite: rebuilds the protobuf Node from a NodeLite.
// It sits here, next to toNodeLite, on purpose: a field added to NodeLite
// must appear in BOTH directions, and adjacency is the guard.
// It serves undo (history.invertOp): the inverse of a delete is the create of the
// node as it was, and the in-memory model keeps only NodeLite.
export function toPbNode(n: NodeLite): PbNode {
  const node = create(NodeSchema, {
    id: n.id, parentId: n.parentId, orderKey: n.orderKey, name: n.name,
    visible: n.visible, opacity: n.opacity,
    x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation,
    fills: toPbFills(n.fills),
    strokes: toPbStrokes(n.strokes),
    effects: toPbEffects(n.effects ?? []),
    meta: n.meta ? { ...n.meta } : {},
    bindings: n.bindings ? { ...n.bindings } : {},
    modes: n.modes ? { ...n.modes } : {},
    textStyleId: n.textStyleId ?? "",
    constraintX: n.constraintX ? CONSTRAINT_TO_PB[n.constraintX] : Constraint.UNSPECIFIED,
    constraintY: n.constraintY ? CONSTRAINT_TO_PB[n.constraintY] : Constraint.UNSPECIFIED,
    layoutSizingX: n.layoutSizingX === "fill" ? LayoutSizing.FILL : LayoutSizing.FIXED,
    layoutSizingY: n.layoutSizingY === "fill" ? LayoutSizing.FILL : LayoutSizing.FIXED,
    blendMode: toPbBlend(n.blendMode),
    isMask: n.isMask === true,
    layoutGrids: n.layoutGrids ? toPbLayoutGrids(n.layoutGrids) : [],
    shape: n.kind === "unknown"
      // The unknown shape cannot be BUILT (there is no oneof branch to
      // name), so it is put back where it was right after the create. Leaving it
      // here as `undefined` for an instant is the only way NOT to write a
      // rectangle over it: it was exactly the bug -- a GroupNode that came back as a
      // rectangle going through an undo.
      ? undefined
      : n.kind === "ellipse"
      ? { case: "ellipse" as const, value: {} }
      : n.kind === "image"
        // The hash and nothing else: it is all an ImageNode contains, and rebuilding it
        // here is what makes an image survive the undo of a delete and
        // a paste (both go through toPbNode). A missing `image` falls back to
        // an empty hash -- that is, to an image whose asset is not found, which the
        // renderer draws as a placeholder -- and never to a rectangle: a silent
        // shape change inside an undo would be much worse.
        ? { case: "image" as const, value: { assetHash: n.image?.assetHash ?? "" } }
      : n.kind === "vector"
        // As for text: a missing `vector` on a vector node is a
        // state toNodeLite never produces (the two move together), and the
        // fallback to the empty list only serves not to rebuild a RECTANGLE
        // from a path -- which inside an undo would be a silent
        // shape change. An emptied path stays a path.
        ? { case: "vector" as const, value: { subpaths: toPbSubPaths(n.vector?.subpaths ?? []) } }
      : n.kind === "instance"
        // An instance: the rendered componentId plus the per-node overrides of the master,
        // rebuilt with the *_present flags from the presence of the Lite field (see
        // toPbInstanceOverride). As for the other branches, a missing `instance`
        // falls back to an empty componentId and no overrides -- NEVER to a rectangle:
        // a silent shape change inside an undo of a delete would be
        // much worse than an instance that points to nothing.
        ? { case: "instance" as const, value: {
            componentId: n.instance?.componentId ?? "",
            overrides: (n.instance?.overrides ?? []).map(toPbInstanceOverride),
            propertyValues: { ...(n.instance?.propertyValues ?? {}) },
            variantProps: { ...(n.instance?.variantProps ?? {}) },
          } }
      // A group has no fields of its own: what makes it a group is the oneof case
      // (plus the children pointing to it). The branch exists anyway, and it is not
      // pedantry: without it, the inverse of a delete would rebuild a
      // RECTANGLE in place of the group -- a silent shape change inside
      // an undo, and with a 0x0 box that would never be seen.
      : n.kind === "group"
      ? { case: "group" as const, value: {} }
      // Same reason as the `group` branch, plus one field: without it, the inverse of a
      // delete would rebuild a RECTANGLE in place of the frame, and a frame
      // rebuilt without `clipsContent` would stop clipping the children --
      // an undo that changes what is seen.
      : n.kind === "frame"
      ? { case: "frame" as const, value: { clipsContent: n.clipsContent, ...(n.autoLayout ? { autoLayout: toPbAutoLayout(n.autoLayout) } : {}) } }
      : n.kind === "text"
        // A missing `text` on a text node is a state toNodeLite never
        // produces (the two move together). The fallback to empty text
        // still avoids rebuilding a RECTANGLE from a text node --
        // it would be a silent shape change in an undo.
        ? { case: "text" as const, value: {
            content: n.text?.content ?? "",
            style: toPbTextStyle(n.text?.style ?? toTextStyleLite(undefined)),
          } }
        : { case: "rect" as const, value: { cornerRadius: n.cornerRadius } },
  });
  if (n.kind === "unknown" && n.unknownShape) node.shape = n.unknownShape;
  return node;
}

export function toFlowLite(f: PbFlow): FlowLite {
  return { id: f.id, name: f.name, description: f.description, startId: f.startId };
}
export function toTransitionLite(t: PbTransition): TransitionLite {
  return {
    id: t.id, flowId: t.flowId, fromId: t.fromId, toId: t.toId, label: t.label,
    trigger: t.trigger, elementId: t.elementId, guard: t.guard, effect: t.effect,
    ...(t.animation !== "" ? { animation: t.animation } : {}),
    ...(t.durationMs !== 0 ? { durationMs: t.durationMs } : {}),
    ...(t.easing !== "" ? { easing: t.easing } : {}),
    ...(t.delayMs !== 0 ? { delayMs: t.delayMs } : {}),
  };
}
export function toPbFlow(f: FlowLite): PbFlow {
  return create(FlowSchema, { id: f.id, name: f.name, description: f.description, startId: f.startId });
}
export function toPbTransition(t: TransitionLite): PbTransition {
  return create(TransitionSchema, {
    id: t.id, flowId: t.flowId, fromId: t.fromId, toId: t.toId, label: t.label,
    trigger: t.trigger, elementId: t.elementId, guard: t.guard, effect: t.effect,
    animation: t.animation ?? "", durationMs: t.durationMs ?? 0, easing: t.easing ?? "", delayMs: t.delayMs ?? 0,
  });
}

export function toCommentLite(c: PbComment): CommentLite {
  return {
    id: c.id, parentId: c.parentId, nodeId: c.nodeId, pageId: c.pageId, x: c.x, y: c.y,
    author: c.author, text: c.text, createdAt: Number(c.createdAt), resolved: c.resolved,
  };
}
export function toPbComment(c: CommentLite): PbComment {
  return create(CommentSchema, {
    id: c.id, parentId: c.parentId, nodeId: c.nodeId, pageId: c.pageId, x: c.x, y: c.y,
    author: c.author, text: c.text, createdAt: BigInt(Math.trunc(c.createdAt)), resolved: c.resolved,
  });
}

export function toCollectionLite(c: PbCollection): CollectionLite {
  return { id: c.id, name: c.name, modes: c.modes.map((m) => ({ id: m.id, name: m.name })) };
}
export function toPbCollection(c: CollectionLite): PbCollection {
  return create(VariableCollectionSchema, { id: c.id, name: c.name, modes: c.modes.map((m) => ({ id: m.id, name: m.name })) });
}
export function toVariableLite(v: PbVariable): VariableLite {
  const type: VariableTypeLite = v.type === VariableType.COLOR ? "color" : "number";
  const values: VariableLite["values"] = {};
  for (const [mode, val] of Object.entries(v.values)) {
    if (val.kind.case === "color") {
      const { r, g, b, a } = val.kind.value;
      values[mode] = { r, g, b, a };
    } else if (val.kind.case === "number") values[mode] = val.kind.value;
  }
  return { id: v.id, collectionId: v.collectionId, name: v.name, type, values };
}
export function toPbVariable(v: VariableLite): PbVariable {
  const values: Record<string, { kind: { case: "color"; value: { r: number; g: number; b: number; a: number } } | { case: "number"; value: number } }> = {};
  for (const [mode, val] of Object.entries(v.values)) {
    values[mode] = typeof val === "number"
      ? { kind: { case: "number", value: val } }
      : { kind: { case: "color", value: { r: val.r, g: val.g, b: val.b, a: val.a } } };
  }
  return create(VariableSchema, {
    id: v.id, collectionId: v.collectionId, name: v.name,
    type: v.type === "color" ? VariableType.COLOR : VariableType.NUMBER, values,
  });
}

export function toFontLite(f: PbFont): FontLite {
  return { id: f.id, family: f.family, weight: f.weight, style: f.style === "italic" ? "italic" : "normal", assetHash: f.assetHash };
}
export function toPbFont(f: FontLite): PbFont {
  return create(FontFaceSchema, { id: f.id, family: f.family, weight: f.weight, style: f.style, assetHash: f.assetHash });
}
export function toTextStyleDefLite(d: PbTextStyleDef): TextStyleDefLite {
  return { id: d.id, name: d.name, style: toTextStyleLite(d.style) };
}
export function toPbTextStyleDef(d: TextStyleDefLite): PbTextStyleDef {
  return create(TextStyleDefSchema, { id: d.id, name: d.name, style: toPbTextStyle(d.style) });
}

export function toClipLite(c: PbClip): ClipLite {
  return {
    id: c.id, name: c.name, duration: c.duration, trigger: c.trigger, delay: c.delay, repeat: c.repeat, yoyo: c.yoyo,
    targetId: c.targetId,
    tracks: c.tracks.map((t) => ({
      nodeId: t.nodeId, prop: t.prop,
      keyframes: t.keyframes.map((k) => ({ time: k.time, value: k.value, easing: k.easing })),
    })),
  };
}
export function toPbClip(c: ClipLite): PbClip {
  return create(ClipSchema, {
    id: c.id, name: c.name, duration: c.duration, trigger: c.trigger, delay: c.delay, repeat: c.repeat, yoyo: c.yoyo,
    targetId: c.targetId,
    tracks: c.tracks.map((t) => ({
      nodeId: t.nodeId, prop: t.prop,
      keyframes: t.keyframes.map((k) => ({ time: k.time, value: k.value, easing: k.easing })),
    })),
  });
}

export function fromDocument(doc: Document): SceneState {
  const edit = NodeMap.empty.edit();
  for (const [id, n] of Object.entries(doc.nodes)) edit.set(id, toNodeLite(n));
  const nodes = edit.done();
  // Components are part of the document as much as nodes: a master not copied
  // but referenced by rootNodeId (see ComponentLite).
  const components: Record<string, ComponentLite> = {};
  for (const [id, c] of Object.entries(doc.components)) components[id] = toComponentLite(c);
  return {
    id: doc.id, name: doc.name, schemaVersion: doc.schemaVersion,
    pages: doc.pages.map((p) => ({ id: p.id, name: p.name })), nodes, components,
    componentSets: Object.fromEntries(Object.entries(doc.componentSets).map(([id, c]) => [id, toComponentSetLite(c)])),
    flows: Object.fromEntries(Object.entries(doc.flows).map(([id, f]) => [id, toFlowLite(f)])),
    transitions: Object.fromEntries(Object.entries(doc.transitions).map(([id, t]) => [id, toTransitionLite(t)])),
    clips: Object.fromEntries(Object.entries(doc.clips).map(([id, c]) => [id, toClipLite(c)])),
    collections: Object.fromEntries(Object.entries(doc.collections).map(([id, c]) => [id, toCollectionLite(c)])),
    variables: Object.fromEntries(Object.entries(doc.variables).map(([id, v]) => [id, toVariableLite(v)])),
    fonts: Object.fromEntries(Object.entries(doc.fonts).map(([id, f]) => [id, toFontLite(f)])),
    textStyles: Object.fromEntries(Object.entries(doc.textStyles).map(([id, d]) => [id, toTextStyleDefLite(d)])),
    comments: Object.fromEntries(Object.entries(doc.comments).map(([id, c]) => [id, toCommentLite(c)])),
  };
}
