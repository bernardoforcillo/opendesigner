import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Camera } from "../canvas/camera";
import type { SceneState } from "../store/types";
import { poseScene } from "../animation/pose";
import {
  autoClipsForScreen, clipsUnder, pointerClipsForScreen, sampleRuns, startRuns, type ClipRun,
} from "../animation/runtime";

// THE PROTOTYPE'S ANIMATIONS ("Present"): connects the pure runtime
// (animation/runtime.ts) to the player.
//  - `enter` and `loop`: start when the screen appears (also when going
//    back: the screen restarts from the beginning);
//  - `hover`: starts when the pointer enters the target's box, and when it
//    leaves the state goes back at once to the base one (like the HTML export);
//  - `tap`: starts on press of the target, once.
// The requestAnimationFrame loop runs ONLY while a clip is running: a
// still screen (or one without clips) schedules no frames.
export function useProtoAnimation(
  scene: SceneState | null,
  screenId: string | null,
  cam: Camera | null,
  stage: React.RefObject<HTMLElement | null>,
) {
  const runs = useRef<ClipRun[]>([]);
  const hovering = useRef<Map<string, ClipRun>>(new Map());
  const raf = useRef(0);
  // The current frame: the drawing is redone when it changes (it is a dependency of the draw effect).
  const [tick, setTick] = useState(0);
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const step = useCallback(() => {
    raf.current = 0;
    const all = [...runs.current, ...hovering.current.values()];
    const { live } = sampleRuns(all, now());
    setTick((n) => n + 1);
    if (live) raf.current = requestAnimationFrame(step);
  }, []);
  const kick = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(step);
  }, [step]);

  // The screen changes (or the document): the enter and loop clips restart.
  useEffect(() => {
    hovering.current = new Map();
    runs.current = scene && screenId ? startRuns(autoClipsForScreen(scene, screenId), now()) : [];
    if (runs.current.length > 0) kick();
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // Only the screen: a document edit with the prototype open does not restart the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenId]);

  // From the pointer (stage px) to the world.
  const worldOf = (e: { clientX: number; clientY: number }) => {
    const el = stage.current;
    if (!el || !cam || cam.zoom === 0) return null;
    const r = el.getBoundingClientRect();
    return { x: (e.clientX - r.left - cam.x) / cam.zoom, y: (e.clientY - r.top - cam.y) / cam.zoom };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!scene || !screenId) return;
    const hover = pointerClipsForScreen(scene, screenId, "hover");
    if (hover.length === 0 && ![...hovering.current.keys()].some((k) => !k.startsWith("tap:"))) return;
    const p = worldOf(e);
    const under = new Set(p ? clipsUnder(scene, hover, p.x, p.y).map((c) => c.id) : []);
    let changed = false;
    for (const id of [...hovering.current.keys()]) {
      if (!id.startsWith("tap:") && !under.has(id)) { hovering.current.delete(id); changed = true; }
    }
    for (const c of hover) {
      if (under.has(c.id) && !hovering.current.has(c.id)) {
        hovering.current.set(c.id, startRuns([c], now())[0]);
        changed = true;
      }
    }
    if (changed) kick();
  };
  const onPointerLeave = () => {
    if (hovering.current.size === 0) return;
    hovering.current = new Map();
    kick();
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!scene || !screenId) return;
    const taps = pointerClipsForScreen(scene, screenId, "tap");
    if (taps.length === 0) return;
    const p = worldOf(e);
    if (!p) return;
    const hit = clipsUnder(scene, taps, p.x, p.y);
    if (hit.length === 0) return;
    // The touch holds while it stays pressed (like `:active` in the exported code).
    for (const c of hit) hovering.current.set(`tap:${c.id}`, startRuns([c], now())[0]);
    kick();
  };
  const onPointerUp = () => {
    let changed = false;
    for (const k of [...hovering.current.keys()]) {
      if (k.startsWith("tap:")) { hovering.current.delete(k); changed = true; }
    }
    if (changed) kick();
  };

  /** The scene to draw NOW: the derived one with the sampled state on top (the same instance if nothing animates). */
  const pose = useCallback(
    (derived: SceneState): SceneState => {
      const all = [...runs.current, ...hovering.current.values()];
      if (all.length === 0) return derived;
      const { anim } = sampleRuns(all, now());
      return anim.size === 0 ? derived : poseScene(derived, anim);
    },
    // `tick` is not read: but a new `pose` tells the drawing that there is a new frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  );

  return useMemo(() => ({ tick, pose, handlers: { onPointerMove, onPointerLeave, onPointerDown, onPointerUp, onPointerCancel: onPointerUp } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, pose, scene, screenId, cam]);
}
