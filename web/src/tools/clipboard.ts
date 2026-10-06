import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { nextOrderKey, orderKeyBetween } from "../store/orderKey";
import {
  toPbNode,
  toTextStyleLite,
  type EffectLite,
  type FillLite,
  type GradientLite,
  type NodeLite,
  type SceneState,
  type StrokeAlignLite,
  type StrokeLite,
  type TextAlignLite,
  type TextLite,
} from "../store/types";
import { makeCreateNodeOp, uuid } from "./ops";
import { isTextField } from "./toolManager";
import { importSvgAt, looksLikeSvg, viewportCenter } from "./svgImport";

// COPY / PASTE / DUPLICATE (track 3, task 1).
//
// The SYSTEM clipboard with a JSON payload all our own, and not just an
// in-memory buffer: it is the only form that allows copying in one document and
// pasting in ANOTHER (or in another window), which is the point of the
// feature. The in-memory buffer remains as a FALLBACK -- `navigator.clipboard`
// does not exist outside secure contexts (non-localhost http://), and even where
// it exists reading may be denied by the "clipboard-read" permission. In those
// cases copy and paste keep working inside the window.
//
// The payload is labeled and versioned on purpose: anyone else's text also ends up on
// the clipboard, and a paste must not try to interpret as a scene
// whatever happens to be in there.

export const CLIPBOARD_FORMAT = "opendesigner/clipboard";
export const CLIPBOARD_VERSION = 1;

// Offset (WORLD units) of pasted or duplicated nodes. It makes the
// copy visible: without it, it would land exactly on top of the original and it would seem
// that nothing happened.
export const PASTE_OFFSET = 16;

// The notice when the payload is ours but talks about something this build does not
// know. It goes through `notice` and not `lastError`: no change was
// undone (it was not even attempted), and it is information, not a server
// error.
const UNSUPPORTED_NOTICE =
  "the clipboard contains an element this version cannot read: nothing was pasted";

// --- the format -------------------------------------------------------------

// The node kinds this build can reconstruct. It is a Record indexed on
// NodeLite["kind"] and not an array of strings: adding a kind to the model
// without listing it here becomes a COMPILE error, instead of a payload
// that pastes as a rectangle because the field was not recognized.
// `image` is here, and with it only the HASH is copied: the bytes stay in the assets
// folder of the source document. Pasting into ANOTHER document thus produces
// a node whose asset is not there -- which the renderer draws as a
// placeholder instead of vanishing or blowing up. It is the honest behavior: the copy
// says which image it refers to, and if that image is not reachable
// from there you can see it. (Copying the bytes too would mean putting a photo on the
// system clipboard as JSON: exactly what content addressing
// exists to avoid.)
// The value is `boolean` (not `true`) on purpose: the Record stays EXHAUSTIVE on
// NodeLite["kind"] -- adding a kind to the model without listing it here is still
// a compile error -- but a kind PRESENT in the model that this file
// cannot yet reconstruct from JSON is marked `false` instead of being omitted. Today
// that is the case of `vector` (the anchor geometry has no reconstruction
// branch in parseClipboard) and of `unknown` (an opaque shape that not even
// the model can name): both must be rejected wholesale on paste, not
// degraded to a rectangle.
const KNOWN_KINDS: Record<NodeLite["kind"], boolean> = {
  rect: true,
  ellipse: true,
  text: true,
  image: true,
  vector: false,
  unknown: false,
  // Nesting containers (track 1): this side does not yet reconstruct
  // a subtree from the clipboard, so -- like vector/unknown -- they must be
  // rejected wholesale on paste instead of degraded to an empty rectangle.
  group: false,
  frame: false,
  // An instance (track M4) references a component by id: pasting it into a
  // document that does not have that component would give a node that renders nothing (and
  // core.applyCreate would reject it with ErrComponentNotFound). Until the
  // clipboard also carries the component, it must be rejected wholesale --
  // like vector/unknown/group/frame -- instead of degraded to a rectangle.
  instance: false,
};

