import { useScene } from "../store/store";
import type { SceneState } from "../store/types";
import { poseScene, sampleWithDraft } from "./pose";
import { useTimeline } from "./timelineStore";

// LA SCENA CHE LA TELA MOSTRA. Con la timeline ferma (o chiusa, o prima del
// primo scorrimento) è la scena del documento, la STESSA istanza dello store:
// niente lavoro e nessun cambio di comportamento. Con la clip aperta e la posa
// accesa (si scorre, si riproduce, si registra) è la scena derivata con i valori
// campionati (animation/pose.ts). Il documento non si tocca mai.
//
// Chi la legge: il ciclo di disegno (ui/App.tsx), il contesto dei tool
// (`getScene`: la geometria su cui si trascina è quella che si vede, quindi
// registrare un movimento parte dalla posa e non dal valore di base) e il pannello
// Proprietà (mostra i valori della posa).

let memo: {
  scene: SceneState; clipRef: unknown; playhead: number; draft: unknown; out: SceneState;
} | null = null;

export function posedScene(): SceneState | null {
  const scene = useScene.getState().scene;
  if (!scene) return null;
  const tl = useTimeline.getState();
  if (!tl.open || !tl.posed || !tl.clipId) return scene;
  const clip = tl.draftClip ?? scene.clips[tl.clipId];
  if (!clip) return scene;
  if (memo && memo.scene === scene && memo.clipRef === clip && memo.playhead === tl.playhead && memo.draft === tl.recordDraft) return memo.out;
  const out = poseScene(scene, sampleWithDraft(clip, tl.playhead, tl.recordDraft));
  memo = { scene, clipRef: clip, playhead: tl.playhead, draft: tl.recordDraft, out };
  return out;
}

/** La posa è accesa? (la tela non mostra il documento). */
export function isPosing(): boolean {
  const tl = useTimeline.getState();
  return tl.open && tl.posed && !!tl.clipId;
}

/**
 * Hook React: la scena in posa, che si aggiorna a ogni cambio di scena, playhead,
 * bozza o clip. Si abbona SOLO a ciò che la posa legge, così con la timeline
 * ferma non rirenderizza niente in più.
 */
export function usePosedScene(): SceneState | null {
  const scene = useScene((s) => s.scene);
  // Mentre la clip GIRA i pannelli non seguono ogni frame (rirenderizzarli 60 volte
  // al secondo non serve a nessuno): mostrano la scena vera, e in pausa o scorrendo
  // tornano a seguire la posa.
  const playing = useTimeline((s) => s.playing);
  useTimeline((s) => (s.open && s.posed && !s.playing ? s.playhead : -1));
  useTimeline((s) => (s.open && s.posed ? s.recordDraft : null));
  useTimeline((s) => (s.open && s.posed ? s.draftClip : null));
  useTimeline((s) => (s.open && s.posed ? s.clipId : null));
  return playing ? scene : posedScene();
}
