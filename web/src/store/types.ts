import { NodeMap } from "@/store/nodeMap";
import { create } from "@bufbuild/protobuf";
import { AnnotationSchema, ReadyForDevSchema, BlendMode, ImageScaleMode, TextStyleKind, ArrowHead, PaintStyleDefSchema, EffectStyleDefSchema, LayoutGridKind, CommentSchema, ClipSchema, Constraint, LayoutPositioning, LayoutSizing, ComponentPropertySchema, ComponentPropertyType, ComponentSetSchema, FlowSchema, FontFaceSchema, TextStyleDefSchema, VariableCollectionSchema, VariableSchema, VariableType, TransitionSchema, LayoutAlign, LayoutDirection, NodeSchema, StrokeAlign, TextAlign, TextCase, TextScript, ListKind, TextVAlign, NoiseMode, LayoutMode, GridTrackKind, BrushKind, BrushTip, LayerSchema, ObjectStyleDefSchema, TabAlign, ParagraphRuleSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import type {
  Annotation as PbAnnotation, ReadyForDev as PbReady, Document, Component as PbComponent, ComponentProperty as PbComponentProperty, ComponentSet as PbComponentSet, FontFace as PbFont, TextStyleDef as PbTextStyleDef, PaintStyleDef as PbPaintStyleDef, EffectStyleDef as PbEffectStyleDef, VariableCollection as PbCollection, Variable as PbVariable, Clip as PbClip, Flow as PbFlow, Transition as PbTransition, Node as PbNode, Comment as PbComment, LayoutGrid as PbLayoutGrid, Paint as PbPaint, Stroke as PbStroke, Brush as PbBrush, Effect as PbEffect, AutoLayout as PbAutoLayout, TextNode as PbTextNode, TextStyle as PbTextStyle, ObjectStyleDef as PbObjectStyleDef, Layer as PbLayer, ParagraphRule as PbParagraphRule,
  SubPath as PbSubPath, VectorNode as PbVectorNode,
  InstanceNode as PbInstanceNode, InstanceOverride as PbInstanceOverride,
} from "@/gen/opendesigner/v1/opendesigner_pb";

// `isMaster` / `masterId` are absent (not false / "") on a plain page: see store/masters.ts.
export interface PageLite {
  id: string; name: string; isMaster?: boolean; masterId?: string;
  // PAGE SETUP (store/docSettings.ts), absent at 0: a page with a size is a sheet at the origin.
  width?: number; height?: number;
  marginTop?: number; marginRight?: number; marginBottom?: number; marginLeft?: number;
  columns?: number; gutter?: number; bleed?: number;
  // PAGE STRUCTURE (store/pageNumbers.ts, store/masters.ts), absent at the default.
  sectionStart?: boolean; numberStart?: number; numberStyle?: NumberStyle;
  leftMasterId?: string; hiddenMasterItems?: string[]; slug?: number; guides?: GuideLite[];
}
export type NumberStyle = "i" | "I" | "a" | "A";
/** A ruler guide of a page: a vertical one at x = position, else a horizontal one at y = position. */
export interface GuideLite { vertical: boolean; position: number }

/** The kind of work a document is for: it shapes the editor, never limits the document. Absent = "product". */
export type Vertical = "publishing" | "design" | "product";
/** Document-wide settings, each absent at its default. */
export interface ContributorLite { role: string; personName: string; biography?: string }
export interface SubjectLite { scheme: string; code: string; heading?: string }
export interface PriceLite { priceType: string; amount: string; currency: string }
/** Bibliographic record of the document as a book (docs/onix.md); every field absent at its default. */
export interface BookLite {
  isbn13?: string; title?: string; subtitle?: string; seriesName?: string; seriesNumber?: string; editionNumber?: string;
  contributors?: ContributorLite[]; language?: string; publisherName?: string; imprint?: string; publicationDate?: string;
  description?: string; subjects?: SubjectLite[]; pageCount?: number; prices?: PriceLite[];
  senderName?: string; senderEmail?: string; productForm?: string;
}
/** A condition of conditional text ([?name]...[/?]); a name no condition defines is visible. */
export interface TextConditionLite { name: string; visible: boolean }
/** A named recipe for a table: the object and text styles of its header rows, body rows and every second body row. */
export interface TableStyleLite {
  id: string; name: string;
  headerObjectStyleId?: string; bodyObjectStyleId?: string; altObjectStyleId?: string;
  headerTextStyleId?: string; bodyTextStyleId?: string;
}
export interface DocSettingsLite { vertical?: Exclude<Vertical, "product">; baselineIncrement?: number; baselineStart?: number; facingPages?: boolean; colorMode?: "cmyk"; iccProfile?: string; book?: BookLite; presentDevice?: string; conditions?: TextConditionLite[]; tableStyles?: TableStyleLite[] }
export interface GradientStopLite { color: { r: number; g: number; b: number; a: number }; position: number; }
// A gradient in NORMALIZED box coordinates (see GradientPaint in the proto).
// Linear: axis (x1,y1)->(x2,y2). Radial: center (x1,y1), radius = |p2-p1| in
// world coordinates. Angular (conic): center (x1,y1), the 0% direction points toward (x2,y2), sweeping
// clockwise. Diamond: center (x1,y1), 100% where |dx|+|dy| in world units equals |p2-p1|.
export interface GradientLite {
  kind: "linear" | "radial" | "angular" | "diamond";
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
// Arrowheads at the ends of an open path or a line (see ArrowHead in the proto) and per-side weights of a
// rectangle / frame stroke (see StrokeSides). All absent by default, so a stroke without them is what it was.
export type ArrowHeadLite = "arrow" | "triangle" | "circle" | "square" | "diamond";
export interface StrokeSidesLite { top: number; right: number; bottom: number; left: number }
// A variable-width stroke's profile (see WidthPoint in the proto and vector/widthProfile.ts); absent = uniform.
export interface WidthPointLite { position: number; left: number; right: number }
// A brush (see Brush in the proto and vector/brush.ts); absent = the plain stroke. NONE collapses to absent.
export type BrushKindLite = "stretch" | "scatter";
export type BrushTipLite = "dot" | "dash" | "square" | "diamond" | "leaf";
export interface BrushLite { kind: BrushKindLite; tip: BrushTipLite; spacing: number; scatter: number; sizeJitter: number; angleJitter: number; seed: number }
export interface StrokeLite { color: FillLite; weight: number; align: StrokeAlignLite; startCap?: ArrowHeadLite; endCap?: ArrowHeadLite; sides?: StrokeSidesLite; widthProfile?: WidthPointLite[]; brush?: BrushLite; }

// Auto layout of a frame (see AutoLayout in the proto and store/layout.ts). As
// for StrokeAlignLite, enums are strings: UNSPECIFIED collapses to
// "horizontal" / "start", which is what the computation would do anyway.
export type LayoutDirectionLite = "horizontal" | "vertical";
export type LayoutAlignLite = "start" | "center" | "end" | "space-between" | "baseline";
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
  // GRID mode (docs/layout.md): the children sit in the cells of `columns` x `rows` instead of a
  // row. Absent = flex. `columnGap` / `rowGap` replace `spacing`.
  mode?: "grid";
  columns?: GridTrackLite[];
  rows?: GridTrackLite[];
  columnGap?: number;
  rowGap?: number;
}
// A track of a grid: fixed pixels, as big as its content (hug) or a weighted share of the rest (fr).
export type GridTrackKindLite = "fixed" | "hug" | "fr";
export interface GridTrackLite { kind: GridTrackKindLite; size: number }
// The cell a child occupies in a grid parent (1-based; absent number = auto / one cell).
export interface GridCellLite { column?: number; columnSpan?: number; row?: number; rowSpan?: number }

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
  | { kind: "backgroundBlur"; radius: number }
  // The radius ramps from startRadius at (x1,y1) to endRadius at (x2,y2), points in the node's unit box.
  | { kind: "progressiveBlur"; startRadius: number; endRadius: number; x1: number; y1: number; x2: number; y2: number; background: boolean }
  | { kind: "noise"; mode: NoiseModeLite; size: number; density: number; opacity: number; color: RgbaLite; color2: RgbaLite; seed: number }
  | { kind: "texture"; scale: number; intensity: number; seed: number }
  // Frosted backdrop + grain + light edge; drawn as those effects (renderer/effectsFx.ts::expandGlass).
  | { kind: "glass"; frost: number; light: number; lightAngle: number; noise: number };
export type NoiseModeLite = "mono" | "duo" | "multi";
type RgbaLite = { r: number; g: number; b: number; a: number };

// The alignment as a string and not as a numeric enum, for the same reason
// that `kind` is "rect" | "ellipse" | "text" instead of the oneof's
// discriminant: the in-memory model is what renderer and panels read, and a
// string is readable (and writable in a test) without importing the generated code.
// TEXT_ALIGN_UNSPECIFIED collapses to "left" -- it is the default the renderer
// should apply anyway, so the distinction is not observable.
export type TextAlignLite = "left" | "center" | "right" | "justify";

// No default is resolved here: `lineHeight: 0` stays 0 and does not become 1.2.
// The default belongs to the RENDERER (see the comment in the proto), and applying it in
// the model would make this side diverge from core.Apply (Go), which preserves
// the zero.
export interface TextStyleLite {
  fontFamily: string; fontSize: number; fontWeight: string;
  lineHeight: number; align: TextAlignLite;
  // Absent when upright (not `false`): a style that never had it stays identical, field by field.
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** px added after every character (tracking); absent at 0, may be negative. */
  letterSpacing?: number;
  // Type extras (proto TextStyle 20..26). All absent when unset, like `italic`.
  textCase?: TextCaseLite;
  textScript?: TextScriptLite;
  listKind?: ListKindLite;
  indent?: number;
  // CSS font-feature-settings value; see core.ValidFontFeatures.
  fontFeatures?: string;
  verticalAlign?: TextVAlignLite;
  inset?: number;
  /** Horizontal scale of the glyphs in percent (proto 30); absent = 100. */
  textScale?: number;
  /** Lowercase letters drawn as smaller capitals. */
  smallCaps?: boolean;
  /** Smaller and raised / lowered. */
  script?: "super" | "sub";
  /** Glyph width multiplier (1 = normal); absent at 1. */
  horizontalScale?: number;
  /** The font's pair kerning is off. */
  noKerning?: boolean;
  /** Text colour of the style; absent => the node's fill. */
  color?: { r: number; g: number; b: number; a: number };
  /** Variable-font axes ("wght 650, wdth 90"): drawn where the renderer can set them (SVG), always kept. */
  fontVariations?: string;
  /** DERIVED by the layout, never stored: px a piece is raised above its line's baseline (negative = lowered). */
  baselineShift?: number;
}
export type TextCaseLite = "upper" | "lower" | "title" | "smallCaps";
export type TextScriptLite = "super" | "sub";
export type ListKindLite = "bullet" | "numbered";
export type TextVAlignLite = "middle" | "bottom";

// RICH TEXT (store/richText.ts). `paragraphStyles` / `runs` are the document's; `rich` is DERIVED by
// resolveScene (never written, never in an op) and carries them resolved, so the layout needs no scene.
export interface TextRunLite { start: number; end: number; styleId: string }
export interface ResolvedParagraph {
  style: TextStyleLite;
  spaceBefore: number; spaceAfter: number; indentFirst: number; indentLeft: number;
  /** The lines sit on the baseline grid (see RichText.grid). */
  alignToGrid?: boolean;
  hyphenate?: boolean;
  /** The list marker in front of the paragraph ("•", "3."), numbers already counted; absent for no list. */
  marker?: string;
  /** Distance from the marker to the text (a list paragraph's text sits at indentLeft + listIndent). */
  listIndent?: number;
  tabs?: TabStopLite[];
  dropLines?: number; dropChars?: number;
  keepWithNext?: boolean; keepLinesTogether?: boolean; keepFirstLines?: number; keepLastLines?: number;
  ruleAbove?: ParagraphRuleLite; ruleBelow?: ParagraphRuleLite;
  shading?: { r: number; g: number; b: number; a: number }; shadingOffset?: number;
  borderColor?: { r: number; g: number; b: number; a: number }; borderWeight?: number;
  opticalMargin?: boolean;
}
/** A character style resolved to the fields it overrides (unset fields are 0 / "" / absent). */
export interface ResolvedRun { start: number; end: number; style: TextStyleLite }
export interface RichText {
  paragraphs: ResolvedParagraph[]; runs: ResolvedRun[];
  /** The baseline grid, with the world y of the text box: present when a paragraph aligns to it. */
  grid?: { increment: number; start: number; boxY: number };
  /** Boxes (relative to the text box's top-left) the lines avoid: objects that wrap the text (store/wrap.ts). */
  exclusions?: { x: number; y: number; width: number; height: number }[];
  /** Objects anchored in the text with their size: each takes a box in its line (see store/anchored.ts). */
  inlines?: { at: number; id: string; width: number; height: number }[];
}

export interface TabStopLite { position: number; align?: "center" | "right"; leader?: string }
export interface NestedStyleLite { styleId: string; delimiter: string; count: number; inclusive?: boolean }

export interface TextLite {
  /** DERIVED (store/textPath.ts): the polyline the text runs along, in the text's parent space. */
  onPath?: { x: number; y: number }[];
  /** DERIVED (store/textTokens.ts): where objects anchored in the text sit in its content (a U+FFFC each), by node id. */
  inlineObjects?: { at: number; id: string }[];
  content: string; style: TextStyleLite;
  paragraphStyles?: string[];
  runs?: TextRunLite[];
  rich?: RichText;
}

// An image is a REFERENCE, never bytes: `assetHash` is the sha256
// (lowercase hex) of the bytes, which live in <doc>.opendesigner/assets/ and are
// loaded from the URL built by rpc/assets.ts::assetUrl.
//
// The model contains no pixels, and this is the property not to lose: a
// NodeLite ends up inside ops, inside the snapshot and inside the clipboard
// payload, and none of those three places must ever carry an image.
export interface ImageLite {
  assetHash: string;
  /** The name of the file the image was placed from, and its size in pixels (what relinking and the effective resolution need). */
  originalName?: string; pixelWidth?: number; pixelHeight?: number;
}

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
  // DERIVED only, never stored or on the wire: set by instances.ts::instanceOverrideMap from
  // the instance's component properties: a master node hidden (boolean), a number written to
  // one of its attributes (number), or a nested instance pointed at another component (swap).
  hidden?: boolean;
  opacity?: number;
  cornerRadius?: number;
  fontSize?: number;
  componentId?: string;
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
  // boolean shows/hides the targets, text sets their content (free or from `options`), number
  // writes `attribute` of them, swap points nested instances at another component (value = component id).
  type: "boolean" | "text" | "number" | "swap";
  defaultValue: string;
  targetNodeIds: string[];
  // number: opacity | corner_radius | font_size. text: the allowed values (absent = free text).
  attribute?: string;
  options?: string[];
}
export interface VariantAxisLite { name: string; options: string[] }
export interface ComponentSetLite { id: string; name: string; axes: VariantAxisLite[] }