function isKnownKind(kind: unknown): kind is NodeLite["kind"] {
  return typeof kind === "string"
    && Object.prototype.hasOwnProperty.call(KNOWN_KINDS, kind)
    && KNOWN_KINDS[kind as NodeLite["kind"]];
}

// The outcome of reading the clipboard. The two forms of rejection are different and
// must be kept distinct:
//  - "foreign": it is not our stuff (text from another application, someone
//    else's JSON, empty clipboard). It is not an error: there is simply
//    nothing to paste from there. Note, it is not a pass for
//    the in-memory buffer either: if the clipboard let itself be read, that text
//    IS the user's most recent copy (see pasteClipboard).
//  - "unsupported": it is an opendesigner payload, but of a version or with a node type
//    that this build cannot reconstruct. Here the fallback would be WRONG
//    (the user copied THAT), and degrading the node would be even more so: it is
//    rejected and reported.
export type ClipboardParse =
  | { ok: true; nodes: NodeLite[] }
  | { ok: false; reason: "foreign" }
  | { ok: false; reason: "unsupported" };

export function serializeNodes(nodes: readonly NodeLite[]): string {
  return JSON.stringify({ format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, nodes });
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function toFills(v: unknown): FillLite[] {
  if (!Array.isArray(v)) return [];
  return v.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const base: FillLite = { r: num(o.r, 0), g: num(o.g, 0), b: num(o.b, 0), a: num(o.a, 1) };
    const g = toGradient(o.gradient);
    return g ? { ...base, gradient: g } : base;
  });
}

function toEffects(v: unknown): EffectLite[] {
  if (!Array.isArray(v)) return [];
  const out: EffectLite[] = [];
  for (const raw of v) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (e.kind === "dropShadow") {
      const c = (e.color ?? {}) as Record<string, unknown>;
      out.push({
        kind: "dropShadow",
        color: { r: num(c.r, 0), g: num(c.g, 0), b: num(c.b, 0), a: num(c.a, 1) },
        offsetX: num(e.offsetX, 0), offsetY: num(e.offsetY, 0), blur: Math.max(0, num(e.blur, 0)),
      });
    } else if (e.kind === "layerBlur") {
      out.push({ kind: "layerBlur", radius: Math.max(0, num(e.radius, 0)) });
    }
  }
  return out;
}

function toGradient(v: unknown): GradientLite | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if ((o.kind !== "linear" && o.kind !== "radial") || !Array.isArray(o.stops)) return undefined;
  const stops = o.stops.map((st) => {
    const so = (st ?? {}) as Record<string, unknown>;
    const c = (so.color ?? {}) as Record<string, unknown>;
    return {
      color: { r: num(c.r, 0), g: num(c.g, 0), b: num(c.b, 0), a: num(c.a, 1) },
      position: num(so.position, 0),
    };
  });
  if (stops.length < 2) return undefined;
  return { kind: o.kind, stops, x1: num(o.x1, 0), y1: num(o.y1, 0), x2: num(o.x2, 1), y2: num(o.y2, 0) };
}

const STROKE_ALIGNS: Record<StrokeAlignLite, true> = { center: true, inside: true, outside: true };

function toStrokeAlign(v: unknown): StrokeAlignLite {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STROKE_ALIGNS, v)
    ? (v as StrokeAlignLite)
    : "center";
}

// Like toFills, on the stroke side: the clipboard payload is JSON of our own
// format, re-read defensively -- a missing or
// crooked field falls back to the honest default (no stroke, weight 0) instead of
// blowing up the paste. It preserves the stroke of a copied node through the
// serialize/paste round-trip.
function toStrokes(v: unknown): StrokeLite[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const c = (o.color ?? {}) as Record<string, unknown>;
    return {
      color: { r: num(c.r, 0), g: num(c.g, 0), b: num(c.b, 0), a: num(c.a, 1) },
      weight: num(o.weight, 0),
      align: toStrokeAlign(o.align),
    };
  });
}

const ALIGNS: Record<TextAlignLite, true> = { left: true, center: true, right: true };

function toAlign(v: unknown): TextAlignLite {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ALIGNS, v)
    ? (v as TextAlignLite)
    : "left";
}

