import { usePosedScene } from "../animation/posedScene";
import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  Label, Slider, SliderOutput, SliderStateContext, SliderThumb, SliderTrack,
} from "react-aria-components";
import { useScene } from "../store/store";
import { ALIGN_COMMANDS, alignSelection, minSelection } from "../selection/align";
import type { AlignCommand } from "../selection/align";
import { selectionSummary, MIXED } from "../store/selectors";
import type { Mixed, OrMixed } from "../store/selectors";
import { frameOriginOf } from "../store/groups";
import { instanceOverrideMap } from "../store/instances";
import { effectiveComponentId } from "../store/components";
import { subtreeOf } from "../store/tree";
import { makeSetInstanceOverrideOp, makeSetPropsOp } from "../tools/ops";
import { layerDisplayName } from "./LayersPanel";
import { cls, EmptyState, Icon, IconButton, Section } from "./ds";
import { ExportSection } from "./ExportSection";
import { VariablesSection } from "./VariablesSection";
import { boundColor } from "./variableOps";
import { TypographyControls } from "./TypographyControls";
import { InstanceControls } from "./InstanceControls";
import { LayoutRelationControls } from "./LayoutRelationControls";
import { effectiveStyle, styleOps } from "./typographyOps";
import type { IconName } from "./ds";
import { SegRadio, type SegOption } from "./ds/props-controls";
import { NumberField } from "./fields/NumberField";
import { ColorField } from "./fields/ColorField";
import { GradientControls } from "./GradientControls";
import { BooleanControls } from "./BooleanControls";
import { EffectsControls } from "./EffectsControls";
import { LayoutGridControls } from "./LayoutGridControls";
import { StrokeStyleControls } from "./StrokeStyleControls";
import { AutoLayoutControls, WrapInAutoLayoutButton } from "./AutoLayoutControls";
import type { RgbLite } from "./fields/ColorField";
import { toPbFills, toPbStrokes } from "../store/types";
import type {
  FillLite, InstanceOverrideLite, NodeLite, SceneState,
  StrokeAlignLite, StrokeLite, TextAlignLite, TextStyleLite,
} from "../store/types";
import type { MaskPath } from "../store/maskPaths";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// PROPERTIES PANEL — geometry (Task 9) + text appearance and style (Task 10).
//
// Like the layers panel (ui/LayersPanel.tsx), it obeys the gesture
// rule: one op, one gesture -- even a single typed field goes through
// beginGesture/endGesture, so it stays undoable with Ctrl+Z and travels on the
// wire like any other change. A DRAG (a numeric field's label,
// the opacity slider) is a SINGLE gesture, not one per pixel: the intermediate
// positions are a local preview (applyLocal) and only the release
// sends the final op.

// The key read by NodeLite/SelectionSummary AND the FieldMask path that
// addresses it on the wire, together: adding a numeric field means adding ONE
// entry here, not touching the logic below. `minValue` is optional and lives here and
// not in the field itself: it is a property of the FIELD (width/height make no
// sense negative), not of the generic widget.
interface NumericField {
  key: "x" | "y" | "width" | "height" | "rotation" | "cornerRadius";
  label: string;
  mask: MaskPath;
  minValue?: number;
  // The symbol shown in place of the label, which stays the accessible name:
  // see NumberField::glyph.
  glyph?: string;
}

// POSITION and SIZE are separate because a GROUP has the first and not the
// second: a group has no box of its own (store/groups.ts) -- its frame
// is the union of the children, and width/height on the node stay the zeros it
// was born with. Showing W/H on a group is not just a wrong number: typing
// into it sends an op that BOTH implementations of apply accept, that
// does not change a pixel on the canvas, and that still costs a network send and an
// undo entry. Rotation lives in SIZE_FIELDS ("Rot" and not "R", already taken
// by the rectangle's radius): the handle gives the gesture, the field gives the number.
const POSITION_FIELDS: readonly NumericField[] = [
  { key: "x", label: "X", mask: "x" },
  { key: "y", label: "Y", mask: "y" },
];

const SIZE_FIELDS: readonly NumericField[] = [
  { key: "width", label: "W", mask: "width", minValue: 0 },
  { key: "height", label: "H", mask: "height", minValue: 0 },
  { key: "rotation", label: "Rot", mask: "rotation", glyph: "°" },
];

const GEOMETRY_FIELDS: readonly NumericField[] = [...POSITION_FIELDS, ...SIZE_FIELDS];

// "R" as radius: same ONE-LETTER convention as X/Y/W/H, which in
// design editors is the norm and keeps the grid tight. The label is also
// the accessible name (see NumberField), so there is no aria-label different
// from what is read -- it would be a violation of "label in name".
const CORNER_RADIUS_FIELD: NumericField = {
  key: "cornerRadius", label: "R", mask: "corner_radius", minValue: 0,
};

// The patch from a literal value: a switch and not an object computed with
// a dynamic key (`{ [field.key]: value }`) because makeSetPropsOp's type
// is the MessageInitShape generated from NodeSchema -- a dynamic
// key on a union would make it unverifiable at compile time, and it is
// exactly the check that MaskPath (store/maskPaths.ts) exists to give.
function patchFor(key: NumericField["key"], value: number) {
  switch (key) {
    case "x":
      return { x: value };
    case "y":
      return { y: value };
    case "width":
      return { width: value };
    case "height":
      return { height: value };
    case "rotation":
      return { rotation: value };
    case "cornerRadius":
      // NESTED inside the `shape` oneof: "corner_radius" is the only mask
      // path that does not address a top-level field of the Node (see
      // store/maskPaths.ts and core.applySetProps). The patch must therefore carry
      // a SHAPE, not a field -- and it is the same shape the node already has,
      // otherwise Go would answer ErrNotRectNode.
      return { shape: { case: "rect" as const, value: { cornerRadius: value } } };
  }
}

