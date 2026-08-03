import type { SyncClient } from "../rpc/syncClient";
import type { SceneState } from "../store/types";
import type { Camera } from "../canvas/camera";

export type ToolId = "select" | "rect" | "ellipse" | "text" | "pen" | "hand";

// Tutto quello che un tool può toccare del mondo esterno passa da qui: niente
// import diretti di DOM/camera dentro i tool, così sono testabili senza browser.
export interface ToolContext {
  sync: SyncClient;
  getScene: () => SceneState | null;
  getCamera: () => Camera;
  setCamera: (c: Camera) => void;
  canvas: HTMLCanvasElement;
  // UNICA conversione schermo -> mondo dell'app: passa da canvas/camera.ts.
  // Nessun tool deve ricalcolare la trasformazione a mano.
  toWorld: (e: PointerEvent) => { x: number; y: number };
}

// Un tool è un oggetto di handler puri: il routing degli eventi (e il pointer
// capture) è responsabilità di toolManager.attachTools.
export interface Tool {
  readonly id: ToolId;
  readonly cursor: string;
  onPointerDown?(e: PointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: PointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: PointerEvent, ctx: ToolContext): void;
  onKeyDown?(e: KeyboardEvent, ctx: ToolContext): void;
  // Chiamato quando il tool smette di essere quello attivo (cambio tool,
  // pointercancel, smontaggio): serve ad abbandonare un gesto a metà senza
  // emettere op.
  onDeactivate?(ctx: ToolContext): void;
}