// A text node without `text` is not an error to reject: it is a badly
// written or truncated payload, and an EMPTY text is the honest reconstruction (the
// same default that toTextStyleLite gives an absent style). Rejecting here
// would mean throwing away the healthy nodes next to it as well.
function toText(v: unknown): TextLite {
  const o = (v ?? {}) as Record<string, unknown>;
  const s = (o.style ?? {}) as Record<string, unknown>;
  const zero = toTextStyleLite(undefined);
  return {
    content: str(o.content, ""),
    style: {
      fontFamily: str(s.fontFamily, zero.fontFamily),
      fontSize: num(s.fontSize, zero.fontSize),
      fontWeight: str(s.fontWeight, zero.fontWeight),
      lineHeight: num(s.lineHeight, zero.lineHeight),
      align: toAlign(s.align),
    },
  };
}

export function parseClipboard(text: string): ClipboardParse {
  if (text.trim() === "") return { ok: false, reason: "foreign" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "foreign" };
  }
  if (typeof payload !== "object" || payload === null) return { ok: false, reason: "foreign" };
  const p = payload as Record<string, unknown>;
  if (p.format !== CLIPBOARD_FORMAT) return { ok: false, reason: "foreign" };
  // From here on the payload is OURS: every rejection is "unsupported", never
  // "foreign" -- the user copied this, and silently falling back to an earlier
  // copy would paste one thing for another.
  if (p.version !== CLIPBOARD_VERSION) return { ok: false, reason: "unsupported" };
  if (!Array.isArray(p.nodes)) return { ok: false, reason: "unsupported" };

  const nodes: NodeLite[] = [];
  for (const raw of p.nodes) {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "unsupported" };
    const n = raw as Record<string, unknown>;
    // THE check that matters: a type this build does not know (a
    // VectorNode from track 4, an M4 InstanceNode, a future build) must be
    // rejected as a WHOLE. Rebuilding it as a rectangle -- which is what
    // any silent default would do, toNodeLite included -- would create a
    // node that is not what the user copied, inside a document that
    // then persists it.
    if (!isKnownKind(n.kind)) return { ok: false, reason: "unsupported" };
    const kind = n.kind;
    nodes.push({
      id: str(n.id, ""),
      parentId: str(n.parentId, ""),
      orderKey: str(n.orderKey, ""),
      name: str(n.name, ""),
      visible: bool(n.visible, true),
      opacity: num(n.opacity, 1),
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: num(n.width, 0),
      height: num(n.height, 0),
      rotation: num(n.rotation, 0),
      fills: toFills(n.fills),
      strokes: toStrokes(n.strokes),
      ...(toEffects(n.effects).length > 0 ? { effects: toEffects(n.effects) } : {}),
      kind,
      cornerRadius: num(n.cornerRadius, 0),
      // Always false: KNOWN_KINDS rejects frames wholesale (this side does not
      // reconstruct containers), so here `kind` is only rect/ellipse/text/image.
      clipsContent: false,
      ...(kind === "text" ? { text: toText(n.text) } : {}),
      // An image without a readable hash is not a payload to reject: it is a
      // node whose asset cannot be found, i.e. exactly the case the
      // renderer already draws as a placeholder. Same choice as toText on a
      // truncated text.
      ...(kind === "image"
        ? { image: { assetHash: str((n.image as Record<string, unknown> | undefined)?.assetHash, "") } }
        : {}),
    });
  }
  return { ok: true, nodes };
}

// --- the paste ops ----------------------------------------------------------

function byOrderKey(a: NodeLite, b: NodeLite): number {
  return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0;
}

// An id the destination document knows: a node or a page
// (pages are not in `nodes`, but they are legitimate parents -- today in fact the
// only ones).
function existsInScene(scene: SceneState, id: string): boolean {
  return scene.nodes.has(id) || scene.pages.some((p) => p.id === id);
}

export interface PasteOps {
  ops: Op[];
  // The NEW ids, in the order the nodes are created: the selection to
  // install after the paste.
  ids: string[];
}

