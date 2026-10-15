import { easingFn } from "../animation/engine";
import { PROTO_PAGE_ID } from "./protoScene";
import { childrenOf } from "../store/tree";
import type { FillLite, NodeLite, SceneState, TransitionLite } from "../store/types";

// HOW THE PROTOTYPE PLAYER GOES FROM ONE SCREEN TO THE NEXT. Pure: a transition and a
// progress in, the placement of the two screens (or a derived scene) out; the player
// draws it. Nothing here touches the document.

export const DEFAULT_DURATION_MS = 300;

export type Direction = "left" | "right" | "up" | "down";
export interface TransitionAnim {
  kind: "dissolve" | "slide" | "push" | "smart";
  dir: Direction;
  durationMs: number;
  easing: string;
}

/** The animation of a transition, or null for a cut. */
export function animOf(t: TransitionLite): TransitionAnim | null {
  const a = t.animation ?? "";
  if (a === "") return null;
  const durationMs = t.durationMs && t.durationMs > 0 ? t.durationMs : DEFAULT_DURATION_MS;
  const easing = t.easing && t.easing !== "" ? t.easing : "easeInOut";
  if (a === "dissolve" || a === "smart") return { kind: a, dir: "left", durationMs, easing };
  const [kind, dir] = a.split("-");
  if ((kind === "slide" || kind === "push") && (dir === "left" || dir === "right" || dir === "up" || dir === "down")) {
    return { kind, dir, durationMs, easing };
  }
  return null;
}

/** The eased progress 0..1 after `elapsedMs`. */
export function progressOf(a: TransitionAnim, elapsedMs: number): number {
  const raw = Math.min(1, Math.max(0, elapsedMs / a.durationMs));
  return easingFn(a.easing)(raw);
}

/** Where each screen sits, as FRACTIONS of the screen's width / height, and how opaque it is. */
export interface Layers {
  from: { dx: number; dy: number; alpha: number };
  to: { dx: number; dy: number; alpha: number };
}

// The unit vector the NEW screen comes from: slide-left brings it in from the right.
const ENTRY: Record<Direction, { x: number; y: number }> = {
  left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, up: { x: 0, y: 1 }, down: { x: 0, y: -1 },
};

export function layersAt(a: TransitionAnim, p: number): Layers {
  const e = ENTRY[a.dir];
  switch (a.kind) {
    case "dissolve":
      return { from: { dx: 0, dy: 0, alpha: 1 }, to: { dx: 0, dy: 0, alpha: p } };
    case "slide":
      return { from: { dx: 0, dy: 0, alpha: 1 }, to: { dx: e.x * (1 - p), dy: e.y * (1 - p), alpha: 1 } };
    case "push":
      return {
        from: { dx: -e.x * p, dy: -e.y * p, alpha: 1 },
        to: { dx: e.x * (1 - p), dy: e.y * (1 - p), alpha: 1 },
      };
    default:
      // smart: the player draws ONE scene (smartScene), not two layers.
      return { from: { dx: 0, dy: 0, alpha: 0 }, to: { dx: 0, dy: 0, alpha: 1 } };
  }
}

// ---------- smart animate ----------

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function lerpFill(a: FillLite | undefined, b: FillLite | undefined, p: number): FillLite | undefined {
  if (!a || !b || a.gradient || b.gradient) return b;
  return { r: lerp(a.r, b.r, p), g: lerp(a.g, b.g, p), b: lerp(a.b, b.b, p), a: lerp(a.a, b.a, p) };
}

// The identity of a node across two screens: its name, with a counter among same-named
// siblings, along the path from the screen's root.
function keyed(scene: SceneState, rootId: string): Map<string, NodeLite> {
  const out = new Map<string, NodeLite>();
  const walk = (parentId: string, prefix: string) => {
    const seen = new Map<string, number>();
    for (const c of childrenOf(scene, parentId)) {
      const base = c.name || c.kind;
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      const key = `${prefix}/${base}#${k}`;
      out.set(key, c);
      walk(c.id, key);
    }
  };
  walk(rootId, "");
  return out;
}

/**
 * The scene of a SMART ANIMATE step: the destination screen with every node that has a
 * counterpart in the source (same name along the same path) moved, resized, turned,
 * faded and tinted a fraction `p` of the way; nodes that only exist in the destination
 * fade in, and those that only exist in the source fade out in place.
 * Null if either screen is missing.
 */
export function smartScene(scene: SceneState, fromId: string, toId: string, p: number): SceneState | null {
  const fromRoot = scene.nodes.at(fromId);
  const toRoot = scene.nodes.at(toId);
  if (!fromRoot || !toRoot) return null;
  const fromNodes = keyed(scene, fromId);
  const toNodes = keyed(scene, toId);
  let nodes = scene.nodes;
  const idOfKey = new Map<string, string>();
  for (const [k, n] of toNodes) idOfKey.set(k, n.id);

  for (const [key, b] of toNodes) {
    const a = fromNodes.get(key);
    if (a && a.kind === b.kind) {
      nodes = nodes.set(b.id, {
        ...b,
        x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p),
        width: lerp(a.width, b.width, p), height: lerp(a.height, b.height, p),
        rotation: lerp(a.rotation, b.rotation, p), opacity: lerp(a.opacity, b.opacity, p),
        fills: b.fills.length === 1 && a.fills.length === 1 ? [lerpFill(a.fills[0], b.fills[0], p) as FillLite] : b.fills,
      });
    } else {
      nodes = nodes.set(b.id, { ...b, opacity: b.opacity * p });
    }
  }
  // Source-only nodes stay where they were and fade out, under the destination's matching parent.
  // (Parents come before their children in `fromNodes`, so a source-only container is
  // already placed when its own children are.) Only the OUTERMOST source-only node fades
  // by itself: its children, drawn inside it, already fade with it.
  const placed = new Map<string, string>();
  for (const [key, a] of fromNodes) {
    if (toNodes.has(key) && toNodes.get(key)!.kind === a.kind) continue;
    const parentKey = key.slice(0, key.lastIndexOf("/"));
    const parentId = parentKey === "" ? toId : (idOfKey.get(parentKey) ?? placed.get(parentKey));
    if (!parentId) continue;
    const id = `__from__${a.id}`;
    placed.set(key, id);
    const nested = parentId.startsWith("__from__");
    nodes = nodes.set(id, { ...a, id, parentId, opacity: nested ? a.opacity : a.opacity * (1 - p) });
  }
  // The destination root: its own box and fill blend too.
  nodes = nodes.set(toId, {
    ...(nodes.at(toId) as NodeLite),
    parentId: PROTO_PAGE_ID, visible: true,
    fills: toRoot.fills.length === 1 && fromRoot.fills.length === 1 ? [lerpFill(fromRoot.fills[0], toRoot.fills[0], p) as FillLite] : toRoot.fills,
  });
  return { ...scene, pages: [{ id: PROTO_PAGE_ID, name: "Prototype" }], nodes };
}