export interface NodeLite {
  // DERIVED only (store/masters.ts), never in a document: a copy of a master page's node drawn on a page that applies it.
  fromMaster?: boolean;
  // DERIVED only (store/threads.ts): the last frame of a text thread that has text left over.
  overset?: boolean;
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
  kind: "rect" | "ellipse" | "text" | "image" | "vector" | "unknown" | "group" | "frame" | "instance" | "polygon" | "star"; cornerRadius: number;
  // Parametric shapes (docs/shapes.md). Named after the proto fields (and the SetProperties mask paths)
  // they come from, and absent when they are the default, so existing nodes are unchanged.
  // Rectangles: `cornerSmoothing` (0..1) and `radii` (independent corner radii, replacing cornerRadius).
  // Ellipses: `arcStart` / `arcSweep` (degrees; sweep 0 = full) and `innerRatio` (the ring's hole).
  // Polygons: `sides`. Stars: `points` and `innerRatio` (the notch depth).
  cornerSmoothing?: number;
  radii?: CornerRadiiLite;
  arcStart?: number;
  arcSweep?: number;
  innerRatio?: number;
  sides?: number;
  points?: number;
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
  // Shared paint / effect styles (see PaintStyleDefLite, EffectStyleDefLite); absent when none.
  fillStyleId?: string;
  strokeStyleId?: string;
  effectStyleId?: string;
  /** Shared object style (store/graphics.ts) and layer; absent when none. */
  objectStyleId?: string;
  layerId?: string;
  /** DERIVED (store/graphics.ts): the node is on a locked layer -- drawn, but not picked. */
  locked?: boolean;
  // Constraints and layout sizing (see ConstraintLite); absent = the default (unspecified / fixed).
  constraintX?: ConstraintLite;
  constraintY?: ConstraintLite;
  layoutSizingX?: "fill";
  layoutSizingY?: "fill";
  // Size limits enforced by the auto layout engine (absent = no limit) and the opt-out of the
  // flow of an auto layout parent; see Node.min_width and Node.layout_positioning in the proto.
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  layoutPositioning?: "absolute";
  // The cell of a GRID auto layout parent; absent = auto-placed, one cell.
  gridCell?: GridCellLite;
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
  // Effect parameters sampled from `fx.*` tracks (animation/fx): effectId -> paramId -> value.
  animFx?: Record<string, Record<string, number>>;
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
  // Position in the hotspot's if / else if / else chain (see proto Transition.order); absent = not in a chain.
  order?: number;
}

/** Transition.order is 0..MAX_TRANSITION_ORDER (parity with core.MaxTransitionOrder). */
export const MAX_TRANSITION_ORDER = 1000;

/** The closed set of Transition.animation values (parity with core.TransitionAnimations). */
export const TRANSITION_ANIMATIONS = [
  "dissolve", "slide-left", "slide-right", "slide-up", "slide-down",
  "push-left", "push-right", "push-up", "push-down", "smart",
] as const;