/**
 * The creation ops to paste `nodes` into `scene`.
 *
 * Written in terms of the PASSED NODES and their parent, never of "all the nodes
 * of the document": it is what lets it survive nesting
 * (track 1), where a payload will contain a container together with its children.
 *
 * Each node receives a NEW id (a duplicate id would make the server reject the op
 * -- ErrNodeExists in core.applyCreate -- leaving the local scene
 * diverged) and a NEW order key taken from the fractional index, at the top of the
 * document and in the relative order of the source nodes.
 */
export function pasteOps(
  scene: SceneState,
  nodes: readonly NodeLite[],
  offset: number = PASTE_OFFSET,
): PasteOps {
  const sorted = [...nodes].sort(byOrderKey);
  // A new id per POSITION in the list, not per source id. The
  // difference matters because the payload ids are not guaranteed: parseClipboard
  // tolerates a node without `id` (it reads it as "") and nothing prevents a
  // hand-written payload from repeating the same id twice. Indexing on the id,
  // those nodes would collapse onto ONE SINGLE uuid and two CreateNodes
  // with the same id would come out of here: locally applyOp discards the second (parity with
  // core.applyCreate, ErrNodeExists) and the scene gains one node while `ids` and
  // the undo entry declare two; against the server the op is REJECTED mid-
  // gesture and the rollback kicks in. N nodes passed, N nodes created, always.
  const freshIds = sorted.map(() => uuid());

  // The old id -> new id mapping, computed BEFORE building the
  // ops: it serves ONLY to remap parents (see below), which may point to a
  // node that comes later in the list. Two exclusions, both necessary:
  //  - the EMPTY id is not an identity: mapping it would attach every node without
  //    a parent (parentId "") to the copy of the node without an id;
  //  - a REPEATED id is ambiguous (which of the two copies does a
  //    child refer to?): `null` is recorded and it is not remapped at all, so the parent
  //    falls on cases 2/3 below instead of being drawn by lot.
  const byOldId = new Map<string, string | null>();
  sorted.forEach((n, i) => {
    if (n.id === "") return;
    byOldId.set(n.id, byOldId.has(n.id) ? null : freshIds[i]);
  });

  const fallbackParent = scene.pages[0]?.id ?? "";
  let key = nextOrderKey(scene);
  const ops: Op[] = [];
  const ids: string[] = [];

  for (const [i, n] of sorted.entries()) {
    const id = freshIds[i];
    // A node that declares itself as its own parent is a cycle: it is not
    // remapped (today it would be harmless, with the nesting of track 1 it would not).
    const mapped = n.parentId === n.id ? null : (byOldId.get(n.parentId) ?? null);
    // Three cases, in this order:
    //  1. the parent is also in the payload -> the child follows the COPY, not
    //     the original (without this, pasting a group would leave the children
    //     attached to the source group);
    //  2. the parent exists in the destination document -> it stays where it is;
    //  3. it does not exist (paste into ANOTHER document) -> the node lands on the
    //     page, instead of remaining orphaned of a nonexistent parent.
    const parentId =
      mapped ?? (existsInScene(scene, n.parentId) ? n.parentId : fallbackParent);
    // Only the ROOTS of the pasted set take the offset. Today the
    // coordinates are all world and the scene is flat, so they are all the
    // nodes; when coordinates become relative to the parent, moving
    // the children too would move them twice. "Root" = parent NOT remapped:
    // an ambiguous or nonexistent parent leaves the node uncovered, hence root.
    const moved = mapped !== null ? { x: n.x, y: n.y } : { x: n.x + offset, y: n.y + offset };
    // toPbNode is the EXACT inverse of toNodeLite (store/types.ts): going through it
    // instead of rebuilding the Node by hand is what makes every
    // model field survive the copy, including those added later.
    ops.push(makeCreateNodeOp(toPbNode({ ...n, id, parentId, orderKey: key, ...moved })));
    ids.push(id);
    key = orderKeyBetween(key, null);
  }
  return { ops, ids };
}

// --- the system clipboard ---------------------------------------------------

