import { useEffect, useRef, useState } from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { docClient } from "../rpc/client";
import { SyncClient } from "../rpc/syncClient";
import { useScene } from "../store/store";
import { drawScene, resizeCanvasToDisplaySize } from "../renderer/canvasRenderer";
import { drawOverlay } from "../renderer/overlayRenderer";
import { screenToWorld } from "../canvas/camera";
import { attachTools, eventToCanvasPoint } from "../tools/toolManager";
import type { Tool, ToolContext, ToolId } from "../tools/types";
import { selectTool } from "../tools/selectTool";
import { rectTool } from "../tools/rectTool";
import { handTool } from "../tools/handTool";

// Registro dei tool disponibili: la toolbar sceglie una chiave, attachTools
// instrada gli eventi al tool corrispondente. L'ellisse arriva col task 10.
const TOOLS: Partial<Record<ToolId, Tool>> = {
  select: selectTool,
  rect: rectTool,
  hand: handTool,
};

const TOOL_LABELS: { id: ToolId; label: string }[] = [
  { id: "select", label: "Seleziona" },
  { id: "rect", label: "Rettangolo" },
  { id: "hand", label: "Mano" },
];

const CLIENT_ID = crypto.randomUUID();
const DOC_KEY = "brawt.docId";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // Il manager legge il tool attivo da un ref: attachTools viene collegato una
  // volta sola al mount, quindi non deve dipendere dall'identità della closure.
  const toolRef = useRef<ToolId>("select");
  const [toolId, setToolId] = useState<ToolId>("select");
  const [status, setStatus] = useState<"connecting" | "ready" | "error">("connecting");

  // bootstrap: documento + SyncClient + tool
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;

    (async () => {
      try {
        let docId = localStorage.getItem(DOC_KEY);
        if (!docId) {
          const info = await docClient.createDocument({ name: "Untitled" });
          docId = info.id;
          localStorage.setItem(DOC_KEY, docId);
        }
        const sync = new SyncClient(docId, CLIENT_ID);
        await sync.start();
        // L'effetto può essere già stato smontato (StrictMode in dev, o unmount
        // rapido): in quel caso non agganciare listener che nessuno rimuoverà.
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Il contesto è l'unico ponte fra i tool e il resto dell'app: store,
        // camera e la sola conversione schermo -> mondo (via canvas/camera.ts).
        const ctx: ToolContext = {
          sync,
          canvas,
          getScene: () => useScene.getState().scene,
          getCamera: () => useScene.getState().camera,
          setCamera: (c) => useScene.getState().setCamera(c),
          toWorld: (e) => {
            const p = eventToCanvasPoint(canvas, e);
            return screenToWorld(useScene.getState().camera, p.x, p.y);
          },
        };
        cleanup = attachTools(ctx, () => TOOLS[toolRef.current] ?? selectTool);
        setStatus("ready");
      } catch (err) {
        console.error("bootstrap failed", err);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // render loop: scena e overlay sono due canvas separati (scena sotto,
  // overlay sopra, vedi il contenitore "relative" più sotto) così l'overlay
  // -- bbox di selezione, maniglie, marquee -- può ridisegnarsi in spazio
  // schermo senza mai toccare i pixel della scena.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      const scene = useScene.getState().scene;
      if (canvas && scene) {
        resizeCanvasToDisplaySize(canvas);
        const ctx = canvas.getContext("2d");
        if (ctx) drawScene(ctx, scene, useScene.getState().camera);
      }
      if (overlay && scene) {
        resizeCanvasToDisplaySize(overlay);
        const octx = overlay.getContext("2d");
        const { camera, selection, marquee } = useScene.getState();
        if (octx) drawOverlay(octx, scene, camera, selection, marquee);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const statusLabel =
    status === "ready" ? "connesso" : status === "error" ? "errore di connessione" : "connessione…";

  return (
    <div className="flex h-screen flex-col">
      <div
        role="toolbar"
        aria-label="Strumenti"
        className="flex items-center gap-2 border-b border-neutral-200 p-2"
      >
        <ToggleButtonGroup
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[toolId]}
          className="flex gap-1"
          onSelectionChange={(keys) => {
            const next = (keys.values().next().value as ToolId | undefined) ?? "select";
            toolRef.current = next;
            setToolId(next);
          }}
        >
          {TOOL_LABELS.map((t) => (
            <ToggleButton
              key={t.id}
              id={t.id}
              className="rounded px-3 py-1 text-sm data-[selected]:bg-neutral-800 data-[selected]:text-white"
            >
              {t.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button
          className="rounded px-3 py-1 text-sm hover:bg-neutral-100"
          onPress={() => {
            localStorage.removeItem(DOC_KEY);
            location.reload();
          }}
        >
          Nuovo documento
        </Button>
        <span aria-live="polite" className="ml-auto text-sm text-neutral-500">
          {statusLabel}
        </span>
      </div>
      <div className="relative flex-1">
        {/* Il cursore viene dal tool attivo; durante un pan temporaneo (spazio
            o tasto centrale) è il tool manager a sovrascriverlo sul DOM. */}
        <canvas
          id="scene"
          ref={canvasRef}
          style={{ cursor: (TOOLS[toolId] ?? selectTool).cursor }}
          className="absolute inset-0 block h-full w-full touch-none"
        />
        {/* overlay: bbox di selezione + maniglie + marquee, in spazio schermo.
            pointer-events-none: tutti i listener restano sul canvas "scene",
            l'overlay è puramente visivo e non deve rubare eventi. */}
        <canvas id="overlay" ref={overlayRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
      </div>
    </div>
  );
}