// VARIABLES (design tokens): see proto VariableCollection / Variable and
// internal/core/variables.go. A value is a color (FillLite, solid), a number or a string.
// A comment pinned on the canvas (see Comment in the proto and internal/core/comments.go).
export interface CommentLite {
  id: string; parentId: string; nodeId: string; pageId: string; x: number; y: number;
  author: string; text: string; createdAt: number; resolved: boolean;
}
// DEV MODE (see Annotation / ReadyForDev in the proto and internal/core/devmode.go). The server keeps
// the snapshot a ready frame is compared against; the editor only needs the mark.
export interface AnnotationLite { id: string; nodeId: string; category: string; text: string; author: string; createdAt: number }
export interface ReadyLite { nodeId: string; note: string; markedBy: string; markedAt: number }
export interface DevLite { annotations: Record<string, AnnotationLite>; ready: Record<string, ReadyLite> }
export interface ModeLite { id: string; name: string }
export interface CollectionLite { id: string; name: string; modes: ModeLite[] }
export type VariableTypeLite = "color" | "number" | "string" | "boolean";
export interface VariableLite {
  id: string; collectionId: string; name: string; type: VariableTypeLite;
  // modeId -> value. A color is {r,g,b,a}; a number is a plain number; a string is a string; a boolean is a boolean.
  values: Record<string, FillLite | number | string | boolean>;
  // Present for an alias: the variable it reads (then `values` is empty).
  aliasOf?: string;
  // SWATCH data (store/graphics.ts): a color variable listed in the Swatches panel, with its print definition.
  swatch?: boolean;
  cmyk?: { c: number; m: number; y: number; k: number };
  spotName?: string;
  tintOf?: string; tint?: number;
}

// TYPOGRAPHY: uploaded font faces and shared text styles. See proto FontFace /
// TextStyleDef and internal/core/typography.go.
// OBJECT STYLES and LAYERS (store/graphics.ts, internal/core/graphics.go).
export const OBJECT_STYLE_PROPS = ["fills", "strokes", "effects", "opacity", "corner_radius", "blend_mode"] as const;
export type ObjectStyleProp = (typeof OBJECT_STYLE_PROPS)[number];
export interface ObjectStyleLite {
  id: string; name: string;
  /** Which of the properties below the style sets; the others are left to the node. */
  sets: ObjectStyleProp[];
  fills?: FillLite[]; strokes?: StrokeLite[]; effects?: EffectLite[];
  opacity?: number; cornerRadius?: number; blendMode?: BlendModeLite;
  basedOn?: string;
}
export interface LayerLite { id: string; name: string; hidden?: boolean; locked?: boolean; noPrint?: boolean }

export interface FontLite { id: string; family: string; weight: string; style: "normal" | "italic"; assetHash: string }
// Optional fields are absent at their default (paragraph kind, no base, no next style, zeros).
export interface ParagraphRuleLite {
  weight: number; color?: { r: number; g: number; b: number; a: number }; offset?: number; indentLeft?: number; indentRight?: number; columnWidth?: boolean;
}
export interface TextStyleDefLite {
  id: string; name: string; style: TextStyleLite;
  kind?: "character";
  basedOn?: string; nextStyleId?: string;
  spaceBefore?: number; spaceAfter?: number; indentFirst?: number; indentLeft?: number;
  alignToGrid?: boolean;
  // Paragraph styles only (docs/rich-text.md): hyphenation, lists, tabs, drop caps, nested styles.
  hyphenate?: boolean;
  listKind?: "bullet" | "number"; listMarker?: string; listNumberStyle?: NumberStyle; listIndent?: number;
  tabStops?: TabStopLite[];
  dropCapLines?: number; dropCapChars?: number;
  nestedStyles?: NestedStyleLite[];
  /** 1..9: the paragraphs appear in the table of contents and give running headers; absent = body text. */
  outlineLevel?: number;
  /** Keeps where a paragraph would break between threaded frames. */
  keepWithNext?: boolean; keepLinesTogether?: boolean;
  /** Orphans / widows: the fewest lines left at the bottom / carried to the top (1..6); absent = off. */
  keepFirstLines?: number; keepLastLines?: number;
  ruleAbove?: ParagraphRuleLite; ruleBelow?: ParagraphRuleLite;
  /** Fill behind the paragraph, and a border; both extend `shadingOffset` past the text. */
  shading?: { r: number; g: number; b: number; a: number }; shadingOffset?: number;
  borderColor?: { r: number; g: number; b: number; a: number }; borderWeight?: number;
  /** Hanging punctuation at the line edges. */
  opticalMargin?: boolean;
}
// SHARED PAINT AND EFFECT STYLES (docs/shapes.md; proto PaintStyleDef / EffectStyleDef).
export interface PaintStyleDefLite { id: string; name: string; paints: FillLite[] }
export interface EffectStyleDefLite { id: string; name: string; effects: EffectLite[] }
export interface CornerRadiiLite { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }

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
  settings?: DocSettingsLite;
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
  // Shared paint and effect styles, like textStyles: an empty record when there are none.
  paintStyles: Record<string, PaintStyleDefLite>;
  effectStyles: Record<string, EffectStyleDefLite>;
  objectStyles: Record<string, ObjectStyleLite>;
  layers: LayerLite[];
  // Comments, like clips: an empty record when there are none.
  comments: Record<string, CommentLite>;
  // Dev mode (annotations and ready frames); absent when the document has none.
  dev?: DevLite;
  // Only in scenes derived from playback (animation/pose.ts): see AnimInfo.
  anim?: AnimInfo;
  // M4 — components indexed by id (componentId -> master). It is part of the
  // document as much as `nodes` and `pages`: a CreateComponent populates it, and
  // fromDocument rebuilds it from the snapshot.
  components: Record<string, ComponentLite>;
  // Component sets (variants), like components: an empty record when there are none.
  componentSets: Record<string, ComponentSetLite>;
}

/** A page from its message: setup and master fields only when they are not at their default. */
export function toPageLite(p: {
  id: string; name: string; isMaster: boolean; masterId: string; width: number; height: number; marginTop: number; marginRight: number;
  marginBottom: number; marginLeft: number; columns: number; gutter: number; bleed: number;
  sectionStart?: boolean; numberStart?: number; numberStyle?: string; leftMasterId?: string;
  hiddenMasterItems?: readonly string[]; slug?: number; guides?: readonly { vertical: boolean; position: number }[];
}): PageLite {
  return {
    id: p.id, name: p.name,
    ...(p.isMaster ? { isMaster: true } : {}), ...(p.masterId ? { masterId: p.masterId } : {}),
    ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}),
    ...(p.marginTop ? { marginTop: p.marginTop } : {}), ...(p.marginRight ? { marginRight: p.marginRight } : {}),
    ...(p.marginBottom ? { marginBottom: p.marginBottom } : {}), ...(p.marginLeft ? { marginLeft: p.marginLeft } : {}),
    ...(p.columns ? { columns: p.columns } : {}), ...(p.gutter ? { gutter: p.gutter } : {}), ...(p.bleed ? { bleed: p.bleed } : {}),
    ...(p.sectionStart ? { sectionStart: true } : {}), ...(p.numberStart ? { numberStart: p.numberStart } : {}),
    // Passed through as is: an unknown style is invalid (isValidPageStructure), not silently dropped.
    ...(p.numberStyle ? { numberStyle: p.numberStyle as NumberStyle } : {}),
    ...(p.leftMasterId ? { leftMasterId: p.leftMasterId } : {}),
    ...(p.hiddenMasterItems?.length ? { hiddenMasterItems: [...p.hiddenMasterItems] } : {}),
    ...(p.slug ? { slug: p.slug } : {}),
    ...(p.guides?.length ? { guides: p.guides.map((g) => ({ vertical: g.vertical, position: g.position })) } : {}),
  };
}

/** The message form of document settings: every field written, "" / 0 / false when absent. */
export interface BookMsg {
  isbn13: string; title: string; subtitle: string; seriesName: string; seriesNumber: string; editionNumber: string;
  contributors: { role: string; personName: string; biography: string }[]; language: string; publisherName: string; imprint: string;
  publicationDate: string; description: string; subjects: { scheme: string; code: string; heading: string }[]; pageCount: number;
  prices: { priceType: string; amount: string; currency: string }[]; senderName: string; senderEmail: string; productForm: string;
}
export interface TableStyleMsg { id: string; name: string; headerObjectStyleId: string; bodyObjectStyleId: string; altObjectStyleId: string; headerTextStyleId: string; bodyTextStyleId: string }
export interface DocSettingsMsg { vertical: string; baselineIncrement: number; baselineStart: number; facingPages?: boolean; presentDevice?: string; colorMode?: string; iccProfile?: string; book?: BookMsg; conditions?: { name: string; visible: boolean }[]; tableStyles?: TableStyleMsg[] }

/** The message form of a book record (every field written). */
export function bookToMsg(b: BookLite): BookMsg {
  return {
    isbn13: b.isbn13 ?? "", title: b.title ?? "", subtitle: b.subtitle ?? "", seriesName: b.seriesName ?? "", seriesNumber: b.seriesNumber ?? "", editionNumber: b.editionNumber ?? "",
    contributors: (b.contributors ?? []).map((c) => ({ role: c.role, personName: c.personName, biography: c.biography ?? "" })),
    language: b.language ?? "", publisherName: b.publisherName ?? "", imprint: b.imprint ?? "", publicationDate: b.publicationDate ?? "", description: b.description ?? "",
    subjects: (b.subjects ?? []).map((x) => ({ scheme: x.scheme, code: x.code, heading: x.heading ?? "" })), pageCount: b.pageCount ?? 0,
    prices: (b.prices ?? []).map((x) => ({ priceType: x.priceType, amount: x.amount, currency: x.currency })),
    senderName: b.senderName ?? "", senderEmail: b.senderEmail ?? "", productForm: b.productForm ?? "",
  };
}

