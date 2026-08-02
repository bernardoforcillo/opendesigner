import type { SceneState } from "../store/types";
import type { Camera } from "../canvas/camera";
import { type Bounds, unionBounds, worldBoundsToScreen } from "../canvas/geometry";
import { contentWorldBounds } from "../store/groups";
import { HANDLE_SIZE, handlePositions } from "../selection/handles";

// La geometria delle maniglie (posizioni, hit-test, resize) è UNA sola e vive
// in selection/handles.ts: qui si disegna soltanto. Ri-esportata perché il
// renderer resta il punto d'ingresso naturale per chi disegna l'overlay.
export { HANDLE_SIZE, handlePositions, type HandleId } from "../selection/handles";
export { worldBoundsToScreen } from "../canvas/geometry";

function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Unione (in coordinate MONDO) dei bounds dei nodi selezionati. null se la
// selezione è vuota o non punta più a nodi esistenti -- lo store toglie già
// gli id spariti dalla selezione (vedi store.ts), ma questa funzione resta
// difensiva così l'overlay non esplode su uno stato transitorio incoerente.
// Estratta apposta così è testabile senza ctx/DOM.
//
// Bounds MONDO e non del modello: il box del modello è scritto nello spazio del
// PARENT, mentre tutto ciò che sta a valle di qui (la cornice, le maniglie, il
// loro hit-test) lavora in mondo e poi in schermo. Per un nodo figlio di una
// pagina le due cose coincidono, ed è ciò che tiene fermi i documenti già
// esistenti.
//
// contentWorldBounds e non worldBoundsOfNode: un GRUPPO non ha un box proprio
// (store/groups.ts), i suoi bounds sono l'unione dei figli. Leggere il suo box
// darebbe un rettangolo 0x0 all'origine del gruppo -- cornice e maniglie
// nell'angolo sbagliato dello schermo, su un gruppo che si vede benissimo.
// Un gruppo vuoto non contribuisce nulla (null), esattamente come un id sparito.
export function selectionWorldBounds(state: SceneState, selection: string[]): Bounds | null {
  const boxes: Bounds[] = [];
  for (const id of selection) {
    const n = state.nodes[id];
    if (!n) continue;
    const b = contentWorldBounds(state, n);
    if (b) boxes.push(b);
  }
  return unionBounds(boxes);
}

// Disegna il bbox della selezione, le sue 8 maniglie e il rettangolo del
// marquee -- TUTTO in spazio SCHERMO (px CSS). A differenza di drawScene,
// qui NON si applica cam.zoom alla trasformazione del canvas: i bounds
// mondo vengono convertiti a mano via worldToScreen prima di disegnare, così
// bordi (1px) e maniglie (8px) restano di dimensione costante a ogni livello
// di zoom. L'unica trasformazione applicata è lo scale per devicePixelRatio,
// necessario perché il backing store del canvas è in pixel fisici.
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  selection: string[],
  marquee: Bounds | null,
): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const worldBox = selectionWorldBounds(state, selection);
  if (worldBox) {
    const box = worldBoundsToScreen(worldBox, cam);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2f6fed";
    // +0.5 così lo stroke da 1px cade su un confine di pixel netto invece di
    // sbavare su due righe (il classico trucco del canvas 2D).
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);

    const half = HANDLE_SIZE / 2;
    for (const p of Object.values(handlePositions(box))) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(p.x - half, p.y - half, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeStyle = "#2f6fed";
      ctx.strokeRect(p.x - half + 0.5, p.y - half + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
    }
  }

  if (marquee) {
    const m = worldBoundsToScreen(marquee, cam);
    ctx.fillStyle = "rgba(47, 111, 237, 0.08)";
    ctx.fillRect(m.x, m.y, m.width, m.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2f6fed";
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.width, m.height);
  }
}