// The value to WRITE on a node's x/y so that its FRAME ends up where
// the field says.
//
// For everything that is not a group the field IS the frame, and the value must be
// written as is (`value` and not `n[key] + (value - n[key])`: the second
// form is algebraically identical but not in floating point, and the typed X
// must reach the model exactly as it was written).
//
// For a GROUP no: x/y are the translation that contributes to the children, while
// the frame sits where the children are (store/groups.ts::frameOriginOf). The field
// shows the frame -- as for every other selection, and as the overlay draws it
// -- so here the requested shift is translated into a new
// translation. The DELTA is resolved now: the op that goes out stays ABSOLUTE like
// any other setProps, so a rebase or a redo do not apply it twice.
function positionValueFor(scene: SceneState, n: NodeLite, key: "x" | "y", value: number): number {
  if (n.kind !== "group") return value;
  return n[key] + (value - frameOriginOf(scene, n)[key]);
}

// Op that writes ONE numeric field on EVERY selected node: like the
// visibility toggle and the layers panel's rename, the same ABSOLUTE value
// goes to all selected nodes -- not a relative translation.
// The only translation is positionValueFor's, which brings each node to the
// same POSITION even when its x/y is not its edge.
function numericOps(ids: readonly string[], field: NumericField, value: number): Op[] {
  const scene = useScene.getState().scene;
  return ids.map((id) => {
    const n = scene?.nodes.at(id);
    const v = scene && n && (field.key === "x" || field.key === "y")
      ? positionValueFor(scene, n, field.key, value)
      : value;
    return makeSetPropsOp(id, patchFor(field.key, v), [field.mask]);
  });
}

function opacityOps(ids: readonly string[], value: number): Op[] {
  return ids.map((id) => makeSetPropsOp(id, { opacity: value }, ["opacity"]));
}

// Fill op. The color arrives WITHOUT alpha (see ColorField): alpha is
// put in here by each node from its OWN tint, so a selection with different
// fill opacities does not see them flattened by a color change.
//
// And only the FIRST tint is replaced: a node with several fills must not
// lose the others because the panel shows only one.
function fillOps(ids: readonly string[], rgb: RgbLite): Op[] {
  const scene = useScene.getState().scene;
  if (!scene) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n) return [];
    const first = { ...rgb, a: n.fills[0]?.a ?? 1 };
    return [makeSetPropsOp(id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"])];
  });
}

// The stroke the panel shows and writes when a node has none.
// The weight is 1 and not 0 on purpose: writing a COLOR on a node without strokes
// must produce something VISIBLE, otherwise the user picks a color and
// nothing happens. Center is the canvas 2D's default (the only
// alignment it can do on its own, see renderer/canvasRenderer.ts) and is also
// what StrokeAlign_UNSPECIFIED means in the model.
const DEFAULT_STROKE: StrokeLite = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" };

// The patch that the stroke controls emit. The COLOR is there without alpha --
// RgbLite and not FillLite -- for the same reason ColorField does not
// carry it: the 6-digit hex does not contain it, and each node puts alpha back
// from its OWN stroke (see strokeOps). It is a type and not a `Partial<StrokeLite>`
// precisely to make it IMPOSSIBLE for an alpha taken from elsewhere to arrive here.
type StrokePatch = Partial<Omit<StrokeLite, "color">> & { color?: RgbLite };

// STROKE ops. Same shape as fillOps -- and for the same reasons:
//
//  - only the FIRST stroke is touched and the others stay where they are (the panel
//    shows only one; losing the others would be a change the user
//    did not ask for and cannot see);
//  - the patch starts from the NODE's stroke, not from the one summarized for the
//    panel: in a mixed selection, changing the weight must not flatten
//    color and alignment too -- and changing the COLOR must not flatten
//    the alpha, which is put back here from each node's stroke;
//  - a node without strokes starts from DEFAULT_STROKE, that is writing any
//    field CREATES the stroke.
//
// The mask is `strokes` and replaces the WHOLE list (see store/applyOp.ts and
// core.applySetProps): that is why the list must be rebuilt in full, not
// "modified".
function strokeOps(ids: readonly string[], patch: StrokePatch): Op[] {
  const scene = useScene.getState().scene;
  if (!scene) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n) return [];
    const base = n.strokes[0] ?? DEFAULT_STROKE;
    // The alpha of THIS NODE's stroke, resolved node by node inside the loop:
    // reading it from the selection summary would reset it to 1 every time
    // the nodes differ (the summary in that case is MIXED, that is no
    // value), which is exactly when it matters.
    const color: FillLite = patch.color ? { ...patch.color, a: base.color.a } : base.color;
    const first: StrokeLite = { ...base, ...patch, color };
    return [makeSetPropsOp(id, { strokes: toPbStrokes([first, ...n.strokes.slice(1)]) }, ["strokes"])];
  });
}

// Text STYLE op. SetText and not a mask path: the content and the
// style live INSIDE the Node's `shape` oneof (see core.applySetText).
//
// The content travels UNCHANGED but it travels: applySetText always writes it, and
// omitting it would erase the text. The style starts from the NODE's and not from
// the one summarized for the panel: in a mixed selection, changing the
// size must not flatten weight and alignment too.
function textStyleOps(ids: readonly string[], patch: Partial<TextStyleLite>): Op[] {
  const scene = useScene.getState().scene;
  if (!scene) return [];
  // A text with a shared style is detached first and keeps what it was drawn with.
  return styleOps(scene, ids, patch);
}

// Summary of the selection's STYLE, for the same reasons (and with the same
// MIXED semantics) as selectors.ts::selectionSummary. It sits here and not there because
// it concerns only text nodes: putting it in SelectionSummary would mean
// computing it for every selection, text or not.
interface TextStyleSummary {
  fontSize: OrMixed<number>;
  fontWeight: OrMixed<string>;
  align: OrMixed<TextAlignLite>;
}

function summarizeStyle<T>(styles: readonly TextStyleLite[], get: (s: TextStyleLite) => T): OrMixed<T> {
  const value = get(styles[0]);
  for (let i = 1; i < styles.length; i++) if (!Object.is(get(styles[i]), value)) return MIXED;
  return value;
}