/** A book record with only its non-default fields; undefined when it says nothing. */
export function bookOf(m: BookMsg | undefined): BookLite | undefined {
  if (!m) return undefined;
  const out: BookLite = {
    ...(m.isbn13 ? { isbn13: m.isbn13 } : {}), ...(m.title ? { title: m.title } : {}), ...(m.subtitle ? { subtitle: m.subtitle } : {}),
    ...(m.seriesName ? { seriesName: m.seriesName } : {}), ...(m.seriesNumber ? { seriesNumber: m.seriesNumber } : {}), ...(m.editionNumber ? { editionNumber: m.editionNumber } : {}),
    ...(m.contributors.length ? { contributors: m.contributors.map((c) => ({ role: c.role, personName: c.personName, ...(c.biography ? { biography: c.biography } : {}) })) } : {}),
    ...(m.language ? { language: m.language } : {}), ...(m.publisherName ? { publisherName: m.publisherName } : {}), ...(m.imprint ? { imprint: m.imprint } : {}),
    ...(m.publicationDate ? { publicationDate: m.publicationDate } : {}), ...(m.description ? { description: m.description } : {}),
    ...(m.subjects.length ? { subjects: m.subjects.map((x) => ({ scheme: x.scheme, code: x.code, ...(x.heading ? { heading: x.heading } : {}) })) } : {}),
    ...(m.pageCount ? { pageCount: m.pageCount } : {}),
    ...(m.prices.length ? { prices: m.prices.map((x) => ({ priceType: x.priceType, amount: x.amount, currency: x.currency })) } : {}),
    ...(m.senderName ? { senderName: m.senderName } : {}), ...(m.senderEmail ? { senderEmail: m.senderEmail } : {}), ...(m.productForm ? { productForm: m.productForm } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Document settings as the init shape of a DocSettings message. */
export function settingsToMsg(s: DocSettingsLite): DocSettingsMsg {
  return {
    vertical: s.vertical ?? "", baselineIncrement: s.baselineIncrement ?? 0, baselineStart: s.baselineStart ?? 0,
    facingPages: s.facingPages === true, presentDevice: s.presentDevice ?? "", colorMode: s.colorMode ?? "", iccProfile: s.iccProfile ?? "",
    ...(s.book ? { book: bookToMsg(s.book) } : {}),
    ...(s.conditions?.length ? { conditions: s.conditions.map((c) => ({ name: c.name, visible: c.visible })) } : {}),
    ...(s.tableStyles?.length ? {
      tableStyles: s.tableStyles.map((t) => ({
        id: t.id, name: t.name, headerObjectStyleId: t.headerObjectStyleId ?? "", bodyObjectStyleId: t.bodyObjectStyleId ?? "", altObjectStyleId: t.altObjectStyleId ?? "",
        headerTextStyleId: t.headerTextStyleId ?? "", bodyTextStyleId: t.bodyTextStyleId ?? "",
      })),
    } : {}),
  };
}

/** The settings of a message with only the non-default fields, or `{}`-free: undefined when all are default. */
export function settingsOf(s: DocSettingsMsg): DocSettingsLite {
  return {
    ...(s.vertical === "publishing" || s.vertical === "design" ? { vertical: s.vertical } : {}),
    ...(s.baselineIncrement ? { baselineIncrement: s.baselineIncrement } : {}),
    ...(s.baselineStart ? { baselineStart: s.baselineStart } : {}),
    ...(s.facingPages ? { facingPages: true } : {}),
    ...(s.presentDevice && s.presentDevice !== "generic" ? { presentDevice: s.presentDevice } : {}),
    ...(s.colorMode === "cmyk" ? { colorMode: "cmyk" as const } : {}),
    ...(s.iccProfile ? { iccProfile: s.iccProfile } : {}),
    ...(bookOf(s.book) ? { book: bookOf(s.book)! } : {}),
    ...(s.conditions?.length ? { conditions: s.conditions.map((c) => ({ name: c.name, visible: c.visible })) } : {}),
    ...(s.tableStyles?.length ? {
      tableStyles: s.tableStyles.map((t) => ({
        id: t.id, name: t.name,
        ...(t.headerObjectStyleId ? { headerObjectStyleId: t.headerObjectStyleId } : {}), ...(t.bodyObjectStyleId ? { bodyObjectStyleId: t.bodyObjectStyleId } : {}),
        ...(t.altObjectStyleId ? { altObjectStyleId: t.altObjectStyleId } : {}), ...(t.headerTextStyleId ? { headerTextStyleId: t.headerTextStyleId } : {}),
        ...(t.bodyTextStyleId ? { bodyTextStyleId: t.bodyTextStyleId } : {}),
      })),
    } : {}),
  };
}

/** `{ settings }` for a scene when the message has any non-default setting, else `{}`. */
export function settingsField(s: DocSettingsMsg): { settings?: DocSettingsLite } {
  const out = settingsOf(s);
  return Object.keys(out).length > 0 ? { settings: out } : {};
}

export function emptyScene(id: string, name: string): SceneState {
  return { id, name, schemaVersion: 1, pages: [{ id: "page1", name: "Page 1" }], nodes: NodeMap.empty, flows: {}, transitions: {}, clips: {}, collections: {}, variables: {}, fonts: {}, textStyles: {}, paintStyles: {}, effectStyles: {}, objectStyles: {}, layers: [], comments: {}, components: {}, componentSets: {} };
}

const ALIGN_TO_LITE: Record<TextAlign, TextAlignLite> = {
  [TextAlign.UNSPECIFIED]: "left",
  [TextAlign.LEFT]: "left",
  [TextAlign.CENTER]: "center",
  [TextAlign.RIGHT]: "right",
  [TextAlign.JUSTIFY]: "justify",
};
const ALIGN_TO_PB: Record<TextAlignLite, TextAlign> = {
  left: TextAlign.LEFT,
  center: TextAlign.CENTER,
  right: TextAlign.RIGHT,
  justify: TextAlign.JUSTIFY,
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
const CASE_TO_LITE: Partial<Record<TextCase, TextCaseLite>> = {
  [TextCase.UPPER]: "upper", [TextCase.LOWER]: "lower", [TextCase.TITLE]: "title", [TextCase.SMALL_CAPS]: "smallCaps",
};
const CASE_TO_PB: Record<TextCaseLite, TextCase> = {
  upper: TextCase.UPPER, lower: TextCase.LOWER, title: TextCase.TITLE, smallCaps: TextCase.SMALL_CAPS,
};
const SCRIPT_TO_LITE: Partial<Record<TextScript, TextScriptLite>> = { [TextScript.SUPER]: "super", [TextScript.SUB]: "sub" };
const SCRIPT_TO_PB: Record<TextScriptLite, TextScript> = { super: TextScript.SUPER, sub: TextScript.SUB };
const LIST_TO_LITE: Partial<Record<ListKind, ListKindLite>> = { [ListKind.BULLET]: "bullet", [ListKind.NUMBERED]: "numbered" };
const LIST_TO_PB: Record<ListKindLite, ListKind> = { bullet: ListKind.BULLET, numbered: ListKind.NUMBERED };
const VALIGN_TO_LITE: Partial<Record<TextVAlign, TextVAlignLite>> = { [TextVAlign.MIDDLE]: "middle", [TextVAlign.BOTTOM]: "bottom" };
const VALIGN_TO_PB: Record<TextVAlignLite, TextVAlign> = { middle: TextVAlign.MIDDLE, bottom: TextVAlign.BOTTOM };

export function toTextStyleLite(s: PbTextStyle | undefined): TextStyleLite {
  const tc = CASE_TO_LITE[s?.textCase ?? TextCase.UNSPECIFIED];
  const ts = SCRIPT_TO_LITE[s?.textScript ?? TextScript.UNSPECIFIED];
  const lk = LIST_TO_LITE[s?.listKind ?? ListKind.UNSPECIFIED];
  const va = VALIGN_TO_LITE[s?.verticalAlign ?? TextVAlign.UNSPECIFIED];
  return {
    fontFamily: s?.fontFamily ?? "",
    fontSize: s?.fontSize ?? 0,
    fontWeight: s?.fontWeight ?? "",
    lineHeight: s?.lineHeight ?? 0,
    align: ALIGN_TO_LITE[s?.align ?? TextAlign.UNSPECIFIED] ?? "left",
    ...(s?.italic ? { italic: true } : {}),
    ...(tc ? { textCase: tc } : {}),
    ...(ts ? { textScript: ts } : {}),
    ...(lk ? { listKind: lk } : {}),
    ...(s && s.indent > 0 ? { indent: s.indent } : {}),
    ...(s && s.fontFeatures !== "" ? { fontFeatures: s.fontFeatures } : {}),
    ...(va ? { verticalAlign: va } : {}),
    ...(s && s.inset > 0 ? { inset: s.inset } : {}),
    ...(s && s.textScale > 0 ? { textScale: s.textScale } : {}),
    ...(s?.underline ? { underline: true } : {}),
    ...(s?.strikethrough ? { strikethrough: true } : {}),
    ...(s?.letterSpacing ? { letterSpacing: s.letterSpacing } : {}),
    ...(s?.smallCaps ? { smallCaps: true } : {}),
    ...(s?.script === TextScript.SUPERSCRIPT ? { script: "super" as const } : s?.script === TextScript.SUBSCRIPT ? { script: "sub" as const } : {}),
    ...(s?.horizontalScale && s.horizontalScale !== 1 ? { horizontalScale: s.horizontalScale } : {}),
    ...(s?.noKerning ? { noKerning: true } : {}),
    ...(s?.color ? { color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } } : {}),
    ...(s?.fontFeatures ? { fontFeatures: s.fontFeatures } : {}),
    ...(s?.fontVariations ? { fontVariations: s.fontVariations } : {}),
  };
}

export function toTextLite(t: PbTextNode): TextLite {
  const paras = t.paragraphStyles.some((p) => p !== "") ? [...t.paragraphStyles] : undefined;
  return {
    content: t.content, style: toTextStyleLite(t.style),
    ...(paras ? { paragraphStyles: paras } : {}),
    ...(t.runs.length > 0 ? { runs: t.runs.map((r) => ({ start: r.start, end: r.end, styleId: r.styleId })) } : {}),
  };
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

const PROP_KIND: Record<number, ComponentPropertyLite["type"]> = {
  [ComponentPropertyType.BOOLEAN]: "boolean", [ComponentPropertyType.TEXT]: "text",
  [ComponentPropertyType.NUMBER]: "number", [ComponentPropertyType.INSTANCE_SWAP]: "swap",
};
const PROP_TYPE: Record<ComponentPropertyLite["type"], ComponentPropertyType> = {
  boolean: ComponentPropertyType.BOOLEAN, text: ComponentPropertyType.TEXT,
  number: ComponentPropertyType.NUMBER, swap: ComponentPropertyType.INSTANCE_SWAP,
};

export function toComponentPropertyLite(p: PbComponentProperty): ComponentPropertyLite {
  return {
    name: p.name,
    type: PROP_KIND[p.type] ?? "boolean",
    defaultValue: p.defaultValue,
    targetNodeIds: [...p.targetNodeIds],
    ...(p.attribute !== "" ? { attribute: p.attribute } : {}),
    ...(p.options.length > 0 ? { options: [...p.options] } : {}),
  };
}
export function toPbComponentProperty(p: ComponentPropertyLite): PbComponentProperty {
  return create(ComponentPropertySchema, {
    name: p.name,
    type: PROP_TYPE[p.type],
    defaultValue: p.defaultValue,
    targetNodeIds: [...p.targetNodeIds],
    attribute: p.attribute ?? "",
    options: [...(p.options ?? [])],
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
    textCase: s.textCase ? CASE_TO_PB[s.textCase] : TextCase.UNSPECIFIED,
    textScript: s.textScript ? SCRIPT_TO_PB[s.textScript] : TextScript.UNSPECIFIED,
    listKind: s.listKind ? LIST_TO_PB[s.listKind] : ListKind.UNSPECIFIED,
    indent: s.indent ?? 0,
    fontFeatures: s.fontFeatures ?? "",
    verticalAlign: s.verticalAlign ? VALIGN_TO_PB[s.verticalAlign] : TextVAlign.UNSPECIFIED,
    inset: s.inset ?? 0,
    textScale: s.textScale ?? 0,
    underline: s.underline === true,
    strikethrough: s.strikethrough === true,
    letterSpacing: s.letterSpacing ?? 0,
    smallCaps: s.smallCaps === true,
    script: s.script === "super" ? TextScript.SUPERSCRIPT : s.script === "sub" ? TextScript.SUBSCRIPT : TextScript.NORMAL,
    horizontalScale: s.horizontalScale ?? 0,
    noKerning: s.noKerning === true,
    fontVariations: s.fontVariations ?? "",
    ...(s.color ? { color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } } : {}),
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
    ...(s.startCap ? { startCap: ARROW_TO_PB[s.startCap] } : {}),
    ...(s.endCap ? { endCap: ARROW_TO_PB[s.endCap] } : {}),
    ...(s.sides ? { sides: { ...s.sides } } : {}),
    ...(s.widthProfile && s.widthProfile.length > 0 ? { widthProfile: s.widthProfile.map((p) => ({ ...p })) } : {}),
    ...(s.brush ? { brush: toPbBrush(s.brush) } : {}),
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
      case "progressiveBlur":
        return { kind: { case: "progressiveBlur" as const, value: { startRadius: e.startRadius, endRadius: e.endRadius, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, background: e.background } } };
      case "noise":
        return { kind: { case: "noise" as const, value: { mode: NOISE_TO_PB[e.mode], size: e.size, density: e.density, opacity: e.opacity, color: { ...e.color }, color2: { ...e.color2 }, seed: e.seed } } };
      case "texture":
        return { kind: { case: "texture" as const, value: { scale: e.scale, intensity: e.intensity, seed: e.seed } } };
      case "glass":
        return { kind: { case: "glass" as const, value: { frost: e.frost, light: e.light, lightAngle: e.lightAngle, noise: e.noise } } };
      default:
        return { kind: { case: "layerBlur" as const, value: { radius: e.radius } } };
    }
  });
}

const LAYOUT_ALIGN_TO_LITE: Partial<Record<LayoutAlign, LayoutAlignLite>> = {
  [LayoutAlign.START]: "start", [LayoutAlign.CENTER]: "center", [LayoutAlign.END]: "end",
  [LayoutAlign.SPACE_BETWEEN]: "space-between", [LayoutAlign.BASELINE]: "baseline",
};
const LAYOUT_ALIGN_TO_PB: Record<LayoutAlignLite, LayoutAlign> = {
  start: LayoutAlign.START, center: LayoutAlign.CENTER, end: LayoutAlign.END,
  "space-between": LayoutAlign.SPACE_BETWEEN, baseline: LayoutAlign.BASELINE,
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
    ...(a.mode === LayoutMode.GRID ? { mode: "grid" as const } : {}),
    ...(a.columns.length > 0 ? { columns: a.columns.map(toTrackLite) } : {}),
    ...(a.rows.length > 0 ? { rows: a.rows.map(toTrackLite) } : {}),
    ...(a.columnGap ? { columnGap: a.columnGap } : {}),
    ...(a.rowGap ? { rowGap: a.rowGap } : {}),
  };
}

const TRACK_TO_LITE: Record<GridTrackKind, GridTrackKindLite> = {
  [GridTrackKind.FIXED]: "fixed", [GridTrackKind.HUG]: "hug", [GridTrackKind.FR]: "fr",
};
const TRACK_TO_PB: Record<GridTrackKindLite, GridTrackKind> = { fixed: GridTrackKind.FIXED, hug: GridTrackKind.HUG, fr: GridTrackKind.FR };
const toTrackLite = (t: { kind: GridTrackKind; size: number }): GridTrackLite => ({ kind: TRACK_TO_LITE[t.kind] ?? "fixed", size: t.size });
const toPbTrack = (t: GridTrackLite) => ({ kind: TRACK_TO_PB[t.kind], size: t.size });

export function toGridCellLite(c: { column: number; columnSpan: number; row: number; rowSpan: number } | undefined): GridCellLite | undefined {
  if (!c || (!c.column && !c.columnSpan && !c.row && !c.rowSpan)) return undefined;
  return {
    ...(c.column ? { column: c.column } : {}), ...(c.columnSpan ? { columnSpan: c.columnSpan } : {}),
    ...(c.row ? { row: c.row } : {}), ...(c.rowSpan ? { rowSpan: c.rowSpan } : {}),
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
    mode: a.mode === "grid" ? LayoutMode.GRID : LayoutMode.FLEX,
    columns: (a.columns ?? []).map(toPbTrack), rows: (a.rows ?? []).map(toPbTrack),
    columnGap: a.columnGap ?? 0, rowGap: a.rowGap ?? 0,
  };
}

const NOISE_TO_LITE: Partial<Record<NoiseMode, NoiseModeLite>> = {
  [NoiseMode.MONO]: "mono", [NoiseMode.DUO]: "duo", [NoiseMode.MULTI]: "multi",
};
const NOISE_TO_PB: Record<NoiseModeLite, NoiseMode> = { mono: NoiseMode.MONO, duo: NoiseMode.DUO, multi: NoiseMode.MULTI };

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
  if (k.case === "progressiveBlur") {
    const v = k.value;
    return { kind: "progressiveBlur", startRadius: v.startRadius, endRadius: v.endRadius, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2, background: v.background };
  }
  if (k.case === "noise") {
    const v = k.value;
    const col = (c: typeof v.color) => ({ r: c?.r ?? 0, g: c?.g ?? 0, b: c?.b ?? 0, a: c?.a ?? 1 });
    return { kind: "noise", mode: NOISE_TO_LITE[v.mode] ?? "mono", size: v.size, density: v.density, opacity: v.opacity, color: col(v.color), color2: col(v.color2), seed: v.seed };
  }
  if (k.case === "texture") return { kind: "texture", scale: k.value.scale, intensity: k.value.intensity, seed: k.value.seed };
  if (k.case === "glass") return { kind: "glass", frost: k.value.frost, light: k.value.light, lightAngle: k.value.lightAngle, noise: k.value.noise };
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
    return { kind: { case: g.kind, value } };
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
/** An InstanceLite as the wire InstanceNode init. */
export function toPbInstance(i: InstanceLite) {
  return {
    componentId: i.componentId,
    overrides: i.overrides.map(toPbInstanceOverride),
    propertyValues: { ...(i.propertyValues ?? {}) },
    variantProps: { ...(i.variantProps ?? {}) },
  };
}

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
  if (k?.case === "linear" || k?.case === "radial" || k?.case === "angular" || k?.case === "diamond") {
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

const ARROW_TO_LITE: Partial<Record<ArrowHead, ArrowHeadLite>> = {
  [ArrowHead.ARROW]: "arrow", [ArrowHead.TRIANGLE]: "triangle", [ArrowHead.CIRCLE]: "circle",
  [ArrowHead.SQUARE]: "square", [ArrowHead.DIAMOND]: "diamond",
};
const ARROW_TO_PB: Record<ArrowHeadLite, ArrowHead> = {
  arrow: ArrowHead.ARROW, triangle: ArrowHead.TRIANGLE, circle: ArrowHead.CIRCLE, square: ArrowHead.SQUARE, diamond: ArrowHead.DIAMOND,
};

export function toStrokeLite(s: PbStroke): StrokeLite {
  return {
    color: toFillLite(s.paint),
    weight: s.weight,
    align: STROKE_ALIGN_TO_LITE[s.align] ?? "center",
    ...(ARROW_TO_LITE[s.startCap] ? { startCap: ARROW_TO_LITE[s.startCap] } : {}),
    ...(ARROW_TO_LITE[s.endCap] ? { endCap: ARROW_TO_LITE[s.endCap] } : {}),
    ...(s.sides ? { sides: { top: s.sides.top, right: s.sides.right, bottom: s.sides.bottom, left: s.sides.left } } : {}),
    ...(s.widthProfile.length > 0 ? { widthProfile: s.widthProfile.map((p) => ({ position: p.position, left: p.left, right: p.right })) } : {}),
    ...(s.brush && s.brush.kind !== BrushKind.NONE ? { brush: toBrushLite(s.brush) } : {}),
  };
}

const BRUSH_KIND_TO_PB: Record<BrushKindLite, BrushKind> = { stretch: BrushKind.STRETCH, scatter: BrushKind.SCATTER };
const BRUSH_TIP_TO_PB: Record<BrushTipLite, BrushTip> = {
  dot: BrushTip.DOT, dash: BrushTip.DASH, square: BrushTip.SQUARE, diamond: BrushTip.DIAMOND, leaf: BrushTip.LEAF,
};
const BRUSH_TIP_TO_LITE: Record<number, BrushTipLite> = {
  [BrushTip.DOT]: "dot", [BrushTip.DASH]: "dash", [BrushTip.SQUARE]: "square", [BrushTip.DIAMOND]: "diamond", [BrushTip.LEAF]: "leaf",
};

function toPbBrush(b: BrushLite) {
  return {
    kind: BRUSH_KIND_TO_PB[b.kind], tip: BRUSH_TIP_TO_PB[b.tip], spacing: b.spacing, scatter: b.scatter,
    sizeJitter: b.sizeJitter, angleJitter: b.angleJitter, seed: b.seed,
  };
}

function toBrushLite(b: PbBrush): BrushLite {
  return {
    kind: b.kind === BrushKind.SCATTER ? "scatter" : "stretch", tip: BRUSH_TIP_TO_LITE[b.tip] ?? "dot", spacing: b.spacing,
    scatter: b.scatter, sizeJitter: b.sizeJitter, angleJitter: b.angleJitter, seed: b.seed,
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
    case "polygon": return "polygon";
    case "star": return "star";
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
    ...(n.shape.case === "rect" && n.shape.value.cornerSmoothing > 0 ? { cornerSmoothing: n.shape.value.cornerSmoothing } : {}),
    ...(n.shape.case === "rect" && n.shape.value.radii ? { radii: toCornerRadiiLite(n.shape.value.radii) } : {}),
    ...(n.shape.case === "ellipse" && n.shape.value.arcStart !== 0 ? { arcStart: n.shape.value.arcStart } : {}),
    ...(n.shape.case === "ellipse" && n.shape.value.arcSweep !== 0 ? { arcSweep: n.shape.value.arcSweep } : {}),
    ...(n.shape.case === "ellipse" && n.shape.value.innerRatio > 0 ? { innerRatio: n.shape.value.innerRatio } : {}),
    ...(n.shape.case === "polygon" ? { sides: n.shape.value.sides } : {}),
    ...(n.shape.case === "star" ? { points: n.shape.value.points, innerRatio: n.shape.value.innerRatio } : {}),
    clipsContent: n.shape.case === "frame" ? n.shape.value.clipsContent : false,
    ...(n.shape.case === "frame" && n.shape.value.autoLayout ? { autoLayout: toAutoLayoutLite(n.shape.value.autoLayout) } : {}),
    ...(n.shape.case === "text" ? { text: toTextLite(n.shape.value) } : {}),
    ...(n.shape.case === "image" ? {
      image: {
        assetHash: n.shape.value.assetHash,
        ...(n.shape.value.originalName ? { originalName: n.shape.value.originalName } : {}),
        ...(n.shape.value.pixelWidth ? { pixelWidth: n.shape.value.pixelWidth } : {}),
        ...(n.shape.value.pixelHeight ? { pixelHeight: n.shape.value.pixelHeight } : {}),
      },
    } : {}),
    ...(n.shape.case === "vector" ? { vector: toVectorLite(n.shape.value) } : {}),
    ...(n.shape.case === "instance" ? { instance: toInstanceLite(n.shape.value) } : {}),
    // The unknown branch travels whole and intact: see NodeLite.unknownShape.
    ...(kind === "unknown" ? { unknownShape: n.shape } : {}),
    ...(Object.keys(n.meta).length > 0 ? { meta: { ...n.meta } } : {}),
    ...(Object.keys(n.bindings).length > 0 ? { bindings: { ...n.bindings } } : {}),
    ...(Object.keys(n.modes).length > 0 ? { modes: { ...n.modes } } : {}),
    ...(n.textStyleId !== "" ? { textStyleId: n.textStyleId } : {}),
    ...(n.fillStyleId !== "" ? { fillStyleId: n.fillStyleId } : {}),
    ...(n.strokeStyleId !== "" ? { strokeStyleId: n.strokeStyleId } : {}),
    ...(n.effectStyleId !== "" ? { effectStyleId: n.effectStyleId } : {}),
    ...(n.objectStyleId !== "" ? { objectStyleId: n.objectStyleId } : {}),
    ...(n.layerId !== "" ? { layerId: n.layerId } : {}),
    ...(n.constraintX !== Constraint.UNSPECIFIED ? { constraintX: CONSTRAINT_TO_LITE[n.constraintX] } : {}),
    ...(n.constraintY !== Constraint.UNSPECIFIED ? { constraintY: CONSTRAINT_TO_LITE[n.constraintY] } : {}),
    ...(n.layoutSizingX === LayoutSizing.FILL ? { layoutSizingX: "fill" as const } : {}),
    ...(n.layoutSizingY === LayoutSizing.FILL ? { layoutSizingY: "fill" as const } : {}),
    ...(n.minWidth ? { minWidth: n.minWidth } : {}),
    ...(n.maxWidth ? { maxWidth: n.maxWidth } : {}),
    ...(n.minHeight ? { minHeight: n.minHeight } : {}),
    ...(n.maxHeight ? { maxHeight: n.maxHeight } : {}),
    ...(n.layoutPositioning === LayoutPositioning.ABSOLUTE ? { layoutPositioning: "absolute" as const } : {}),
    ...(toGridCellLite(n.gridCell) ? { gridCell: toGridCellLite(n.gridCell) } : {}),
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
    fillStyleId: n.fillStyleId ?? "",
    strokeStyleId: n.strokeStyleId ?? "",
    effectStyleId: n.effectStyleId ?? "",
    objectStyleId: n.objectStyleId ?? "",
    layerId: n.layerId ?? "",
    constraintX: n.constraintX ? CONSTRAINT_TO_PB[n.constraintX] : Constraint.UNSPECIFIED,
    constraintY: n.constraintY ? CONSTRAINT_TO_PB[n.constraintY] : Constraint.UNSPECIFIED,
    layoutSizingX: n.layoutSizingX === "fill" ? LayoutSizing.FILL : LayoutSizing.FIXED,
    layoutSizingY: n.layoutSizingY === "fill" ? LayoutSizing.FILL : LayoutSizing.FIXED,
    minWidth: n.minWidth ?? 0, maxWidth: n.maxWidth ?? 0, minHeight: n.minHeight ?? 0, maxHeight: n.maxHeight ?? 0,
    layoutPositioning: n.layoutPositioning === "absolute" ? LayoutPositioning.ABSOLUTE : LayoutPositioning.AUTO,
    ...(n.gridCell ? { gridCell: { column: n.gridCell.column ?? 0, columnSpan: n.gridCell.columnSpan ?? 0, row: n.gridCell.row ?? 0, rowSpan: n.gridCell.rowSpan ?? 0 } } : {}),
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
      ? { case: "ellipse" as const, value: { arcStart: n.arcStart ?? 0, arcSweep: n.arcSweep ?? 0, innerRatio: n.innerRatio ?? 0 } }
      : n.kind === "polygon"
      ? { case: "polygon" as const, value: { sides: n.sides ?? 3 } }
      : n.kind === "star"
      ? { case: "star" as const, value: { points: n.points ?? 5, innerRatio: n.innerRatio ?? 0.5 } }
      : n.kind === "image"
        // The hash and nothing else: it is all an ImageNode contains, and rebuilding it
        // here is what makes an image survive the undo of a delete and
        // a paste (both go through toPbNode). A missing `image` falls back to
        // an empty hash -- that is, to an image whose asset is not found, which the
        // renderer draws as a placeholder -- and never to a rectangle: a silent
        // shape change inside an undo would be much worse.
        ? { case: "image" as const, value: { assetHash: n.image?.assetHash ?? "", originalName: n.image?.originalName ?? "", pixelWidth: n.image?.pixelWidth ?? 0, pixelHeight: n.image?.pixelHeight ?? 0 } }
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
            paragraphStyles: n.text?.paragraphStyles ?? [],
            runs: (n.text?.runs ?? []).map((r) => ({ start: r.start, end: r.end, styleId: r.styleId })),
          } }
        : { case: "rect" as const, value: {
            cornerRadius: n.cornerRadius,
            ...(n.cornerSmoothing ? { cornerSmoothing: n.cornerSmoothing } : {}),
            ...(n.radii ? { radii: { ...n.radii } } : {}),
          } },
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
    ...(t.order !== 0 ? { order: t.order } : {}),
  };
}
export function toPbFlow(f: FlowLite): PbFlow {
  return create(FlowSchema, { id: f.id, name: f.name, description: f.description, startId: f.startId });
}
export function toPbTransition(t: TransitionLite): PbTransition {
  return create(TransitionSchema, {
    id: t.id, flowId: t.flowId, fromId: t.fromId, toId: t.toId, label: t.label,
    trigger: t.trigger, elementId: t.elementId, guard: t.guard, effect: t.effect,
    animation: t.animation ?? "", durationMs: t.durationMs ?? 0, easing: t.easing ?? "", delayMs: t.delayMs ?? 0, order: t.order ?? 0,
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

export function toAnnotationLite(a: PbAnnotation): AnnotationLite {
  return { id: a.id, nodeId: a.nodeId, category: a.category, text: a.text, author: a.author, createdAt: Number(a.createdAt) };
}
export function toPbAnnotation(a: AnnotationLite): PbAnnotation {
  return create(AnnotationSchema, { id: a.id, nodeId: a.nodeId, category: a.category, text: a.text, author: a.author, createdAt: BigInt(Math.trunc(a.createdAt)) });
}
export function toReadyLite(r: PbReady): ReadyLite {
  return { nodeId: r.nodeId, note: r.note, markedBy: r.markedBy, markedAt: Number(r.markedAt) };
}
/** The op payload: no snapshot, the server takes it. */
export function toPbReady(r: ReadyLite): PbReady {
  return create(ReadyForDevSchema, { nodeId: r.nodeId, note: r.note, markedBy: r.markedBy, markedAt: BigInt(Math.trunc(r.markedAt)) });
}

export function toCollectionLite(c: PbCollection): CollectionLite {
  return { id: c.id, name: c.name, modes: c.modes.map((m) => ({ id: m.id, name: m.name })) };
}
export function toPbCollection(c: CollectionLite): PbCollection {
  return create(VariableCollectionSchema, { id: c.id, name: c.name, modes: c.modes.map((m) => ({ id: m.id, name: m.name })) });
}
export function toVariableLite(v: PbVariable): VariableLite {
  const type: VariableTypeLite = v.type === VariableType.COLOR ? "color" : v.type === VariableType.STRING ? "string" : v.type === VariableType.BOOLEAN ? "boolean" : "number";
  const values: VariableLite["values"] = {};
  for (const [mode, val] of Object.entries(v.values)) {
    if (val.kind.case === "color") {
      const { r, g, b, a } = val.kind.value;
      values[mode] = { r, g, b, a };
    } else if (val.kind.case === "number") values[mode] = val.kind.value;
    else if (val.kind.case === "text") values[mode] = val.kind.value;
    else if (val.kind.case === "boolean") values[mode] = val.kind.value;
  }
  return {
    id: v.id, collectionId: v.collectionId, name: v.name, type, values, ...(v.aliasOf !== "" ? { aliasOf: v.aliasOf } : {}),
    ...(v.swatch ? { swatch: true as const } : {}),
    ...(v.cmyk ? { cmyk: { c: v.cmyk.c, m: v.cmyk.m, y: v.cmyk.y, k: v.cmyk.k } } : {}),
    ...(v.spotName !== "" ? { spotName: v.spotName } : {}),
    ...(v.tintOf !== "" ? { tintOf: v.tintOf, tint: v.tint } : {}),
  };
}
export function toPbVariable(v: VariableLite): PbVariable {
  const values: Record<string, { kind: { case: "color"; value: { r: number; g: number; b: number; a: number } } | { case: "number"; value: number } | { case: "text"; value: string } | { case: "boolean"; value: boolean } }> = {};
  for (const [mode, val] of Object.entries(v.values)) {
    values[mode] = typeof val === "number"
      ? { kind: { case: "number", value: val } }
      : typeof val === "string"
        ? { kind: { case: "text", value: val } }
        : typeof val === "boolean"
          ? { kind: { case: "boolean", value: val } }
          : { kind: { case: "color", value: { r: val.r, g: val.g, b: val.b, a: val.a } } };
  }
  return create(VariableSchema, {
    id: v.id, collectionId: v.collectionId, name: v.name, aliasOf: v.aliasOf ?? "",
    swatch: v.swatch === true, spotName: v.spotName ?? "", tintOf: v.tintOf ?? "", tint: v.tint ?? 0,
    ...(v.cmyk ? { cmyk: v.cmyk } : {}),
    type: v.type === "color" ? VariableType.COLOR : v.type === "string" ? VariableType.STRING : v.type === "boolean" ? VariableType.BOOLEAN : VariableType.NUMBER, values,
  });
}

export function toObjectStyleLite(d: PbObjectStyleDef): ObjectStyleLite {
  const sets = d.sets.filter((p): p is ObjectStyleProp => (OBJECT_STYLE_PROPS as readonly string[]).includes(p));
  return {
    id: d.id, name: d.name, sets,
    ...(d.fills.length > 0 ? { fills: d.fills.map(toFillLite) } : {}),
    ...(d.strokes.length > 0 ? { strokes: d.strokes.map(toStrokeLite) } : {}),
    ...(d.effects.length > 0 ? { effects: d.effects.map(toEffectLite) } : {}),
    ...(d.opacity ? { opacity: d.opacity } : {}),
    ...(d.cornerRadius ? { cornerRadius: d.cornerRadius } : {}),
    ...(blendToLite(d.blendMode) ? { blendMode: blendToLite(d.blendMode) } : {}),
    ...(d.basedOn ? { basedOn: d.basedOn } : {}),
  };
}
export function toPbObjectStyleDef(d: ObjectStyleLite): PbObjectStyleDef {
  return create(ObjectStyleDefSchema, {
    id: d.id, name: d.name, sets: [...d.sets],
    fills: toPbFills(d.fills ?? []), strokes: toPbStrokes(d.strokes ?? []), effects: toPbEffects(d.effects ?? []),
    opacity: d.opacity ?? 0, cornerRadius: d.cornerRadius ?? 0, blendMode: toPbBlend(d.blendMode), basedOn: d.basedOn ?? "",
  });
}
export function toLayerLite(l: PbLayer): LayerLite {
  return { id: l.id, name: l.name, ...(l.hidden ? { hidden: true } : {}), ...(l.locked ? { locked: true } : {}), ...(l.noPrint ? { noPrint: true } : {}) };
}
export function toPbLayer(l: LayerLite): PbLayer {
  return create(LayerSchema, { id: l.id, name: l.name, hidden: l.hidden === true, locked: l.locked === true, noPrint: l.noPrint === true });
}

export function toFontLite(f: PbFont): FontLite {
  return { id: f.id, family: f.family, weight: f.weight, style: f.style === "italic" ? "italic" : "normal", assetHash: f.assetHash };
}
export function toPbFont(f: FontLite): PbFont {
  return create(FontFaceSchema, { id: f.id, family: f.family, weight: f.weight, style: f.style, assetHash: f.assetHash });
}
function toRuleLite(r: PbParagraphRule): ParagraphRuleLite {
  return {
    weight: r.weight,
    ...(r.color ? { color: { r: r.color.r, g: r.color.g, b: r.color.b, a: r.color.a } } : {}),
    ...(r.offset ? { offset: r.offset } : {}),
    ...(r.indentLeft ? { indentLeft: r.indentLeft } : {}),
    ...(r.indentRight ? { indentRight: r.indentRight } : {}),
    ...(r.columnWidth ? { columnWidth: true } : {}),
  };
}
const toPbRule = (r: ParagraphRuleLite) => create(ParagraphRuleSchema, {
  weight: r.weight, offset: r.offset ?? 0, indentLeft: r.indentLeft ?? 0, indentRight: r.indentRight ?? 0, columnWidth: r.columnWidth === true,
  ...(r.color ? { color: { r: r.color.r, g: r.color.g, b: r.color.b, a: r.color.a } } : {}),
});
export function toTextStyleDefLite(d: PbTextStyleDef): TextStyleDefLite {
  return {
    id: d.id, name: d.name, style: toTextStyleLite(d.style),
    ...(d.kind === TextStyleKind.CHARACTER ? { kind: "character" as const } : {}),
    ...(d.basedOn ? { basedOn: d.basedOn } : {}),
    ...(d.nextStyleId ? { nextStyleId: d.nextStyleId } : {}),
    ...(d.spaceBefore ? { spaceBefore: d.spaceBefore } : {}),
    ...(d.spaceAfter ? { spaceAfter: d.spaceAfter } : {}),
    ...(d.indentFirst ? { indentFirst: d.indentFirst } : {}),
    ...(d.indentLeft ? { indentLeft: d.indentLeft } : {}),
    ...(d.alignToGrid ? { alignToGrid: true } : {}),
    ...(d.hyphenate ? { hyphenate: true } : {}),
    ...(d.listKind === ListKind.BULLET ? { listKind: "bullet" as const } : d.listKind === ListKind.NUMBER ? { listKind: "number" as const } : {}),
    ...(d.listMarker ? { listMarker: d.listMarker } : {}),
    ...(d.listNumberStyle === "i" || d.listNumberStyle === "I" || d.listNumberStyle === "a" || d.listNumberStyle === "A" ? { listNumberStyle: d.listNumberStyle } : {}),
    ...(d.listIndent ? { listIndent: d.listIndent } : {}),
    ...(d.tabStops.length > 0 ? {
      tabStops: d.tabStops.map((t) => ({
        position: t.position, ...(t.align === TabAlign.CENTER ? { align: "center" as const } : t.align === TabAlign.RIGHT ? { align: "right" as const } : {}),
        ...(t.leader ? { leader: t.leader } : {}),
      })),
    } : {}),
    ...(d.dropCapLines ? { dropCapLines: d.dropCapLines } : {}),
    ...(d.dropCapChars ? { dropCapChars: d.dropCapChars } : {}),
    ...(d.outlineLevel ? { outlineLevel: d.outlineLevel } : {}),
    ...(d.keepWithNext ? { keepWithNext: true } : {}),
    ...(d.keepLinesTogether ? { keepLinesTogether: true } : {}),
    ...(d.keepFirstLines ? { keepFirstLines: d.keepFirstLines } : {}),
    ...(d.keepLastLines ? { keepLastLines: d.keepLastLines } : {}),
    ...(d.ruleAbove ? { ruleAbove: toRuleLite(d.ruleAbove) } : {}),
    ...(d.ruleBelow ? { ruleBelow: toRuleLite(d.ruleBelow) } : {}),
    ...(d.shading ? { shading: { r: d.shading.r, g: d.shading.g, b: d.shading.b, a: d.shading.a } } : {}),
    ...(d.shadingOffset ? { shadingOffset: d.shadingOffset } : {}),
    ...(d.borderColor ? { borderColor: { r: d.borderColor.r, g: d.borderColor.g, b: d.borderColor.b, a: d.borderColor.a } } : {}),
    ...(d.borderWeight ? { borderWeight: d.borderWeight } : {}),
    ...(d.opticalMargin ? { opticalMargin: true } : {}),
    ...(d.nestedStyles.length > 0 ? {
      nestedStyles: d.nestedStyles.map((n) => ({ styleId: n.styleId, delimiter: n.delimiter, count: n.count, ...(n.inclusive ? { inclusive: true } : {}) })),
    } : {}),
  };
}
export function toPbTextStyleDef(d: TextStyleDefLite): PbTextStyleDef {
  return create(TextStyleDefSchema, {
    id: d.id, name: d.name, style: toPbTextStyle(d.style),
    kind: d.kind === "character" ? TextStyleKind.CHARACTER : TextStyleKind.PARAGRAPH,
    basedOn: d.basedOn ?? "", nextStyleId: d.nextStyleId ?? "",
    spaceBefore: d.spaceBefore ?? 0, spaceAfter: d.spaceAfter ?? 0, indentFirst: d.indentFirst ?? 0, indentLeft: d.indentLeft ?? 0,
    alignToGrid: d.alignToGrid === true,
    hyphenate: d.hyphenate === true,
    listKind: d.listKind === "bullet" ? ListKind.BULLET : d.listKind === "number" ? ListKind.NUMBER : ListKind.NONE,
    listMarker: d.listMarker ?? "", listNumberStyle: d.listNumberStyle ?? "", listIndent: d.listIndent ?? 0,
    tabStops: (d.tabStops ?? []).map((t) => ({
      position: t.position, align: t.align === "center" ? TabAlign.CENTER : t.align === "right" ? TabAlign.RIGHT : TabAlign.LEFT, leader: t.leader ?? "",
    })),
    dropCapLines: d.dropCapLines ?? 0, dropCapChars: d.dropCapChars ?? 0, outlineLevel: d.outlineLevel ?? 0,
    nestedStyles: (d.nestedStyles ?? []).map((n) => ({ styleId: n.styleId, delimiter: n.delimiter, count: n.count, inclusive: n.inclusive === true })),
    keepWithNext: d.keepWithNext === true, keepLinesTogether: d.keepLinesTogether === true,
    keepFirstLines: d.keepFirstLines ?? 0, keepLastLines: d.keepLastLines ?? 0,
    shadingOffset: d.shadingOffset ?? 0, borderWeight: d.borderWeight ?? 0, opticalMargin: d.opticalMargin === true,
    ...(d.ruleAbove ? { ruleAbove: toPbRule(d.ruleAbove) } : {}),
    ...(d.ruleBelow ? { ruleBelow: toPbRule(d.ruleBelow) } : {}),
    ...(d.shading ? { shading: { r: d.shading.r, g: d.shading.g, b: d.shading.b, a: d.shading.a } } : {}),
    ...(d.borderColor ? { borderColor: { r: d.borderColor.r, g: d.borderColor.g, b: d.borderColor.b, a: d.borderColor.a } } : {}),
  });
}
export function toPaintStyleDefLite(d: PbPaintStyleDef): PaintStyleDefLite {
  return { id: d.id, name: d.name, paints: d.paints.map(toFillLite) };
}
export function toPbPaintStyleDef(d: PaintStyleDefLite): PbPaintStyleDef {
  return create(PaintStyleDefSchema, { id: d.id, name: d.name, paints: toPbFills(d.paints) });
}
export function toEffectStyleDefLite(d: PbEffectStyleDef): EffectStyleDefLite {
  return { id: d.id, name: d.name, effects: d.effects.map(toEffectLite) };
}
export function toPbEffectStyleDef(d: EffectStyleDefLite): PbEffectStyleDef {
  return create(EffectStyleDefSchema, { id: d.id, name: d.name, effects: toPbEffects(d.effects) });
}
export function toCornerRadiiLite(r: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }): CornerRadiiLite {
  return { topLeft: r.topLeft, topRight: r.topRight, bottomRight: r.bottomRight, bottomLeft: r.bottomLeft };
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
    pages: doc.pages.map(toPageLite), nodes, components,
    ...(doc.settings ? settingsField(doc.settings) : {}),
    componentSets: Object.fromEntries(Object.entries(doc.componentSets).map(([id, c]) => [id, toComponentSetLite(c)])),
    flows: Object.fromEntries(Object.entries(doc.flows).map(([id, f]) => [id, toFlowLite(f)])),
    transitions: Object.fromEntries(Object.entries(doc.transitions).map(([id, t]) => [id, toTransitionLite(t)])),
    clips: Object.fromEntries(Object.entries(doc.clips).map(([id, c]) => [id, toClipLite(c)])),
    collections: Object.fromEntries(Object.entries(doc.collections).map(([id, c]) => [id, toCollectionLite(c)])),
    variables: Object.fromEntries(Object.entries(doc.variables).map(([id, v]) => [id, toVariableLite(v)])),
    fonts: Object.fromEntries(Object.entries(doc.fonts).map(([id, f]) => [id, toFontLite(f)])),
    textStyles: Object.fromEntries(Object.entries(doc.textStyles).map(([id, d]) => [id, toTextStyleDefLite(d)])),
    paintStyles: Object.fromEntries(Object.entries(doc.paintStyles).map(([id, d]) => [id, toPaintStyleDefLite(d)])),
    effectStyles: Object.fromEntries(Object.entries(doc.effectStyles).map(([id, d]) => [id, toEffectStyleDefLite(d)])),
    objectStyles: Object.fromEntries(Object.entries(doc.objectStyles).map(([id, d]) => [id, toObjectStyleLite(d)])),
    layers: doc.layers.map(toLayerLite),
    comments: Object.fromEntries(Object.entries(doc.comments).map(([id, c]) => [id, toCommentLite(c)])),
    ...(Object.keys(doc.annotations).length > 0 || Object.keys(doc.readyForDev).length > 0
      ? {
          dev: {
            annotations: Object.fromEntries(Object.entries(doc.annotations).map(([id, a]) => [id, toAnnotationLite(a)])),
            ready: Object.fromEntries(Object.entries(doc.readyForDev).map(([id, r]) => [id, toReadyLite(r)])),
          },
        }
      : {}),
  };
}
