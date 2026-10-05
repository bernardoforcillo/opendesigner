import { zoomAt } from "../canvas/camera";
import { handTool } from "./handTool";
import type { Tool, ToolContext } from "./types";

// client -> CANVAS px (CSS). It is the only place that subtracts the canvas origin;
// from there on you always go through canvas/camera.ts to get to the world.
export function eventToCanvasPoint(
  canvas: HTMLCanvasElement,
  e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// Wheel normalization: deltaMode says whether the delta is in pixels (0),
// lines (1) or pages (2) -- Firefox uses lines. Trackpad pinch arrives
// as a wheel with ctrlKey=true and very small deltas, so it has a higher
// gain. The delta -> factor map is exponential so N notches give the same
// zoom ratio regardless of the starting point.
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 400;
const WHEEL_GAIN = 0.0015;
const PINCH_GAIN = 0.01;
const MAX_FACTOR = 4;

export function wheelZoomFactor(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? PIXELS_PER_LINE : e.deltaMode === 2 ? PIXELS_PER_PAGE : 1;
  const gain = e.ctrlKey ? PINCH_GAIN : WHEEL_GAIN;
  const factor = Math.exp(-e.deltaY * unit * gain);
  // A single event must not be able to burn through the whole zoom range (some
  // drivers/OSes emit huge deltas).
  return Math.min(MAX_FACTOR, Math.max(1 / MAX_FACTOR, factor));
}

// A text field: input, textarea, select, contentEditable. Duck-typing
// instead of instanceof: tests run without HTMLElement, and the target of a
// synthetic event is never a real element.
// Exported because every global key channel needs the SAME
// guard (the clipboard shortcuts, tools/clipboard.ts): two copies that
// diverge would mean one shortcut stealing keys from a text
// field and the other not.
export function isTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Elements for which space is their own business: text fields (it must type a
// space) and activatable controls like the toolbar buttons (space
// presses them). Stealing it from them for the pan would give double activation or eaten text.
// The former are already covered by the general guard in onKeyDown; these two tags
// are not -- a button is not a text field, but space remains its own.
function swallowsSpace(target: EventTarget | null): boolean {
  if (isTextField(target)) return true;
  const el = target as { tagName?: string } | null;
  const tag = el?.tagName?.toUpperCase();
  return tag === "BUTTON" || tag === "A";
}

const MOUSE_LEFT = 0;
const MOUSE_MIDDLE = 1;

// Connects the canvas events to the active tool. The active tool is read by
// getActive on every event (not captured once), so the toolbar can
// change it without re-attaching the listeners.
export function attachTools(ctx: ToolContext, getActive: () => Tool): () => void {
  const { canvas } = ctx;
  // Temporarily replaces the active tool: space held or middle
  // mouse button => hand.
  let temp: Tool | null = null;
  let seen: Tool | null = null;
  // The tool set aside by the TEMPORARY pan, not deactivated: it will resume
  // its place (with its gesture intact) as soon as the pan ends. See Tool.onSuspend.
  let suspended: Tool | null = null;
  let spaceDown = false;
  let middlePan = false;
  let captured: number | null = null;

  // Resolves the effective tool and, if it changed since last time, closes the
  // previous one's gesture and updates the cursor.
  //
  // "Closes" has two forms, and the difference matters since there is a tool
  // (the pen tool) whose gesture lasts several clicks instead of a single drag:
  //  - TEMPORARY REPLACEMENT (space or middle button => hand): the tool
  //    will be back in a moment, so if it declares onSuspend it is just
  //    suspended. Panning while drawing is routine in any vector
  //    editor, and treating it as a tool change would throw away the
  //    work in progress without warning.
  //  - REAL CHANGE (toolbar, pointercancel, unmount): onDeactivate as
  //    always, the half-done gesture is abandoned.
  function active(): Tool {
    const next = temp ?? getActive();
    if (seen === next) return next;
    const prev = seen;
    seen = next;
    if (prev && next === temp && prev.onSuspend) {
      suspended = prev;
      prev.onSuspend(ctx);
    } else {
      prev?.onDeactivate?.(ctx);
      // The pan is OVER (temp went back to null): the suspended tool resumes its
      // place silently if it is the one becoming active again; if in the meantime the
      // toolbar moved to another tool, the suspended one must instead be
      // abandoned -- otherwise it would stay forever with a half-done gesture and
      // a preview that nobody turns off. As long as temp is still set we are still
      // panning (e.g. a pointercancel mid-pan) and nothing is decided.
      if (suspended && temp === null) {
        const s = suspended;
        suspended = null;
        if (s !== next) s.onDeactivate?.(ctx);
      }
    }
    const style = (canvas as { style?: { cursor: string } }).style;
    if (style) style.cursor = next.cursor;
    return next;
  }

  function release() {
    if (captured === null) return;
    // releasePointerCapture throws if the capture has already been lost: a drag
    // interrupted by the browser must not break the rest of the gesture.
    try {
      canvas.releasePointerCapture?.(captured);
    } catch {
      /* capture already released */
    }
    captured = null;
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === MOUSE_MIDDLE) {
      e.preventDefault(); // no browser autoscroll
      middlePan = true;
      temp = handTool;
    } else if (e.button !== MOUSE_LEFT) {
      return; // right button & co: no gesture
    }
    const tool = active();
    // Pointer capture: a drag that leaves the canvas (or the window) keeps
    // delivering moves here, instead of vanishing mid-gesture.
    try {
      canvas.setPointerCapture?.(e.pointerId);
      captured = e.pointerId;
    } catch {
      captured = null;
    }
    tool.onPointerDown?.(e, ctx);
  };

  const onPointerMove = (e: PointerEvent) => {
    active().onPointerMove?.(e, ctx);
  };

  const onPointerUp = (e: PointerEvent) => {
    const tool = active();
    tool.onPointerUp?.(e, ctx);
    release();
    if (middlePan) {
      middlePan = false;
      if (!spaceDown) temp = null;
      active(); // immediately restore tool and cursor
    }
  };

  // The browser cancelled the gesture (system gesture, loss of capture):
  // we abandon instead of emitting the final op.
  const onPointerCancel = () => {
    const tool = active();
    tool.onDeactivate?.(ctx);
    release();
    if (middlePan) {
      middlePan = false;
      if (!spaceDown) temp = null;
    }
    seen = null; // the next event starts clean (and reapplies the cursor)
    active();
  };

  const onWheel = (e: WheelEvent) => {
    // Always preventDefault: without it, ctrl+wheel zooms the PAGE and a
    // smooth wheel scrolls it.
    e.preventDefault();
    const p = eventToCanvasPoint(canvas, e);
    ctx.setCamera(zoomAt(ctx.getCamera(), wheelZoomFactor(e), p.x, p.y));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // A text field takes precedence over EVERY canvas shortcut. These
    // listeners are on the WINDOW (the canvas is not focusable), so they
    // also receive keys typed in the editing textarea
    // (ui/TextEditorOverlay.tsx) and in the properties panel fields: without the
    // guard, Backspace while typing deletes the selected NODE -- i.e.
    // the very one being edited -- and Escape abandons the tool's gesture
    // instead of leaving editing. It is the same principle as the
    // isTextField guard in ui/App.tsx on the undo/redo shortcuts, applied
    // to the other global key channel.
    if (isTextField(e.target)) return;
    if (e.code === "Space" && !swallowsSpace(e.target)) {
      e.preventDefault(); // no page scroll
      if (!spaceDown) {
        spaceDown = true;
        temp = handTool;
        active();
      }
      return;
    }
    active().onKeyDown?.(e, ctx);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== "Space" || !spaceDown) return;
    spaceDown = false;
    if (!middlePan) temp = null;
    active();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // Keys arrive on the window: the canvas is not focusable, so
  // listening on it would mean never receiving them.
  const view = canvas.ownerDocument?.defaultView ?? null;
  view?.addEventListener("keydown", onKeyDown);
  view?.addEventListener("keyup", onKeyUp);

  // Immediately hooks the active tool (and its cursor): so a later tool change
  // always finds a previous one to deactivate, even if that tool
  // had not yet received any event.
  active();

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("wheel", onWheel);
    view?.removeEventListener("keydown", onKeyDown);
    view?.removeEventListener("keyup", onKeyUp);
    release();
    seen?.onDeactivate?.(ctx);
    // The suspended one too: unmounting is not a pause, and a tool suspended during the
    // pan (space still held) must not be left with its gesture hanging.
    if (suspended !== seen) suspended?.onDeactivate?.(ctx);
    seen = null;
    suspended = null;
  };
}