// null if even a single selected node is not text: the style controls
// do not appear at all in that case.
function textStyleSummary(nodes: readonly NodeLite[]): TextStyleSummary | null {
  const styles = nodes.map((n) => n.text?.style).filter((s): s is TextStyleLite => s !== undefined);
  if (styles.length === 0 || styles.length !== nodes.length) return null;
  return {
    fontSize: summarizeStyle(styles, (s) => s.fontSize),
    fontWeight: summarizeStyle(styles, (s) => s.fontWeight),
    align: summarizeStyle(styles, (s) => s.align),
  };
}

// The only two weights the panel offers in M1b. The model accepts any
// string (TextStyle.font_weight is a string, "400" | "700" | ...): a node with
// a weight outside this list simply leaves the group with no
// choice selected, which is more honest than rounding it to the nearest.
const FONT_WEIGHTS: readonly SegOption<string>[] = [
  { value: "400", label: "Normal" },
  { value: "700", label: "Bold" },
];

const ALIGNMENTS: readonly SegOption<TextAlignLite>[] = [
  { value: "left", label: "Left", icon: "textLeft" },
  { value: "center", label: "Center", icon: "textCenter" },
  { value: "right", label: "Right", icon: "textRight" },
];

// The stroke's POSITION relative to the perimeter. The group is called
// "Position" and not "Alignment" on purpose: on a TEXT node with a stroke the
// two groups coexist in the panel, and the label is also the accessible name
// -- two groups with the same name would be indistinguishable to someone navigating by voice.
const STROKE_ALIGNMENTS: readonly SegOption<StrokeAlignLite>[] = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Center" },
  { value: "outside", label: "Outside" },
];

// The inspector's header: icon and name of the node's TYPE.
const KIND_ICON: Record<NodeLite["kind"], IconName> = {
  rect: "rect", ellipse: "ellipse", text: "text", image: "image", vector: "pen",
  unknown: "rect", group: "layers", frame: "frame", instance: "components",
};
const KIND_LABEL: Record<NodeLite["kind"], string> = {
  rect: "Rectangle", ellipse: "Ellipse", text: "Text", image: "Image", vector: "Vector",
  unknown: "Element", group: "Group", frame: "Frame", instance: "Instance",
};

// A summarized value ready for a CONTROLLED RadioGroup: null (and not
// undefined) for MIXED, so the group stays controlled and simply shows
// no choice -- same reason NumberField uses NaN instead of
// undefined.
function radioValue<T extends string>(v: OrMixed<T>): T | null {
  return v === MIXED ? null : (v as T);
}

// Opacity is a 0..1 float in the model and a percentage for whoever reads it: the
// conversion is done by Intl, inside the slider's state, only once -- and the
// same string then serves both the displayed text and the announced value.
// A module constant and not an inline literal: `useNumberFormatter` memoizes
// on the object's IDENTITY, and a new literal on every render
// would rebuild the Intl.NumberFormat on every drag frame.
const PERCENT_FORMAT: Intl.NumberFormatOptions = { style: "percent" };

// The ONLY word with which the panel says "this selection does not have a single
// value" on a slider.
const MIXED_LABEL = "Mixed";

// The slider's value: what is READ and what is HEARD, from the
// same variable.
//
// Text and color fields, on MIXED, show EMPTY: "no single value"
// is drawn as nothing. A slider cannot -- it necessarily has a position, and
// its accessible value is a NUMBER: react-aria puts `aria-valuetext` on the
// `<input type=range>` taking it from the state, so the fallback value needed to give a position
// (1, that is "100%") would also be ANNOUNCED as if it were the real one.
// A screen reader would read "100%" on a selection that does not have a single opacity.
//
// The remedy is to own the attribute: `inputRef` is the public prop with which
// RAC gives access to exactly that input. It is written on EVERY render, without a
// dependency array: outside MIXED it rewrites what RAC had already computed
// (`getThumbValueLabel`, that is the same percentage as the displayed text), so
// a "Mixed" is never left hanging when the value comes back to exist -- React
// would not rewrite an attribute whose starting value has not changed.
// useLayoutEffect and not useEffect: the attribute is right before the browser
// paints, not a frame later.
function SliderValueText({
  inputRef, mixed, className,
}: { inputRef: RefObject<HTMLInputElement | null>; mixed: boolean; className: string }) {
  const state = useContext(SliderStateContext);
  const text = mixed ? MIXED_LABEL : (state?.getThumbValueLabel(0) ?? "");
  useLayoutEffect(() => {
    inputRef.current?.setAttribute("aria-valuetext", text);
  });
  return <SliderOutput className={className}>{text}</SliderOutput>;
}

// The opacity slider's track and thumb, with their EMPTY state:
// on `data-mixed` (put on the track, which is the `group`) they lose fill and
// solid border and stay a dashed outline, because there is no value to
// indicate. The thumb however stays there -- focusable, draggable and with its
// focus ring.
const SLIDER_RAIL_CLASS =
  "absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-3 " +
  "group-data-[mixed]:border group-data-[mixed]:border-dashed " +
  "group-data-[mixed]:border-line-strong group-data-[mixed]:bg-transparent";

// The track's FILLED part, from the left up to the thumb.
const SLIDER_FILL_CLASS =
  "absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent group-data-[mixed]:hidden";

const SLIDER_THUMB_CLASS =
  "top-1/2 size-3.5 rounded-full border-2 border-accent bg-surface shadow-sm outline-none " +
  "group-data-[mixed]:border-transparent group-data-[mixed]:bg-transparent group-data-[mixed]:shadow-none " +
  "data-[focus-visible]:shadow-[var(--ring)]";

