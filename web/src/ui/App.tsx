import { useEffect, useRef, useState } from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { docClient } from "../rpc/client";
import { SyncClient } from "../rpc/syncClient";
import { useScene } from "../store/store";
import { drawScene, resizeCanvasToDisplaySize } from "../renderer/canvasRenderer";
import { drawOverlay } from "../renderer/overlayRenderer";
import { attachRectTool } from "../tools/rectTool";

type Mode = "select" | "rect";

const CLIENT_ID = crypto.randomUUID();
const DOC_KEY = "brawt.docId";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // Il tool legge la modalità da un ref: attachRectTool viene collegato una
  // volta sola al mount, quindi non deve dipendere dall'identità della closure.
  const modeRef = useRef<Mode>("select");
  const [mode, setMode] = useState<Mode>("select");
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
        cleanup = attachRectTool(canvas, sync, () => modeRef.current);
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
          selectedKeys={[mode]}
          className="flex gap-1"
          onSelectionChange={(keys) => {
            const next = (keys.values().next().value as Mode | undefined) ?? "select";
            modeRef.current = next;
            setMode(next);
          }}
        >
          <ToggleButton
            id="select"
            className="rounded px-3 py-1 text-sm data-[selected]:bg-neutral-800 data-[selected]:text-white"
          >
            Seleziona
          </ToggleButton>
          <ToggleButton
            id="rect"
            className="rounded px-3 py-1 text-sm data-[selected]:bg-neutral-800 data-[selected]:text-white"
          >
            Rettangolo
          </ToggleButton>
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
        <canvas
          id="scene"
          ref={canvasRef}
          className={`absolute inset-0 block h-full w-full touch-none ${mode === "rect" ? "cursor-crosshair" : "cursor-default"}`}
        />
        {/* overlay: bbox di selezione + maniglie + marquee, in spazio schermo.
            pointer-events-none: tutti i listener restano sul canvas "scene",
            l'overlay è puramente visivo e non deve rubare eventi. */}
        <canvas id="overlay" ref={overlayRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
      </div>
    </div>
  );
}
