import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScene } from "../store/store";
import { worldToScreen } from "../canvas/camera";
import { applyTransform, worldTransformOf } from "../canvas/transform";
import { makeSetTextOp } from "../tools/ops";
import { cssColor } from "../renderer/canvasRenderer";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_WEIGHT,
  fontSizeOf,
  lineHeightOf,
} from "../renderer/text";
import type { NodeLite } from "../store/types";

// TEXT EDITING — a DOM <textarea> overlaid on the node.
//
// Why the DOM and not a caret drawn on the canvas: accents, dead keys,
// IME, mouse selection, cut/paste and screen readers are already
// solved by the native field, and rewriting them on top of a canvas means rewriting them
// badly. The canvas stays the place where the text LIVES; the field is only the way
// it is written.
//
// THE CHOICE (the brief offers two, see the report): the field is OPAQUE and covers
// the node, instead of being transparent over the glyphs drawn by the canvas.
// The transparent variant gives a pixel-aligned cursor only if font,
// wrapping AND baseline coincide exactly between ctx.measureText and the CSS
// layout -- and they do not: renderer/text.ts places the baseline with
// a declared approximation (ASCENT_RATIO = 0.8em) while the browser uses the
// font's real metrics. With a transparent field that gap would show
// as a cursor off-axis from the glyphs, which is exactly the flaw the
// choice was meant to avoid. By covering, the text one reads while writing is
// the field's: the misalignment becomes a small jump at the moment of
// confirmation, invisible during typing.
//
// "Covering" instead of "hiding the node in the renderer" is the same thing seen
// from the right side: drawScene stays a pure function of (scene, camera), without
// an "except this node" parameter that someone has to remember to pass --
// and without which the text would be seen TWICE. The cost is that, for the duration of
// editing, the field's rectangle also covers what sits under it.
//
// The coverage is therefore an INVARIANT, not an aesthetic detail: everything that
// moves the glyphs on the canvas must also move the field. ROTATION is
// exactly this -- drawScene rotates the context around the center of the node's box
// (renderer/canvasRenderer.ts), and the field repeats it with the same
// convention (degrees, clockwise, same center) via `transform`. Without it, the field
// would stay straight over crooked glyphs: the double text this choice
// exists to avoid.

export interface TextEditorOverlayProps {
  // The node being edited. It is decided by the store (editingNodeId): whoever
  // mounts the overlay passes it to us, so the component stays drivable by a test too.
  nodeId: string;
}

function contentOf(n: NodeLite | undefined): string {
  return n?.text?.content ?? "";
}