// --- ALIGNMENT --------------------------------------------------------------
//
// The buttons are ICONS, as in every editor: eight labels written out in full
// would take half the panel and read worse than a pictogram. The
// NAME however stays the full one (`aria-label`, from the ALIGN_COMMANDS list)
// -- it is the only thing a screen reader reads, and it is also the
// tooltip's text: the same string in both channels, never two different wordings.
//
// The icons are drawn here and not imported: they are eight rectangles on a
// 24 grid, and a dependency for that would be more code, not less.
// `RULE`/`BAR` describe the two parts of every sign -- the line on which one
// aligns and the two blocks resting on it.
const RULE = "fill-fg-subtle";
const BAR = "fill-current";

// The rectangles of each icon, in SVG coordinates 0..24. For alignments:
// the line (1.5 thick) plus two blocks of different length resting on it --
// two equal blocks would not show which side they align to. For
// distributions: three blocks at equal distance, which is what the command does.
const ICONS: Record<AlignCommand, { x: number; y: number; w: number; h: number; rule?: boolean }[]> = {
  left: [
    { x: 2, y: 3, w: 1.5, h: 18, rule: true },
    { x: 5, y: 6, w: 14, h: 4 }, { x: 5, y: 14, w: 9, h: 4 },
  ],
  hcenter: [
    { x: 11.25, y: 3, w: 1.5, h: 18, rule: true },
    { x: 5, y: 6, w: 14, h: 4 }, { x: 7.5, y: 14, w: 9, h: 4 },
  ],
  right: [
    { x: 20.5, y: 3, w: 1.5, h: 18, rule: true },
    { x: 5, y: 6, w: 14, h: 4 }, { x: 10, y: 14, w: 9, h: 4 },
  ],
  "distribute-h": [
    { x: 3, y: 4, w: 3, h: 16 }, { x: 10.5, y: 4, w: 3, h: 16 }, { x: 18, y: 4, w: 3, h: 16 },
  ],
  top: [
    { x: 3, y: 2, w: 18, h: 1.5, rule: true },
    { x: 6, y: 5, w: 4, h: 14 }, { x: 14, y: 5, w: 4, h: 9 },
  ],
  middle: [
    { x: 3, y: 11.25, w: 18, h: 1.5, rule: true },
    { x: 6, y: 5, w: 4, h: 14 }, { x: 14, y: 7.5, w: 4, h: 9 },
  ],
  bottom: [
    { x: 3, y: 20.5, w: 18, h: 1.5, rule: true },
    { x: 6, y: 5, w: 4, h: 14 }, { x: 14, y: 10, w: 4, h: 9 },
  ],
  "distribute-v": [
    { x: 4, y: 3, w: 16, h: 3 }, { x: 4, y: 10.5, w: 16, h: 3 }, { x: 4, y: 18, w: 16, h: 3 },
  ],
};

// `aria-hidden`: the pictogram adds nothing to the button's name, which
// already comes from aria-label. Without it, a screen reader would announce an
// unnamed "image" next to the good label.
function AlignIcon({ id }: { id: AlignCommand }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      {ICONS[id].map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.rule ? 0.75 : 1} className={r.rule ? RULE : BAR} />
      ))}
    </svg>
  );
}

const ALIGN_BUTTON_CLASS =
  "flex h-7 flex-1 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-3 hover:text-fg " +
  "focus-visible:shadow-[var(--ring)] " +
  // Disabled: it TURNS OFF (no background on hover, faded pictogram),
  // which is the sign saying "there is not enough selection for this command".
  "disabled:opacity-40 disabled:hover:bg-transparent";

// --- INSTANCE OVERRIDES (M4) ------------------------------------------------
//
// When the selection is a SINGLE instance, the panel shows an "Override"
// section: one row for every node of the MASTER that is a text or has a
// fill (subtree from components[componentId].rootNodeId, in
// pre-order). Every row shows the EFFECTIVE value -- the instance's override
// for that master node if there is one, otherwise the master node's own
// value -- and writing into it emits ONE SetInstanceOverride.
//
// The two halves of the override (fills and text) are INDEPENDENT: editing one
// keeps the other as it was (see InstanceOverrideLite), otherwise a
// text-only override would reset the inherited fill. "Reset" emits an
// EMPTY override, which for the reducer is the REMOVAL (the node goes back to
// inheriting from the master).

// Text field for the content of a master text node. Twin (simpler)
// of RenameField/PageRenameField: the session has its own state (the typed
// text) that restarts when the value changes from outside -- commit
// succeeded, or selection change. Commits on Enter or blur, only
// once.
function OverrideTextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  useEffect(() => {
    setDraft(value);
    done.current = false;
  }, [value]);
  function settle() {
    if (done.current) return;
    done.current = true;
    // No op if the text has not changed: an override "that changes nothing"
    // would cost a network round trip and an empty undo entry.
    if (draft !== value) onCommit(draft);
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[11px] font-medium text-fg-subtle">{label}</span>
      <input
        aria-label={label}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={settle}
        onKeyDown={(e) => {
          // No key leaves here: global shortcuts (undo/redo on
          // window, Escape/Delete on toolManager) must not act while
          // typing -- same stop as LayersPanel/PageBar::RenameField.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            settle();
          }
        }}
        className={cls.input}
      />
    </div>
  );
}

