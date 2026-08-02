import type { SceneState, NodeLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import { nodePath, hitTestNode, inkIsBox } from "./shapes";
import { drawText } from "./text";

function sortedVisible(state: SceneState): NodeLite[] {
  return Object.values(state.nodes)
    .filter((n) => n.visible)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

// Esportata perché il colore di un nodo serve anche FUORI dal canvas: il
// textarea di editing (ui/TextEditorOverlay.tsx) deve scrivere con lo stesso
// colore con cui il canvas disegnerà quel testo. Una seconda conversione
// RGBA-float -> CSS altrove sarebbe la solita coppia destinata a divergere.
export function cssColor(n: NodeLite): string {
  const f = n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 };
  const to255 = (v: number) => Math.round(v * 255);
  return `rgba(${to255(f.r)}, ${to255(f.g)}, ${to255(f.b)}, ${f.a})`;
}

// La camera resta sempre in pixel CSS: il devicePixelRatio non deve mai
// entrare nel modello né nei tool, solo qui nel disegno effettivo sul canvas.
function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Allinea la risoluzione del backing store del canvas alla sua dimensione CSS
// * devicePixelRatio, per evitare il blur su schermi HiDPI. Ritorna true se la
// dimensione è cambiata (utile per evitare resize/clear superflui ogni frame).
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = devicePixelRatio();
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

export function drawScene(ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  for (const n of sortedVisible(state)) {
    // Il guard sulla dimensione vale solo per le forme il cui inchiostro È il
    // box (rect, ellisse): per testo e vettoriale un lato a zero è uno stato
    // legittimo e disegnabile. L'elenco delle eccezioni sta in UN posto solo
    // (shapes.ts::inkIsBox), condiviso con l'hit-test: un nodo che si disegna ma
    // non si clicca -- o il contrario -- è il modo in cui i due divergono.
    if (inkIsBox(n) && (n.width <= 0 || n.height <= 0)) continue;
    ctx.globalAlpha = n.opacity;
    ctx.fillStyle = cssColor(n);
    if (n.kind === "text") {
      drawText(ctx, n);
      continue;
    }
    ctx.fill(nodePath(n));
  }
  ctx.globalAlpha = 1;
}

// hitTest in coordinate mondo (già trasformate). Ritorna il nodo più in alto.
export function hitTest(state: SceneState, wx: number, wy: number): string | null {
  const nodes = sortedVisible(state);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (hitTestNode(n, wx, wy)) return n.id;
  }
  return null;
}
