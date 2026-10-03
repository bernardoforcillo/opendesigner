import type { ClipLite, SceneState } from "../store/types";
import { worldBoundsOfNode } from "../canvas/transform";
import { clipTimeline, sampleClip, type NodeAnim } from "./engine";
import { mergeAnim } from "./pose";
import { isInside } from "./timelineLogic";

// IL RUNTIME DEL PROTOTIPO: quali clip girano, da quando, e che stato campionano
// "adesso". Funzioni PURE e senza timer -- chi le usa (ui/PrototypePlayer.tsx)
// tiene la lista delle esecuzioni e il ciclo requestAnimationFrame; qui c'è solo
// la decisione. Il campionamento è lo stesso dell'editor (engine.ts + pose.ts):
// ciò che si vede nella timeline è ciò che si vede in Presenta.

/** Una clip in esecuzione: da quando (ms, orologio di chi la fa girare). */
export interface ClipRun { clip: ClipLite; startedAt: number }

/** I trigger che partono da soli quando la schermata compare. */
const AUTO_TRIGGERS = new Set(["enter", "loop"]);

/** Le clip `enter` e `loop` della schermata: il bersaglio è la schermata o sta dentro di essa. */
export function autoClipsForScreen(scene: SceneState, screenId: string): ClipLite[] {
  return Object.values(scene.clips)
    .filter((c) => AUTO_TRIGGERS.has(c.trigger) && c.tracks.length > 0 && scene.nodes.get(c.targetId) && isInside(scene, c.targetId, screenId))
    .sort(byId);
}

/** Le clip `hover` o `tap` della schermata. */
export function pointerClipsForScreen(scene: SceneState, screenId: string, trigger: "hover" | "tap"): ClipLite[] {
  return Object.values(scene.clips)
    .filter((c) => c.trigger === trigger && c.tracks.length > 0 && scene.nodes.get(c.targetId) && isInside(scene, c.targetId, screenId))
    .sort(byId);
}

const byId = (a: ClipLite, b: ClipLite) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Fra `clips`, quelle il cui BERSAGLIO contiene il punto (coordinate mondo): il
 * "passaggio" o il "tocco" su un bersaglio è dentro il suo box in mondo.
 */
export function clipsUnder(scene: SceneState, clips: readonly ClipLite[], x: number, y: number): ClipLite[] {
  return clips.filter((c) => {
    const n = scene.nodes.get(c.targetId);
    if (!n) return false;
    const b = worldBoundsOfNode(scene, n);
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  });
}

/**
 * La clip come gira DAVVERO: il trigger `loop` è "come `enter` ma senza fine"
 * (docs/animation.md), quindi ripete all'infinito qualunque sia `repeat`.
 */
export function asPlayed(clip: ClipLite): ClipLite {
  return clip.trigger === "loop" && clip.repeat >= 0 ? { ...clip, repeat: -1 } : clip;
}

/** Le esecuzioni che partono insieme a `now` per le clip date. */
export function startRuns(clips: readonly ClipLite[], now: number): ClipRun[] {
  return clips.map((clip) => ({ clip: asPlayed(clip), startedAt: now }));
}

/**
 * Lo stato campionato di tutte le esecuzioni a `now`, con le ultime che vincono
 * sulle prime; `live` dice se almeno una sta ancora girando (chi ha un ciclo di
 * frame lo tiene acceso solo finché `live`). Una clip finita RESTA applicata sul
 * suo ultimo valore (fill-mode "both" del codice esportato): un `enter` che porta
 * un elemento a opacità 1 non lo rimette a 0 quando termina.
 */
export function sampleRuns(runs: readonly ClipRun[], now: number): { anim: Map<string, NodeAnim>; live: boolean } {
  const anim = new Map<string, NodeAnim>();
  let live = false;
  for (const r of runs) {
    const { t, done } = clipTimeline(r.clip, now - r.startedAt);
    if (!done) live = true;
    mergeAnim(anim, sampleClip(r.clip, t));
  }
  return { anim, live };
}
