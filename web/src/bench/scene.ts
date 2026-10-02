import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

// Un documento sintetico ma realistico: una griglia di "schermate" (frame che
// ritagliano), ognuna con una ventina di figli fra rettangoli, ellissi e testi,
// e una piccola fetta di auto layout. Deterministico (PRNG con seme) così le
// misure di due esecuzioni sono confrontabili.
export function makeScene(totalNodes: number, seed = 1): SceneState {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const base = emptyScene("bench", "bench");
  const nodes: Record<string, NodeLite> = {};
  const PER_FRAME = 20;
  const frames = Math.max(1, Math.round(totalNodes / (PER_FRAME + 1)));
  const cols = Math.ceil(Math.sqrt(frames));
  let key = 0;
  const k = () => `a${String(key++).padStart(7, "0")}`;
  for (let f = 0; f < frames; f++) {
    const fid = `f${f}`;
    const fx = (f % cols) * 420, fy = Math.floor(f / cols) * 320;
    nodes[fid] = {
      id: fid, parentId: "page1", orderKey: k(), name: fid, visible: true, opacity: 1,
      x: fx, y: fy, width: 400, height: 300, rotation: 0,
      fills: [{ r: 1, g: 1, b: 1, a: 1 }], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: true,
    };
    for (let i = 0; i < PER_FRAME; i++) {
      const id = `n${f}_${i}`;
      const kind = i % 5 === 0 ? "text" : i % 3 === 0 ? "ellipse" : "rect";
      const n: NodeLite = {
        id, parentId: fid, orderKey: k(), name: id, visible: true, opacity: 1,
        x: rnd() * 300, y: rnd() * 220, width: 30 + rnd() * 90, height: 20 + rnd() * 60, rotation: 0,
        fills: [{ r: rnd(), g: rnd(), b: rnd(), a: 1 }],
        strokes: i % 4 === 0 ? [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" }] : [],
        kind, cornerRadius: kind === "rect" ? 6 : 0, clipsContent: false,
        ...(kind === "text" ? { text: { content: "Lorem ipsum dolor", style: { fontFamily: "", fontSize: 14, fontWeight: "", lineHeight: 0, align: "left" as const } } } : {}),
      };
      nodes[id] = n;
    }
  }
  return { ...base, nodes };
}

// La camera che inquadra tutto il documento in un canvas w x h.
export function fitCamera(scene: SceneState, w: number, h: number) {
  let maxX = 0, maxY = 0;
  for (const n of Object.values(scene.nodes)) {
    if (n.parentId === "page1") { maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height); }
  }
  const zoom = Math.min(w / maxX, h / maxY);
  return { x: 0, y: 0, zoom };
}
