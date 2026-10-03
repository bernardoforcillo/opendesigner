import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Camera } from "../canvas/camera";
import type { SceneState } from "../store/types";
import { poseScene } from "../animation/pose";
import {
  autoClipsForScreen, clipsUnder, pointerClipsForScreen, sampleRuns, startRuns, type ClipRun,
} from "../animation/runtime";

// LE ANIMAZIONI DEL PROTOTIPO ("Presenta"): collega il runtime puro
// (animation/runtime.ts) al player.
//  - `enter` e `loop`: partono quando la schermata compare (anche tornando
//    indietro: la schermata riparte da capo);
//  - `hover`: parte quando il puntatore entra nel box del bersaglio, e quando
//    esce lo stato torna di colpo a quello di base (come l'export HTML);
//  - `tap`: parte alla pressione sul bersaglio, una volta.
// Il ciclo requestAnimationFrame gira SOLO finché una clip sta girando: una
// schermata ferma (o senza clip) non pianifica frame.
export function useProtoAnimation(
  scene: SceneState | null,
  screenId: string | null,
  cam: Camera | null,
  stage: React.RefObject<HTMLElement | null>,
) {
  const runs = useRef<ClipRun[]>([]);
  const hovering = useRef<Map<string, ClipRun>>(new Map());
  const raf = useRef(0);
  // Il frame corrente: il disegno si rifà quando cambia (è una dipendenza dell'effetto di disegno).
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

  // La schermata cambia (o il documento): si ripartono le clip d'ingresso e di loop.
  useEffect(() => {
    hovering.current = new Map();
    runs.current = scene && screenId ? startRuns(autoClipsForScreen(scene, screenId), now()) : [];
    if (runs.current.length > 0) kick();
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // Solo la schermata: una modifica del documento a prototipo aperto non fa ripartire l'ingresso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenId]);

  // Dal puntatore (px dello stage) al mondo.
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
    // Il tocco vale finché si tiene premuto (come `:active` nel codice esportato).
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

  /** La scena da disegnare ADESSO: quella derivata con lo stato campionato sopra (la stessa istanza se niente anima). */
  const pose = useCallback(
    (derived: SceneState): SceneState => {
      const all = [...runs.current, ...hovering.current.values()];
      if (all.length === 0) return derived;
      const { anim } = sampleRuns(all, now());
      return anim.size === 0 ? derived : poseScene(derived, anim);
    },
    // `tick` non è letto: ma un nuovo `pose` dice al disegno che c'è un frame nuovo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  );

  return useMemo(() => ({ tick, pose, handlers: { onPointerMove, onPointerLeave, onPointerDown, onPointerUp, onPointerCancel: onPointerUp } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, pose, scene, screenId, cam]);
}
