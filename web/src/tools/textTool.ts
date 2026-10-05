import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { normalizeRect } from "../canvas/geometry";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { toPbTextStyle } from "../store/types";
import type { TextStyleLite } from "../store/types";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
} from "../renderer/text";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext } from "./types";

// Same threshold as shapeTool.ts (SCREEN px, independent of zoom): below it,
// a drag is a click.
const CLICK_SLOP_PX = 3;

export const DEFAULT_TEXT_WIDTH = 200;
// A single line at the default size, derived from the same defaults of the
// renderer (renderer/text.ts) instead of a magic number duplicated here: if
// those defaults change, the tool's initial box stays consistent without
// having to touch this file.
export const DEFAULT_TEXT_HEIGHT = DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT;

// The style EVERY text node is born with: explicit, not the zeros that
// TextStyleLite tolerates elsewhere (store/types.ts keeps them on purpose to
// stay indistinguishable from core.Apply until a SetText touches them). A
// freshly created node never went through a SetText with style_present, so it
// must already read with the right font before the user even types a
// letter.
const DEFAULT_TEXT_STYLE: TextStyleLite = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  fontWeight: DEFAULT_FONT_WEIGHT,
  lineHeight: DEFAULT_LINE_HEIGHT,
  align: "left",
};

// Solid black: without an explicit fill the node would fall back to the 0.8 gray
// shared with shapes (renderer/canvasRenderer.ts::cssColor) -- unreadable
// for text. See Task 3, divergence 7.
const DEFAULT_TEXT_FILL = {
  kind: { case: "solid" as const, value: { color: { r: 0, g: 0, b: 0, a: 1 } } },
};

// The text tool ONLY creates (like rectTool/ellipseTool), but does not reuse
// makeShapeTool: a text node is not "a shape with a different shape" -- it is born
// with empty content, an explicit style, and above all it enters editing RIGHT
// after creation, which no shape tool does. The down/move/up gesture with
// click threshold is still the same pattern, written out in full
// here instead of forcing it into the shared abstraction (see the comment in
// shapeTool.ts about the >80% literally identical code that would
// otherwise justify reuse).
export function createTextTool(): Tool {
  let anchor: { x: number; y: number } | null = null;

  // The preview reuses the store's marquee rectangle, like shapeTool:
  // it is already in world coordinates and is already drawn by the overlay.
  const preview = (b: { x: number; y: number; width: number; height: number } | null) =>
    useScene.getState().setMarquee(b);

  return {
    id: "text",
    cursor: "text",

    onPointerDown(e, ctx) {
      anchor = ctx.toWorld(e);
      preview({ ...anchor, width: 0, height: 0 });
    },

    onPointerMove(e, ctx) {
      if (!anchor) return;
      const p = ctx.toWorld(e);
      preview(normalizeRect(anchor.x, anchor.y, p.x, p.y));
    },

    onPointerUp(e, ctx) {
      if (!anchor) return;
      const p = ctx.toWorld(e);
      const box = normalizeRect(anchor.x, anchor.y, p.x, p.y);
      anchor = null;
      preview(null);

      // screen px -> world units (like shapeTool): below the threshold it is a click,
      // not a drag, regardless of zoom.
      const slop = CLICK_SLOP_PX / ctx.getCamera().zoom;
      // A click uses the default size; a drag uses the dragged
      // dimensions -- the width becomes the wrap width (Task 3:
      // layoutText uses it as maxWidth). With empty content the layout
      // still produces height 0 until something is typed, but the box height
      // remains a sensible starting point for the handles.
      const width = box.width < slop ? DEFAULT_TEXT_WIDTH : box.width;
      const height = box.height < slop ? DEFAULT_TEXT_HEIGHT : box.height;

      const id = uuid();
      // `box` is WORLD and the model wants coordinates relative to the PARENT: here
      // they coincide because the parent is a page (identity). Same note as
      // shapeTool.ts -- creating inside a container will require a worldToLocal.
      // The parent is the CURRENT PAGE (store view state): the text
      // is born on the page being viewed, not on a fixed "page1".
      const node = create(NodeSchema, {
        id,
        parentId: useScene.getState().currentPageId ?? "page1",
        orderKey: nextOrderKey(ctx.getScene()),
        name: "Text",
        visible: true,
        opacity: 1,
        x: box.x,
        y: box.y,
        width,
        height,
        fills: [DEFAULT_TEXT_FILL],
        shape: { case: "text", value: { content: "", style: toPbTextStyle(DEFAULT_TEXT_STYLE) } },
      });

      const store = useScene.getState();

      // Closes any previous editing session BEFORE opening the
      // creation gesture. store.beginTextEditing would close it anyway on its
      // own (guard in the store, for every caller), but it would do so AFTER --
      // and the order matters, because each close may delete a node left
      // empty, i.e. may leave an undo entry. Closing afterwards, the stack
      // would become [create t1, create t2, delete t1]: the first Ctrl+Z
      // would RESURRECT the empty node t1 instead of undoing the creation
      // just made. Closing here the order is the user's chronological one
      // ([create t1, delete t1, create t2]) and Ctrl+Z always undoes the last thing
      // seen. The order key is still derived from the scene BEFORE the
      // cleanup (node is already built): a deleted id does not free its
      // key for the next node.
      store.endTextEditing();

      // Creation = one gesture (one undo entry), like every other tool. The
      // node is selected IMMEDIATELY, with the gesture still open: the store reconciles
      // the selection against the FINAL scene at endGesture (store.ts), so
      // it can refer to an id that exists only after the final op (the same
      // mechanism described in the endGesture comment).
      store.beginGesture();
      store.setSelection([id]);
      store.endGesture([makeCreateNodeOp(node)]);

      // Enters editing IMMEDIATELY (per the brief): different from
      // rect/ellipse, which remain creation-only tools. The actual editing
      // session -- ITS gesture, the overlaid textarea -- belongs to
      // Task 5: here only the flag that tells it which node is turned on.
      store.beginTextEditing(id);
    },

    // Abandoned gesture (tool change, pointercancel, unmount): no op,
    // no editing.
    onDeactivate(_ctx: ToolContext) {
      if (!anchor) return;
      anchor = null;
      preview(null);
    },
  };
}

export const textTool = createTextTool();