export function TextEditorOverlay({ nodeId }: TextEditorOverlayProps) {
  // Node and camera from the store, with selectors: the overlay redraws when the
  // camera moves (pan/zoom during editing must not detach the field
  // from the node) and when the node changes, not on every document op.
  const node = useScene((s) => s.scene?.nodes.at(nodeId));
  const camera = useScene((s) => s.camera);
  // The node's WORLD origin, NOT rotated. Its x/y are relative to the PARENT
  // (see canvas/transform.ts), so they are brought to the world with the
  // PARENT's transform -- not with the node's, which NOW also includes its rotation
  // (localTransformOf), and would give the ROTATED corner instead of the origin. The
  // rotation is applied separately by the field's `transform: rotate(...)` below,
  // around the center of the box, as drawScene does with the canvas context.
  //
  // Two selectors that return NUMBERS and not a point: a new object on every
  // call would make the overlay redraw on every document op, whereas
  // this way it redraws only when the origin really changes -- the node or one of its
  // ancestors moved.
  const worldX = useScene((s) => {
    const n = s.scene?.nodes.at(nodeId);
    return s.scene && n ? applyTransform(worldTransformOf(s.scene, n.parentId), n.x, n.y).x : 0;
  });
  const worldY = useScene((s) => {
    const n = s.scene?.nodes.at(nodeId);
    return s.scene && n ? applyTransform(worldTransformOf(s.scene, n.parentId), n.x, n.y).y : 0;
  });

  const ref = useRef<HTMLTextAreaElement | null>(null);
  // A session is closed ONLY once: Escape closes, and the blur that arrives
  // right after (the field is about to be unmounted) must not close anything again.
  const done = useRef(false);
  // Is an IME composition in progress? It serves only for Escape: while the IME is
  // open that key is ITS (it closes the candidates window), not ours.
  // A ref and not a state: no redraw depends on this value, and the
  // keydown must read it updated in the same event round.
  const composing = useRef(false);

  // The session's content. The source of truth while writing is the
  // FIELD, not the store: the store receives a preview at every key, but it is the
  // field that says what will really be written. `start` is the starting
  // content -- photographed on entry and never re-read from the store, which in the
  // meantime contains the previews.
  const [value, setValue] = useState(() => contentOf(node));
  const session = useRef({ id: nodeId, start: value, value });
  if (session.current.id !== nodeId) {
    // The parent reused the overlay for ANOTHER node instead of remounting it.
    // Today it does not happen (the blur always closes the session before a new
    // one opens), but a session that continues with another's starting
    // text would write the wrong content on the wrong node.
    const start = contentOf(node);
    session.current = { id: nodeId, start, value: start };
    setValue(start);
  }

  // Closes the session. `commit` = write (normal exit), otherwise cancel
  // (Escape). In both cases the gesture closes and is ONE undo entry: the
  // preview ops were never on the wire, the final one is a single one.
  const finish = useCallback(
    (commit: boolean) => {
      if (done.current) return;
      done.current = true;
      const store = useScene.getState();
      const { start, value: text } = session.current;
      if (commit) {
        // No change = no op: entering a text and leaving it without
        // touching it must neither travel on the network nor consume a Ctrl+Z.
        store.endGesture(text === start ? [] : [makeSetTextOp(nodeId, text)]);
      } else {
        store.cancelGesture();
      }
      // The policy for a node left EMPTY (deleting it instead of leaving a
      // ghost) lives in the store and stays there: the overlay does not duplicate it, it
      // invokes it. See store.ts::endTextEditing.
      store.endTextEditing();
    },
    [nodeId],
  );

  // Entry: opens the gesture, takes focus, cursor at the end of the text.
  useEffect(() => {
    done.current = false;
    useScene.getState().beginGesture();
    const el = ref.current;
    if (el) {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
    return () => {
      // Unmount WITHOUT an explicit exit: closes its own gesture and nothing else.
      // No endTextEditing here -- in StrictMode (main.tsx) React mounts,
      // unmounts and remounts every effect, and turning off the flag in there would make
      // the editor vanish in development at the first frame.
      if (!done.current) {
        done.current = true;
        useScene.getState().cancelGesture();
      }
    };
  }, [nodeId]);

  // The node vanished under the fingers (deleted by another client, or by the
  // rollback of its own creation): the session no longer has a target.
  // Closing it by canceling is the only honest exit -- a setText on an id that
  // does not exist would be rejected by the server and, even before that, would leave the gesture
  // open forever.
  const editable = node !== undefined && node.kind === "text" && node.text !== undefined;
  useEffect(() => {
    if (!editable) finish(false);
  }, [editable, finish]);

  // The field must COVER the text the canvas draws: if the content
  // grows beyond the node's box, it grows too. `height: 0` before
  // reading scrollHeight, otherwise the height can only go up.
  const minHeight = (node?.height ?? 0) * camera.zoom;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  });

  const change = (next: string) => {
    session.current.value = next;
    setValue(next);
    // LIVE preview on the canvas (and in everything that reads the scene: panels,
    // handles). It does not go on the wire: it is the gesture that sends the final op, a single one.
    // setText previews coalesce per node (store.ts::previewKey),
    // so a long session does not accumulate an op per key.
    useScene.getState().applyLocal(makeSetTextOp(nodeId, next));
  };

  if (!node || !editable) return null;

  const style = node.text?.style;
  const origin = worldToScreen(camera, worldX, worldY);
  // Everything in SCREEN px: the model stays in world units, the conversion lives
  // here as for the rest of the UI.
  const fontSize = fontSizeOf(style) * camera.zoom;
  const lineHeight = lineHeightOf(style) * camera.zoom;
  const width = node.width * camera.zoom;
  // A null angle writes NO transform: a straight field must stay
  // exactly the DOM it was before (same reason rotateVector
  // recognizes the null angle, see canvas/transform.ts).
  const rotated = node.rotation % 360 !== 0;
  // The pivot is the center of the NODE's box, not of the field: the field may
  // have grown beyond the box (it grows with the content, see minHeight above)
  // and rotating around its own center would detach it from the glyphs.
  // In px from the field's top-left corner, which is the node's origin.
  const transformOrigin = `${width / 2}px ${minHeight / 2}px`;

  return (
    <textarea
      ref={ref}
      aria-label="Text content"
      value={value}
      spellCheck={false}
      onChange={(e) => change(e.target.value)}
      // Click outside (the pointerdown on the canvas removes focus) and Tab: it
      // commits. It is also the safety net for the cases nobody handles --
      // the window losing focus must not be able to lose what the
      // user wrote.
      onBlur={() => finish(true)}
      // IME composition (Japanese, Chinese, Korean, but also mobile
      // predictive keyboards): between compositionstart and compositionend the keys
      // belong to the IME, not to us. See the guard in onKeyDown.
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(e) => {
        // Escape WHILE the IME is composing closes the candidates window:
        // it is the standard way to reject a conversion, and throwing away
        // the whole editing session for that key would make the editor
        // unusable with an IME -- that is with the languages the DOM overlay
        // exists for. Three signals for the same state because browsers do not
        // agree: isComposing (the standard), keyCode 229 (the key
        // "being processed by the IME", which old WebKit sends without
        // isComposing) and our ref, which covers the order in which the keydown
        // arrives before the browser marks the event.
        if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
        // Escape cancels. Enter does not: it makes a newline (it is a multiline editor) and is
        // therefore the field's business, not ours.
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      className="absolute m-0 block resize-none overflow-hidden border-0 p-0 bg-white"
      style={{
        left: `${origin.x}px`,
        top: `${origin.y}px`,
        width: `${width}px`,
        minHeight: `${minHeight}px`,
        transform: rotated ? `rotate(${node.rotation}deg)` : undefined,
        transformOrigin: rotated ? transformOrigin : undefined,
        fontFamily: style?.fontFamily || DEFAULT_FONT_FAMILY,
        fontWeight: style?.fontWeight || DEFAULT_FONT_WEIGHT,
        fontSize: `${fontSize}px`,
        lineHeight: `${lineHeight}px`,
        textAlign: style?.align ?? "left",
        color: cssColor(node),
        // The node's OPACITY is NOT carried over here: it would make
        // the whole field semi-transparent, background included, and the text drawn
        // underneath would show through -- two overlapping, offset texts, that is the
        // flaw the coverage exists to avoid. It is always written at
        // 100%, and the opacity comes back on commit (it is part of the small visual
        // jump this choice accepts).
        // Same wrapping as the canvas layout (renderer/text.ts): wraps on
        // spaces, and a word wider than the line is broken instead of
        // sticking out.
        // Same wrapping as the canvas layout (renderer/text.ts): wraps on
        // spaces, and a word wider than the line is broken instead of
        // sporgere.
        overflowWrap: "anywhere",
        // The field is an affordance, not a white rectangle that appeared out of
        // nowhere: the outline says where one is writing and where the wrap
        // width ends. In the theme's accent blue (--accent token), the same
        // as the selection on the canvas.
        outline: "1px solid var(--accent)",
        outlineOffset: "0px",
      }}
    />
  );
}
