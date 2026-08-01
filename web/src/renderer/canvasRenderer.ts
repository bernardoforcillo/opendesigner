import type { SceneState, NodeLite } from "../store/types";
import type { Camera } from "../canvas/camera";

function sortedVisible(state: SceneState): NodeLite[] {
  return Object.values(state.nodes)
    .filter((n) => n.visible)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

function cssColor(n: NodeLite): string {
  const f = n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 };
  const to255 = (v: number) => Math.round(v * 255);
  return `rgba(${to255(f.r)}, ${to255(f.g)}, ${to255(f.b)}, ${f.a})`;
}

export function drawScene(ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera): void {
  const { canvas } = ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, cam.x, cam.y);
  for (const n of sortedVisible(state)) {
    ctx.globalAlpha = n.opacity;
    ctx.fillStyle = cssColor(n);
    ctx.fillRect(n.x, n.y, n.width, n.height);
  }
  ctx.globalAlpha = 1;
}

// hitTest in coordinate mondo (già trasformate). Ritorna il nodo più in alto.
export function hitTest(state: SceneState, wx: number, wy: number): string | null {
  const nodes = sortedVisible(state);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) return n.id;
  }
  return null;
}