// The FALLBACK: the last copy made in this window. It is needed when the
// system clipboard is absent or cannot be read; inside the window
// copy and paste keep working anyway.
//
// An exported object and not a private `let`: it is MODULE state, so it lives
// as long as the page, and "no copy was ever made" is a legitimate starting state
// that must be restorable (tests reset it the way they reset
// the store). `null` = no copy in this window.
//
// `onSystem` says whether the last copy ARRIVED on the system clipboard. It is
// what distinguishes "the buffer is a convenience, the real copy is out there" from "the
// buffer is the ONLY copy that exists": only in the second case is falling back on it
// legitimate when the clipboard reads fine but contains someone else's stuff
// (see pasteClipboard).
export const clipboardMemory: { text: string | null; onSystem: boolean } = {
  text: null,
  onSystem: false,
};

// One paste at a time. Reading the clipboard is ASYNCHRONOUS and can stay
// hanging for a long time -- Chromium does not resolve `readText()` until the document
// has focus -- and meanwhile the user, seeing nothing happen, presses
// Ctrl+V again. Without a guard those reads all queue up and land
// TOGETHER as soon as the first unblocks: a burst of pastes that nobody asked
// for, which moreover have to be undone one Ctrl+Z at a time.
let pasting = false;

function systemClipboard(): Clipboard | undefined {
  // `navigator` exists wherever this code runs, but `clipboard` does not (insecure
  // contexts): the check is on the property, not on the object.
  return globalThis.navigator?.clipboard as Clipboard | undefined;
}

async function writeSystem(text: string): Promise<boolean> {
  const cb = systemClipboard();
  if (typeof cb?.writeText !== "function") return false;
  try {
    await cb.writeText(text);
    return true;
  } catch {
    // Permission denied, document not focused: the copy stays valid in memory.
    return false;
  }
}

async function readSystem(): Promise<string | null> {
  const cb = systemClipboard();
  if (typeof cb?.readText !== "function") return null;
  try {
    return await cb.readText();
  } catch {
    return null;
  }
}

// --- the commands -----------------------------------------------------------

function selectedNodes(): NodeLite[] {
  const { scene, selection } = useScene.getState();
  if (!scene) return [];
  // Goes through the SELECTION and not [...scene.nodes.values()]: it is the same
  // reason pasteOps talks about the passed nodes and not the document --
  // surviving nesting without rewrites.
  return selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined);
}

/**
 * Ctrl+C. Returns false when there is nothing to copy (no selection,
 * no document): in that case the system clipboard is NOT touched --
 * emptying it would be a change the user did not ask for.
 */
export async function copySelection(): Promise<boolean> {
  const nodes = selectedNodes();
  if (nodes.length === 0) return false;
  const text = serializeNodes(nodes);
  // The in-memory buffer is ALWAYS written, even when the system clipboard
  // is available: if the system write fails halfway (permission, lost
  // focus) paste inside this window must still work.
  clipboardMemory.text = text;
  clipboardMemory.onSystem = await writeSystem(text);
  return true;
}

// The common part of paste and duplicate: ONE gesture, hence ONE undo entry --
// one Ctrl+Z removes everything pasted together, not one node at a time.
function pasteNodes(nodes: readonly NodeLite[]): string[] {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || nodes.length === 0) return [];
  // Same guard as undo/redo (store.ts): with a gesture open (a drag in progress)
  // the ops would end up in the gesture BASE, and the next pointerup
  // would rebuild the scene on a state that is not the one the drag
  // started from.
  if (store.gesture) return [];

  const { ops, ids } = pasteOps(scene, nodes);
  store.beginGesture();
  // The selection goes on the NEW nodes, as in every editor: it is the pasted stuff that
  // gets moved right after. Set before endGesture, which reconciles it against
  // the FINAL scene (the one containing the newly created nodes) -- see the
  // comment on `intended` in store.ts.
  useScene.getState().setSelection(ids);
  useScene.getState().endGesture(ops);
  return ids;
}

