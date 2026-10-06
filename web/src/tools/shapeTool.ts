import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { normalizeRect } from "../canvas/geometry";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext, ToolId } from "./types";

// Under this threshold (SCREEN px, hence independent of zoom) a drag is
// considered a click: without a threshold, at high zoom a half-pixel jitter
// would create a shape 0.008 world units wide, invisible and ungraspable.
const CLICK_SLOP_PX = 3;

export interface ShapeToolConfig {
  id: ToolId;
  name: string;
  defaultWidth: number;
  defaultHeight: number;
  // A function, not a shared object: each gesture must receive a fresh
  // init, so create() never receives the same reference twice.
  shape: () => MessageInitShape<typeof NodeSchema>["shape"];
  // The starting fill color. Absent = the shape gray.
  // A frame instead starts transparent-white: it is a container, not a shape.
  fill?: { r: number; g: number; b: number; a: number } | null;
}

// rectTool and ellipseTool are the same creation gesture (down/move/up,
// click threshold, preview via the store marquee, abandon on deactivate):
// the only real difference between the two is the emitted shape, isolated here in
// ShapeToolConfig. If a third shape tool stopped fitting in here with
// >80% of literally identical code, it should be written by hand.
export function makeShapeTool(config: ShapeToolConfig): Tool {
  let anchor: { x: number; y: number } | null = null;

  // The preview reuses the store's marquee rectangle: it is already in
  // world coordinates and is already drawn by the overlay, so there is no need for a
  // second channel just for creation feedback.
  const preview = (b: { x: number; y: number; width: number; height: number } | null) =>
    useScene.getState().setMarquee(b);

  return {
    id: config.id,
    cursor: "crosshair",

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

      const slop = CLICK_SLOP_PX / ctx.getCamera().zoom; // screen px -> world units
      const width = box.width < slop ? config.defaultWidth : box.width;
      const height = box.height < slop ? config.defaultHeight : box.height;

      // `box` is in WORLD coordinates and goes into the node as is. The model
      // coordinates are relative to the PARENT (canvas/transform.ts) and
      // here the parent is a PAGE, which contributes the identity: the two things
      // coincide. The day it becomes possible to draw INSIDE a container,
      // the box must first be brought into that container's local space
      // (transform.ts::worldToLocal).
      //
      // The parent is the CURRENT PAGE (store view state), not a fixed
      // "page1": drawing while on another page creates the node there.
      // The fallback to "page1" only covers the case -- unreachable with an installed
      // scene -- in which currentPageId has not yet been resolved.
      const node = create(NodeSchema, {
        id: uuid(),
        parentId: useScene.getState().currentPageId ?? "page1",
        orderKey: nextOrderKey(ctx.getScene()),
        name: config.name,
        visible: true,
        opacity: 1,
        x: box.x,
        y: box.y,
        width,
        height,
        fills: config.fill === null
          ? []
          : [{ kind: { case: "solid", value: { color: config.fill ?? { r: 0.6, g: 0.6, b: 0.65, a: 1 } } } }],
        shape: config.shape(),
      });
      // Creation goes through the gesture cycle like ANY other change
      // (move, resize, delete): beginGesture + endGesture with the single final op.
      // It is not a formality -- the undo entry is built ONLY
      // inside endGesture (store.ts), so a direct submit here would make
      // drawing the only non-undoable action of the editor. A one-op
      // gesture is still ONE op on the wire: endGesture submits
      // exactly finalOps.
      const store = useScene.getState();
      store.beginGesture();
      store.endGesture([makeCreateNodeOp(node)]);
    },

    // Abandoned gesture (tool change, pointercancel, unmount): no op.
    onDeactivate(_ctx: ToolContext) {
      if (!anchor) return;
      anchor = null;
      preview(null);
    },
  };
}