export function PropertiesPanel() {
  // The values the panel shows are the ones that are seen: with the timeline
  // posed (scrubbing, recording) they are the sampled values. With the timeline idle it is
  // the store's scene, the same instance as before (animation/posedScene.ts).
  const scene = usePosedScene();
  const selection = useScene((s) => s.selection);
  const summary = scene ? selectionSummary(scene, selection) : null;
  const nodes = scene ? selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined) : [];
  // The text controls show what is DRAWN: a shared text style overrides the node's own.
  const style = summary?.kind === "text" && scene
    ? textStyleSummary(nodes.map((n) => (n.text ? { ...n, text: { ...n.text, style: effectiveStyle(scene, n) ?? n.text.style } } : n)))
    : null;
  // The opacity slider's hidden input: SliderValueText writes the ANNOUNCED
  // value into it. It sits here, before any early return, because it is a
  // hook.
  const opacityInputRef = useRef<HTMLInputElement>(null);

  // Typing + confirming (Enter or blur, inside NumberField): ONE gesture whose final
  // ops assign the same value to every selected node -- a single
  // undo entry even for a multiple selection.
  function commit(field: NumericField, value: number) {
    const store = useScene.getState();
    const ids = store.selection;
    if (ids.length === 0) return;
    store.beginGesture();
    store.endGesture(numericOps(ids, field, value));
  }

  // Label drag: the FIRST call opens the gesture (lazy,
  // like dragStarted in tools/selectTool.ts -- a click that NumberField did not
  // promote to a drag never gets here), the following ones are only a
  // local preview -- nothing on the wire until the pointer is released.
  function scrub(field: NumericField, value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of numericOps(store.selection, field, value)) store.applyLocal(op);
  }

  // Drag release: closes the SAME gesture opened by scrub with
  // the FINAL ops -- same shape as selectTool.ts::onPointerUp for the move
  // drag (a single send, not one per preview pixel).
  function scrubEnd(field: NumericField, value: number) {
    const store = useScene.getState();
    if (!store.gesture) return; // scrub did not start (selection emptied mid-drag)
    store.endGesture(numericOps(store.selection, field, value));
  }

  // A whole gesture from a single confirmation (color, weight, alignment):
  // same shape as the visibility toggle in ui/LayersPanel.tsx.
  function runGesture(build: (ids: readonly string[]) => Op[]) {
    const store = useScene.getState();
    const ids = store.selection;
    if (ids.length === 0) return;
    const ops = build(ids);
    if (ops.length === 0) return;
    store.beginGesture();
    store.endGesture(ops);
  }

  // --- OVERRIDE (M4) --------------------------------------------------------
  // The handlers re-read the FRESH instance from the store: an op in the meantime
  // (or a remote record) may have changed it, and the render closure would be
  // stale. null if the selection is no longer exactly one instance.
  function currentInstance(): NodeLite | null {
    const store = useScene.getState();
    const s = store.scene;
    if (!s || store.selection.length !== 1) return null;
    const n = s.nodes.at(store.selection[0]);
    return n && n.kind === "instance" && n.instance ? n : null;
  }

  // One override = ONE gesture, like every other panel write.
  function commitOverride(inst: NodeLite, override: InstanceOverrideLite) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetInstanceOverrideOp(inst.id, override)]);
  }

  // Edits the effective FILL of a master node. It starts from the effective fills
  // (override if there is one, otherwise the master's) and replaces only
  // the FIRST, keeping alpha and the rest of the list -- like fillOps for real
  // nodes. It keeps the override's text if there was one.
  function editOverrideFill(masterNodeId: string, rgb: RgbLite) {
    const store = useScene.getState();
    const s = store.scene;
    const inst = currentInstance();
    if (!s || !inst) return;
    const master = s.nodes.at(masterNodeId);
    if (!master) return;
    const existing = instanceOverrideMap(s, inst).get(masterNodeId);
    const effFills = existing?.fills ?? master.fills;
    const first: FillLite = { ...rgb, a: effFills[0]?.a ?? 1 };
    const override: InstanceOverrideLite = { masterNodeId, fills: [first, ...effFills.slice(1)] };
    if (existing?.text !== undefined) override.text = existing.text;
    commitOverride(inst, override);
  }

  // Edits the effective CONTENT of a master text node. It keeps the
  // override's fills if there were any.
  function editOverrideText(masterNodeId: string, text: string) {
    const inst = currentInstance();
    const scn = useScene.getState().scene;
    if (!inst || !scn) return;
    const existing = instanceOverrideMap(scn, inst).get(masterNodeId);
    const override: InstanceOverrideLite = { masterNodeId, text };
    if (existing?.fills !== undefined) override.fills = existing.fills;
    commitOverride(inst, override);
  }

  // Resets a master node: EMPTY override = removal (goes back to inheriting).
  function resetOverride(masterNodeId: string) {
    const inst = currentInstance();
    if (!inst) return;
    commitOverride(inst, { masterNodeId });
  }

  // OPACITY. react-aria-components' slider tells apart on its own the two phases
  // we need: onChange at every drag step (preview) and
  // onChangeEnd on release (final value) -- the same two channels
  // NumberField calls onScrub/onScrubEnd. The gesture opens LAZILY on the first
  // onChange, so a click on the slider that does not move it opens none.
  function scrubOpacity(value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of opacityOps(store.selection, value)) store.applyLocal(op);
  }

  function scrubOpacityEnd(value: number) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(opacityOps(store.selection, value));
  }

  // The same two phases for the stroke's WEIGHT: it is dragged like any other
  // numeric field, but the op rebuilds the strokes list instead of writing
  // a field (see strokeOps).
  function scrubStroke(patch: StrokePatch) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of strokeOps(store.selection, patch)) store.applyLocal(op);
  }

  function scrubStrokeEnd(patch: StrokePatch) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(strokeOps(store.selection, patch));
  }

  // The same two phases for the text SIZE, which is dragged like any
  // other numeric field but emits SetText instead of SetProperties.
  function scrubTextStyle(patch: Partial<TextStyleLite>) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of textStyleOps(store.selection, patch)) store.applyLocal(op);
  }

  function scrubTextStyleEnd(patch: Partial<TextStyleLite>) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(textStyleOps(store.selection, patch));
  }

  if (!summary) {
    return (
      <div className="flex h-full flex-col bg-surface text-[13px] text-fg">
        {/* The title stays even when empty: it says WHERE you are, like the header
            of the other panels, when there is no name to show. */}
        <header className="flex h-12 shrink-0 items-center border-b border-line px-3">
          <h2 className={cls.sectionTitle}>Properties</h2>
        </header>
        <EmptyState
          icon="select"
          title="No selection"
          hint="Select an element on the canvas or in the layers to read and edit its properties."
        />
      </div>
    );
  }

  const opacity: number | Mixed = summary.opacity;
  const fill = summary.fills === MIXED ? null : (summary.fills[0] ?? null);
  // The selection's FIRST stroke, or null if there is no single value to
  // show (mixed selection). A node without strokes is not "mixed": it is a stroke
  // that is not there, and reads as empty color + weight 0 + position at the
  // center -- the state from which writing any field creates one.
  const stroke = summary.strokes === MIXED ? null : (summary.strokes[0] ?? null);
  const strokesMixed = summary.strokes === MIXED;
  // A color bound to a variable shows (read-only) what the variable resolves to,
  // which is what the canvas draws: editing the literal underneath would change
  // nothing visible. Detaching is done in the Variables section.
  const boundFill = scene ? boundColor(scene, nodes, "fills.0") : undefined;
  const boundStroke = scene ? boundColor(scene, nodes, "strokes.0") : undefined;

  // W/H disappear as soon as ONE selected node is a group, not only when all
  // are (`summary.kind === "group"`): the field writes the same value
  // on EVERY node of the selection, so in a mixed selection the op would reach
  // the group anyway. And the number shown would already be a lie -- the group's
  // zeros enter the summary and make it "Mixed" even when every real
  // shape has the same width.
  //
  // X/Y instead STAY, and for a group they mean what they mean for
  // all the others: the top-left corner of the frame (see
  // selectionSummary and positionValueFor).
  const geometryFields = nodes.some((n) => n.kind === "group") ? POSITION_FIELDS : GEOMETRY_FIELDS;

  // The Override section appears only for a SINGLE selected instance. Its
  // rows are the MASTER's nodes (subtree from the component's root, in
  // pre-order) that are a text or have a fill -- the only
  // overridable ones in M4. `overrideMap` indexes the instance's current overrides
  // by masterNodeId, to read each row's effective value.
  const instanceNode = nodes.length === 1 && nodes[0].kind === "instance" && nodes[0].instance ? nodes[0] : null;
  const overrideMap = instanceNode && scene ? instanceOverrideMap(scene, instanceNode) : new Map<string, InstanceOverrideLite>();
  const master = instanceNode && scene ? scene.components[effectiveComponentId(scene, instanceNode.instance!)] : undefined;
  const overrideRows: NodeLite[] =
    master && scene ? subtreeOf(scene, master.rootNodeId).filter((n) => n.kind === "text" || n.fills.length > 0) : [];

  // The header: WHO is selected. A single node = its name and its type;
  // more nodes = the count and the common type (if any).
  const headerIcon: IconName = summary.kind === MIXED || nodes.length > 1 ? "layers" : KIND_ICON[summary.kind];
  const headerTitle = nodes.length === 1 ? layerDisplayName(nodes[0]) : `${nodes.length} elements`;
  const headerHint =
    nodes.length > 1
      ? (summary.kind === MIXED ? "Multiple selection" : `Multiple selection · ${KIND_LABEL[summary.kind]}`)
      : (summary.kind === MIXED ? "" : KIND_LABEL[summary.kind]);

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface text-[13px] text-fg">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Icon name={headerIcon} size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight">{headerTitle}</p>
          {headerHint && <p className="truncate text-[11px] leading-tight text-fg-subtle">{headerHint}</p>}
        </div>
      </header>

      {/* ALIGNMENT. It sits with the geometry (it is geometry: it moves x/y and
          nothing else) and before the appearance. Every button is ONE gesture, so ONE
          undo entry, even when it moves ten nodes -- see
          selection/align.ts::alignSelection. The reference is ALWAYS the selection's
          common bounding box: there is no page to align against
          (see the comment on alignTarget). A single bar, with a thread between the
          four horizontal and the four vertical ones. */}
      {/* With a SINGLE node every command is disabled (the reference is the
          selection's common bounding box): the bar appears from two nodes up and
          at rest does not steal 40px from the inspector. */}
      {selection.length >= 2 && (
      <div role="group" aria-label="Align" className="flex shrink-0 items-center gap-0.5 border-b border-line px-2 py-1.5">
        {ALIGN_COMMANDS.map((c, i) => (
          <Fragment key={c.id}>
            {i === 4 && <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-line" />}
            {/* native <button> and not react-aria's Button (which here brings
                nothing extra and does not accept `title`): for a pictogram the
                tooltip is the only way a SIGHTED user has to read the
                command's name, and it must be the SAME text as the accessible
                name -- otherwise they are two interfaces.

                DISABLED below the minimum number of nodes the command requires
                (two to align, three to distribute): below that threshold the
                common bounding box coincides with the selection and there is nothing to
                do. A live button that does nothing is indistinguishable from a
                broken one. */}
            <button
              type="button"
              aria-label={c.label}
              title={c.label}
              disabled={selection.length < minSelection(c.id)}
              className={ALIGN_BUTTON_CLASS}
              onClick={() => alignSelection(c.id)}
            >
              <AlignIcon id={c.id} />
            </button>
          </Fragment>
        ))}
      </div>
      )}

      {/* BOOLEAN operations on two or more shapes: they replace the selection by one vector. */}
      <BooleanControls />

      {/* LAYOUT: position, size, rotation and (rectangles) radius, in a
          two-column grid of fields with the prefix INSIDE (X, Y, W, H, °, R). */}
      <Section title="Layout">
        <div className="grid grid-cols-2 gap-1.5">
          {geometryFields.map((field) => (
            <NumberField
              key={field.key}
              label={field.label}
              glyph={field.glyph}
              minValue={field.minValue}
              // MIXED (multiple selection with different values) becomes NaN:
              // NumberField shows it empty and does not make a
              // controlled/uncontrolled switch of it (see the comment on its
              // `value` prop). The "Mixed" placeholder goes ONLY in that case:
              // an empty field with no other context would look emptied by
              // mistake, not "these nodes differ".
              value={summary[field.key] === MIXED ? NaN : (summary[field.key] as number)}
              placeholder={summary[field.key] === MIXED ? MIXED_LABEL : undefined}
              onCommit={(v) => commit(field, v)}
              onScrub={(v) => scrub(field, v)}
              onScrubEnd={(v) => scrubEnd(field, v)}
            />
          ))}
          {/* ONLY for rectangles: corner_radius lives inside RectNode, and on
              an ellipse or a text the op would be rejected by both
              implementations of apply (ErrNotRectNode). A MIXED selection has
              kind === MIXED, so it does not show the field -- there is no radius to
              write that holds for all. */}
          {summary.kind === "rect" && (
            <NumberField
              label={CORNER_RADIUS_FIELD.label}
              minValue={CORNER_RADIUS_FIELD.minValue}
              value={summary.cornerRadius === MIXED ? NaN : (summary.cornerRadius as number)}
              placeholder={summary.cornerRadius === MIXED ? MIXED_LABEL : undefined}
              onCommit={(v) => commit(CORNER_RADIUS_FIELD, v)}
              onScrub={(v) => scrub(CORNER_RADIUS_FIELD, v)}
              onScrubEnd={(v) => scrubEnd(CORNER_RADIUS_FIELD, v)}
            />
          )}
        </div>
      </Section>

      {/* AUTO LAYOUT: for a frame, its controls; for any other
          selection, the "+" that wraps it in a frame with auto layout. */}
      {summary.kind === "frame" ? <AutoLayoutControls run={runGesture} /> : <WrapInAutoLayoutButton />}

      {/* CONSTRAINTS (in a plain frame) or SIZING (in an auto layout frame): the relation to the parent. */}
      <LayoutRelationControls />

      <Section title="Appearance">
        <Slider
          // On MIXED the number below is only the keyboard and drag
          // STARTING POINT: it is not drawn (the slider shows
          // empty, see data-mixed) and it is not announced (see
          // SliderValueText). The slider stays usable -- moving it assigns the
          // same opacity to the whole selection, exactly as a mixed
          // geometric field accepts a typed value -- and as soon as a value
          // exists, "mixed" disappears from both channels.
          value={opacity === MIXED ? 1 : opacity}
          minValue={0}
          maxValue={1}
          // 1% is the step at which opacity reads as a whole percentage;
          // no invisible rounding below that threshold.
          step={0.01}
          // The percentage is formatted by the STATE, not by the panel: it is the same
          // string that ends up in the displayed text and in `aria-valuetext`. With
          // the by-hand calculation from before "40%" was seen and "0.4" announced.
          formatOptions={PERCENT_FORMAT}
          onChange={scrubOpacity}
          onChangeEnd={scrubOpacityEnd}
          // An inset row like the numeric fields: label, slider, value.
          className="flex h-7 items-center gap-2 rounded-md bg-surface-2 pl-2 pr-1.5"
        >
          <Label className="w-12 shrink-0 select-none text-[11px] font-medium text-fg-subtle">Opacity</Label>
          <SliderTrack
            // "Mixed" is a STATE of the control, not just a text: it sits in the DOM
            // on the track (which contains both the rail and the thumb) and from there
            // the CSS empties both. One attribute and not two computed
            // classNames: the same shape as the `data-*` that RAC itself exposes
            // (data-selected, data-focus-visible).
            data-mixed={opacity === MIXED || undefined}
            className="group relative h-4 min-w-0 flex-1"
          >
            {({ state }) => (
              <>
                {/* The drawn rail is a child of the track and not the track
                    itself: the track must stay tall enough to be
                    grabbed with a finger, the colored line thin enough to
                    read as a slider. The filled part reaches the
                    thumb. */}
                <div className={SLIDER_RAIL_CLASS} />
                <div className={SLIDER_FILL_CLASS} style={{ width: `${state.getThumbPercent(0) * 100}%` }} />
                <SliderThumb inputRef={opacityInputRef} className={SLIDER_THUMB_CLASS} />
              </>
            )}
          </SliderTrack>
          <SliderValueText
            inputRef={opacityInputRef}
            mixed={opacity === MIXED}
            className="w-10 shrink-0 text-right text-[12px] tabular-nums text-fg-muted"
          />
        </Slider>
      </Section>

      {/* For text nodes the panel shows the style controls: they are
          the equivalent of the radius for a rectangle -- the properties that kind of
          node has and the others do not. They emit SetText (with style_present),
          not SetProperties: the style lives inside the `shape` oneof. */}
      {style && (
        <Section title="Text">
          <div className="flex flex-col gap-2">
            <NumberField
              label="Size"
              minValue={1}
              value={style.fontSize === MIXED ? NaN : (style.fontSize as number)}
              placeholder={style.fontSize === MIXED ? MIXED_LABEL : undefined}
              onCommit={(v) => runGesture((ids) => textStyleOps(ids, { fontSize: v }))}
              onScrub={(v) => scrubTextStyle({ fontSize: v })}
              onScrubEnd={(v) => scrubTextStyleEnd({ fontSize: v })}
            />
            <SegRadio
              label="Weight" showLabel={false}
              value={radioValue(style.fontWeight)}
              options={FONT_WEIGHTS}
              onChange={(v) => runGesture((ids) => textStyleOps(ids, { fontWeight: v }))}
            />
            <SegRadio
              label="Alignment" showLabel={false}
              value={radioValue(style.align)}
              options={ALIGNMENTS}
              // The cast is safe by construction: the only values in the group
              // are those of ALIGNMENTS, which is typed TextAlignLite.
              onChange={(v) => runGesture((ids) => textStyleOps(ids, { align: v as TextAlignLite }))}
            />
            <TypographyControls />
          </div>
        </Section>
      )}

      {/* THE FILL: the type (solid / linear / radial) and below the color,
          or the gradient preview with its ends. */}
      <Section title="Fill">
        {summary.fills !== MIXED ? (
          <GradientControls
            fill={fill}
            run={runGesture}
            // With a gradient the single color does not exist: writing it
            // would flatten the gradient without the user having asked for it. The
            // stops are edited in GradientControls.
            solid={
              <ColorField
                label="Fill"
                // Node without tints: null, that is "no single value to
                // show". Writing a color from there stays possible and
                // assigns it to the whole selection, as for geometric fields.
                value={boundFill !== undefined ? boundFill : fill}
                placeholder={boundFill === null ? "Variables" : "None"}
                isDisabled={boundFill !== undefined}
                onCommit={(rgb) => runGesture((ids) => fillOps(ids, rgb))}
              />
            }
          />
        ) : (
          <ColorField
            label="Fill"
            // MIXED: no single value to show, but writing a color
            // stays possible.
            value={null}
            placeholder={MIXED_LABEL}
            onCommit={(rgb) => runGesture((ids) => fillOps(ids, rgb))}
          />
        )}
      </Section>

      {/* THE STROKE. Its own section and not inside "Appearance": they are three controls
          describing a SINGLE thing (the node's stroke), and mixing them with the
          fill would make it ambiguous which of the two the color belongs to.
          It applies to EVERY shape -- `strokes` is a top-level field of the Node,
          not a field inside the `shape` oneof like corner_radius -- so the
          section is always there, text included. */}
      <Section title="Stroke">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_7.5rem] gap-1.5">
            <ColorField
              label="Stroke"
              // Like the fill: null on MIXED or on "no stroke". Writing
              // a color stays possible in both cases -- and it is the way
              // a stroke is CREATED (see DEFAULT_STROKE).
              value={boundStroke !== undefined ? boundStroke : (stroke?.color ?? null)}
              isDisabled={boundStroke !== undefined}
              placeholder={boundStroke === null ? "Variables" : strokesMixed ? MIXED_LABEL : "None"}
              // The color goes down BARE, without alpha: strokeOps puts it back
              // taking it from each node's stroke, exactly like
              // fillOps. Composing it here from `stroke` would read it from the SUMMARY
              // of the selection -- which on different strokes is null -- and
              // would rewrite 1 on all.
              onCommit={(rgb) => runGesture((ids) => strokeOps(ids, { color: rgb }))}
            />
            <NumberField
              label="Thickness"
              // No stroke = weight 0, and 0 stays writable: it is the way to
              // turn off a stroke without removing it from the list (non-positive
              // weight = nothing drawn and no overhang in the bounds,
              // see canvas/geometry.ts::strokeOutset).
              minValue={0}
              value={strokesMixed ? NaN : (stroke?.weight ?? 0)}
              placeholder={strokesMixed ? MIXED_LABEL : undefined}
              onCommit={(v) => runGesture((ids) => strokeOps(ids, { weight: v }))}
              onScrub={(v) => scrubStroke({ weight: v })}
              onScrubEnd={(v) => scrubStrokeEnd({ weight: v })}
            />
          </div>
          <SegRadio
            label="Position" showLabel={false}
            // On MIXED no choice selected (null, like for the text
            // weights); on a node without strokes the default is shown, which is also
            // the one that would be written.
            value={strokesMixed ? null : (stroke?.align ?? DEFAULT_STROKE.align)}
            options={STROKE_ALIGNMENTS}
            onChange={(v) => runGesture((ids) => strokeOps(ids, { align: v as StrokeAlignLite }))}
          />
          {/* A stroke can carry a gradient too: the same controls, aimed at the stroke's paint. */}
          {stroke && !strokesMixed && <GradientControls fill={stroke.color} run={runGesture} target="stroke" />}
          {stroke && !strokesMixed && stroke.weight > 0 && <StrokeStyleControls run={runGesture} />}
        </div>
      </Section>

      {/* LAYOUT GRIDS of a single selected frame (renders nothing otherwise). */}
      <LayoutGridControls run={runGesture} />

      {/* THE EFFECTS: shadow and blur. Its own section like the stroke: they are
          controls of a different nature than the basic appearance. */}
      <EffectsControls run={runGesture} />

      {/* VARIANTS and PROPERTIES of a single selected instance (renders nothing otherwise). */}
      <InstanceControls />

      {/* OVERRIDE: only for a SINGLE selected instance. Every row is a node
          of the master (text or with a fill) with its EFFECTIVE value and a
          "Reset" -- see the comment on OverrideTextField. */}
      {instanceNode && (
        <Section title="Override">
          <div className="flex flex-col gap-2">
            {overrideRows.length === 0 ? (
              <p className="text-[12px] text-fg-subtle">No overridable elements</p>
            ) : (
              overrideRows.map((mn) => {
                const name = layerDisplayName(mn);
                const ov = overrideMap.get(mn.id);
                return (
                  <div key={mn.id} className="flex items-end gap-1">
                    <div className="min-w-0 flex-1">
                      {mn.kind === "text" ? (
                        <OverrideTextField
                          label={name}
                          // Effective value: the override's text if there is one,
                          // otherwise the master node's content.
                          value={ov?.text ?? mn.text?.content ?? ""}
                          onCommit={(v) => editOverrideText(mn.id, v)}
                        />
                      ) : (
                        <ColorField
                          label={name}
                          showLabel
                          // Effective value: the override's first fill if there is one,
                          // otherwise the master's.
                          value={(ov?.fills ?? mn.fills)[0] ?? null}
                          onCommit={(rgb) => editOverrideFill(mn.id, rgb)}
                        />
                      )}
                    </div>
                    {/* Reset: only when there is really an override to
                        remove. Emitting a removal where there is nothing
                        would cost an op and an empty undo entry. */}
                    <IconButton
                      icon="rotate"
                      label={`Reset ${name}`}
                      isDisabled={ov === undefined}
                      onPress={() => resetOverride(mn.id)}
                    />
                  </div>
                );
              })
            )}
          </div>
        </Section>
      )}

      {/* EXPORT: it sits here because this branch of the panel exists only with a
          non-empty selection (see the early return on `!summary` further
          up) -- it is the same condition that used to live in the ToolDock's
          button as the "Scope" radio, now made superfluous by moving the
          control inside the branch that already guarantees it. */}
      <VariablesSection />

      <Section title="Export">
        <ExportSection />
      </Section>
    </div>
  );
}