/**
 * Ctrl+V. Reads the SYSTEM clipboard (so a payload copied in another
 * window or in another document pastes here) and falls back to the in-memory buffer
 * only when that clipboard is not reachable -- not when it is
 * reachable and contains something else.
 */
export async function pasteClipboard(): Promise<string[]> {
  if (pasting) return [];
  pasting = true;
  try {
    const fromSystem = await readSystem();
    let parsed: ClipboardParse | null = fromSystem === null ? null : parseClipboard(fromSystem);
    // Text that is an SVG document (copied from a site, from another editor, from
    // a file opened as text): it is not a payload of ours ("foreign") but has a
    // precise meaning -- it is imported as nodes, at the center of the view. The
    // opendesigner payload ALWAYS takes precedence: a node named
    // "<svg>" must not hijack the paste.
    if (fromSystem !== null && parsed && !parsed.ok && parsed.reason === "foreign" && looksLikeSvg(fromSystem)) {
      const id = await importSvgAt(fromSystem, viewportCenter());
      return id ? [id] : [];
    }
    // When it is possible to fall back on the in-memory buffer. It is NOT enough that the clipboard
    // contains someone else's stuff: a SUCCESSFUL read is the last copy
    // the user really made (text selected in the layers panel and
    // Ctrl+C -- which here yields to the browser on purpose -- or a copy in another
    // application), and pasting a rectangle copied ten minutes earlier on top of it
    // would be pasting one thing for another, silently: the same
    // reason an `unsupported` payload does not fall back. Two cases remain
    // in which the buffer is the only copy that exists:
    //  - the clipboard did not answer (`null`: API absent outside secure
    //    contexts, or read denied/failed);
    //  - our copy never got that far (write denied or unfocused),
    //    so out there nothing represents it.
    const mayFallBack = fromSystem === null || !clipboardMemory.onSystem;
    if (mayFallBack && (parsed === null || (!parsed.ok && parsed.reason === "foreign"))) {
      parsed = clipboardMemory.text === null ? null : parseClipboard(clipboardMemory.text);
    }
    if (parsed === null) return [];
    if (!parsed.ok) {
      if (parsed.reason === "unsupported") {
        // Written directly into the state: `notice` is a read-only channel
        // for the UI (ui/App.tsx shows it and offers to dismiss it), it has
        // no dedicated action, and this module has no reason to add one
        // to the store.
        useScene.setState({ notice: UNSUPPORTED_NOTICE });
      }
      return [];
    }
    return pasteNodes(parsed.nodes);
  } finally {
    pasting = false;
  }
}

/**
 * Ctrl+D. Duplicates the selection with the same offset as paste and does NOT
 * touch the clipboard: duplicating is not copying, and overwriting the clipboard
 * would throw away what the user had put there.
 *
 * A repeated Ctrl+D scales: the copies stay selected, so the next
 * duplicate starts from them.
 */
export function duplicateSelection(): string[] {
  return pasteNodes(selectedNodes());
}

// --- the shortcuts ----------------------------------------------------------

interface ShortcutTarget {
  addEventListener(type: "keydown", handler: (e: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", handler: (e: KeyboardEvent) => void): void;
}

/**
 * Hooks up Ctrl/Cmd+C, +V, +D. On the WINDOW like the undo/redo shortcuts
 * (ui/App.tsx) and for the same reason: the canvas is not focusable, so the keys
 * would never reach it.
 *
 * Returns the detach function.
 */
export function attachClipboardShortcuts(target: ShortcutTarget = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Inside a text field copy belongs to the FIELD: stealing it would mean
    // copying the selected rectangle instead of the highlighted word.
    if (isTextField(e.target)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    switch (e.key.toLowerCase()) {
      case "c": {
        // With text highlighted in the page (layers panel, notices) the
        // copy stays with the browser: it is the one the user is asking for.
        const sel = globalThis.getSelection?.();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        void copySelection();
        return;
      }
      case "v":
        e.preventDefault();
        void pasteClipboard();
        return;
      case "d":
        // always preventDefault: Ctrl+D is "bookmark" in the browser.
        e.preventDefault();
        duplicateSelection();
        return;
      default:
        return;
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
