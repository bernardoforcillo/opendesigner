import type { SyncClient } from "../rpc/syncClient";
import type { SceneState } from "../store/types";
import type { Camera } from "../canvas/camera";

export type ToolId = "select" | "connect" | "frame" | "rect" | "ellipse" | "text" | "pen" | "hand" | "comment" | "sticky" | "link" | "vote" | "node";

// Everything a tool can touch of the outside world goes through here: no
// direct DOM/camera imports inside tools, so they are testable without a browser.
export interface ToolContext {
  sync: SyncClient;
  getScene: () => SceneState | null;
  getCamera: () => Camera;
  setCamera: (c: Camera) => void;
  canvas: HTMLCanvasElement;
  // The ONLY screen -> world conversion in the app: it goes through canvas/camera.ts.
  // No tool should recompute the transformation by hand.
  toWorld: (e: PointerEvent) => { x: number; y: number };
}

// A tool is an object of pure handlers: event routing (and pointer
// capture) is the responsibility of toolManager.attachTools.
export interface Tool {
  readonly id: ToolId;
  readonly cursor: string;
  onPointerDown?(e: PointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: PointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: PointerEvent, ctx: ToolContext): void;
  onKeyDown?(e: KeyboardEvent, ctx: ToolContext): void;
  // Called when the tool stops being the active one (tool change,
  // pointercancel, unmount): used to abandon a half-done gesture without
  // emitting ops.
  onDeactivate?(ctx: ToolContext): void;
  // Called in place of onDeactivate when what takes the slot is the TEMPORARY
  // PAN (space held or middle button, see toolManager): it is not a tool
  // change, the hand will give the slot back in a moment. A tool that
  // implements it declares that its gesture SURVIVES the pan; one that does not
  // implement it gets onDeactivate as before (for a gesture that requires the
  // button held, the pan is an interruption anyway).
  //
  // There is no symmetric resume callback: the suspended tool has nothing
  // to rebuild and resumes from the first event that comes back to it. If the
  // ACTIVE tool changes while the pan is in progress, the suspended one gets onDeactivate --
  // suspending is not keeping it alive forever.
  onSuspend?(ctx: ToolContext): void;
}
