import { useEffect } from "react";
import { MAX_ZOOM, zoomAt, type Camera } from "@/canvas/camera";
import { fitPage } from "@/canvas/pageView";
import { rotatedAabb } from "@/canvas/transform";
import { isTextField } from "@/tools/toolManager";
import { selectionFrame } from "@/renderer/overlayRenderer";
import { useScene } from "@/store/store";
import { facingPartner, fitSpreadCamera, useSpreadView } from "@/store/spread";
import type { Bounds } from "@/canvas/geometry";
import type { SceneState } from "@/store/types";

// THE ZOOM COMMANDS: the same few moves from the zoom menu, the status bar and the keyboard.
//   in / out        one step around the middle of the canvas
//   100             actual size
//   fit             the whole page -- a sheet (or the spread of two facing sheets) when the page is
//                   sized, otherwise its content
//   selection       the selected objects, filling the canvas
// The camera maths is pure (and tested); `runZoom` reads the canvas size from the DOM and writes the
// store's camera.
export type ZoomCommand = "in" | "out" | "100" | "fit" | "selection";
export const ZOOM_STEP = 1.25;
const MARGIN = 72;

/** The camera that frames `b` in a `w` x `h` canvas with a margin, at most `maxZoom`. */
export function cameraForBounds(b: Bounds, w: number, h: number, margin = MARGIN, maxZoom = 8): Camera | null {
  if (!(w > 0) || !(h > 0)) return null;
  const bw = Math.max(1, b.width), bh = Math.max(1, b.height);
  const zoom = Math.min(maxZoom, MAX_ZOOM, Math.max(0.02, Math.min((w - 2 * margin) / bw, (h - 2 * margin) / bh)));
  return { zoom, x: (w - bw * zoom) / 2 - b.x * zoom, y: (h - bh * zoom) / 2 - b.y * zoom };
}

/** The camera for "fit": the page's sheet (and its facing sheet) when it has one, else its content. */
export function fitView(scene: SceneState, pageId: string | null, w: number, h: number, spreadOn = true): Camera | null {
  const id = pageId ?? scene.pages[0]?.id;
  const page = scene.pages.find((p) => p.id === id);
  if (!page) return null;
  if (page.width && page.height) return fitSpreadCamera(scene, id, spreadOn ? facingPartner(scene, id) : null, w, h);
  return fitPage(scene, page.id, w, h);
}

/** The camera that frames the selection, or null when nothing selected has a box. */
export function selectionView(scene: SceneState, selection: string[], w: number, h: number): Camera | null {
  const frame = selectionFrame(scene, selection);
  return frame ? cameraForBounds(rotatedAabb(frame.bounds, frame.rotation), w, h) : null;
}

export function runZoom(cmd: ZoomCommand): void {
  const st = useScene.getState();
  const canvas = document.getElementById("scene");
  const w = canvas?.clientWidth ?? 0;
  const h = canvas?.clientHeight ?? 0;
  const around = (factor: number) => st.setCamera(zoomAt(st.camera, factor, w / 2, h / 2));
  switch (cmd) {
    case "in": return around(ZOOM_STEP);
    case "out": return around(1 / ZOOM_STEP);
    case "100": return st.camera.zoom > 0 ? around(1 / st.camera.zoom) : undefined;
    case "fit": {
      const cam = st.scene && fitView(st.scene, st.currentPageId, w, h, useSpreadView.getState().on);
      return cam ? st.setCamera(cam) : undefined;
    }
    case "selection": {
      const cam = st.scene && selectionView(st.scene, st.selection, w, h);
      return cam ? st.setCamera(cam) : undefined;
    }
  }
}

/** The command a key press stands for, or null. Figma's Shift+0 / 1 / 2 and the page-layout Ctrl/Cmd+0 / 1 / + / -. */
export function zoomCommandFor(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): ZoomCommand | null {
  if (e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey) {
    if (e.key === "0") return "fit";
    if (e.key === "1") return "100";
    if (e.key === "=" || e.key === "+") return "in";
    if (e.key === "-") return "out";
    return null;
  }
  if (e.shiftKey && !mod) {
    if (e.code === "Digit0") return "100";
    if (e.code === "Digit1") return "fit";
    if (e.code === "Digit2") return "selection";
  }
  return null;
}

/** Listens for the zoom shortcuts on the window (not while typing in a field). */
export function useZoomShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target)) return;
      const cmd = zoomCommandFor(e);
      if (!cmd) return;
      e.preventDefault();
      runZoom(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
