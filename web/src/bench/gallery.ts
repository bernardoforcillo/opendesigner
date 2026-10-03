import { NodeMap } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";

// Una scena che prova, in 1200x800, ogni cosa che i due renderer devono disegnare
// uguale: forme, tratti (centro/dentro/fuori), gradienti, effetti, rotazione,
// ritaglio, gruppi, testo, vettoriale, segnaposto di immagine, istanze.
let k = 0;
const key = () => `a${String(k++).padStart(4, "0")}`;

function base(id: string, over: Partial<NodeLite>): NodeLite {
  return {
    id, parentId: "page1", orderKey: key(), name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80, rotation: 0,
    fills: [{ r: 0.2, g: 0.45, b: 0.9, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

const black = { r: 0, g: 0, b: 0, a: 1 };
const style = (over: Record<string, unknown> = {}) => ({ fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const, ...over });

export function makeGallery(): SceneState {
  k = 0;
  const nodes: NodeLite[] = [
    // fila 1: forme base
    base("rect", { x: 30, y: 30, cornerRadius: 0, fills: [{ r: 0.9, g: 0.3, b: 0.3, a: 1 }] }),
    base("rrect", { x: 160, y: 30, cornerRadius: 18, fills: [{ r: 0.3, g: 0.7, b: 0.4, a: 1 }] }),
    base("ellipse", { x: 290, y: 30, kind: "ellipse", fills: [{ r: 0.95, g: 0.7, b: 0.2, a: 1 }] }),
    base("alpha", { x: 420, y: 30, fills: [{ r: 0.5, g: 0.2, b: 0.8, a: 0.5 }], opacity: 0.8 }),
    // fila 1b: due rettangoli sovrapposti con opacità
    base("ov1", { x: 560, y: 30, width: 70, height: 70, fills: [{ r: 1, g: 0, b: 0, a: 1 }], opacity: 0.6 }),
    base("ov2", { x: 600, y: 50, width: 70, height: 70, fills: [{ r: 0, g: 0, b: 1, a: 1 }], opacity: 0.6 }),

    // fila 2: tratti
    base("strokeC", { x: 30, y: 150, fills: [{ r: 0.9, g: 0.9, b: 0.9, a: 1 }], strokes: [{ color: black, weight: 8, align: "center" }] }),
    base("strokeI", { x: 160, y: 150, fills: [{ r: 0.9, g: 0.9, b: 0.9, a: 1 }], cornerRadius: 14, strokes: [{ color: { r: 0.8, g: 0.1, b: 0.1, a: 1 }, weight: 10, align: "inside" }] }),
    base("strokeO", { x: 290, y: 150, kind: "ellipse", fills: [{ r: 0.9, g: 0.9, b: 0.9, a: 1 }], strokes: [{ color: { r: 0.1, g: 0.5, b: 0.2, a: 1 }, weight: 10, align: "outside" }] }),
    base("strokeNoFill", { x: 420, y: 150, fills: [], strokes: [{ color: black, weight: 3, align: "center" }] }),

    // fila 3: gradienti
    base("lin", { x: 30, y: 270, fills: [{ r: 1, g: 0, b: 0, a: 1, gradient: {
      kind: "linear", x1: 0, y1: 0, x2: 1, y2: 1,
      stops: [{ color: { r: 1, g: 0.2, b: 0.2, a: 1 }, position: 0 }, { color: { r: 0.2, g: 0.2, b: 1, a: 1 }, position: 1 }],
    } }] }),
    base("rad", { x: 160, y: 270, kind: "ellipse", fills: [{ r: 1, g: 1, b: 0, a: 1, gradient: {
      kind: "radial", x1: 0.5, y1: 0.5, x2: 1, y2: 0.5,
      stops: [{ color: { r: 1, g: 1, b: 0.2, a: 1 }, position: 0 }, { color: { r: 0.9, g: 0.1, b: 0.5, a: 0 }, position: 1 }],
    } }] }),
    base("lin3", { x: 290, y: 270, fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: {
      kind: "linear", x1: 0, y1: 0.5, x2: 1, y2: 0.5,
      stops: [
        { color: { r: 0.1, g: 0.8, b: 0.3, a: 1 }, position: 0 }, { color: { r: 1, g: 0.9, b: 0.1, a: 1 }, position: 0.5 },
        { color: { r: 0.9, g: 0.1, b: 0.1, a: 1 }, position: 1 },
      ],
    } }] }),

    // fila 4: effetti
    base("shadow", { x: 30, y: 400, fills: [{ r: 1, g: 1, b: 1, a: 1 }], strokes: [{ color: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, weight: 1, align: "center" }],
      effects: [{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 6, offsetY: 10, blur: 16 }] }),
    base("blur", { x: 160, y: 400, fills: [{ r: 0.9, g: 0.2, b: 0.5, a: 1 }], effects: [{ kind: "layerBlur", radius: 6 }] }),
    base("shblur", { x: 290, y: 400, kind: "ellipse", fills: [{ r: 0.2, g: 0.6, b: 0.9, a: 1 }],
      effects: [{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.6 }, offsetX: 8, offsetY: 8, blur: 6 }, { kind: "layerBlur", radius: 1.5 }] }),

    // fila 5: rotazione, frame ritagliante, gruppo
    base("rot", { x: 430, y: 410, width: 120, height: 50, rotation: 30, fills: [{ r: 0.2, g: 0.2, b: 0.2, a: 1 }], strokes: [{ color: { r: 1, g: 0.8, b: 0, a: 1 }, weight: 4, align: "center" }] }),
    base("clip", { x: 620, y: 150, width: 140, height: 100, kind: "frame", clipsContent: true, fills: [{ r: 0.95, g: 0.95, b: 0.8, a: 1 }] }),
    base("clipKid", { x: 90, y: 50, parentId: "clip", width: 120, height: 90, fills: [{ r: 0.9, g: 0.2, b: 0.2, a: 1 }] }),
    base("clipKid2", { x: -20, y: -20, parentId: "clip", width: 60, height: 60, kind: "ellipse", fills: [{ r: 0.2, g: 0.2, b: 0.9, a: 1 }] }),
    base("bare", { x: 800, y: 150, width: 140, height: 100, kind: "frame", clipsContent: false, fills: [] }),
    base("bareKid", { x: 20, y: 20, parentId: "bare", width: 80, height: 50, fills: [{ r: 0.1, g: 0.6, b: 0.6, a: 1 }] }),
    base("group", { x: 960, y: 150, width: 0, height: 0, kind: "group" }),
    base("gA", { x: 0, y: 0, parentId: "group", width: 50, height: 50, fills: [{ r: 0.9, g: 0.5, b: 0.1, a: 1 }] }),
    base("gB", { x: 40, y: 30, parentId: "group", width: 50, height: 50, kind: "ellipse", fills: [{ r: 0.1, g: 0.5, b: 0.9, a: 0.8 }] }),
    base("rotFrame", { x: 800, y: 290, width: 130, height: 90, kind: "frame", clipsContent: true, rotation: 15, fills: [{ r: 0.85, g: 0.9, b: 1, a: 1 }] }),
    base("rotFrameKid", { x: 60, y: 30, parentId: "rotFrame", width: 120, height: 80, fills: [{ r: 0.9, g: 0.3, b: 0.3, a: 1 }] }),

    // fila 6: testo
    base("t1", { x: 30, y: 530, width: 240, height: 80, kind: "text", fills: [{ r: 0.1, g: 0.1, b: 0.1, a: 1 }],
      text: { content: "Hello, design world. This line wraps inside its box.", style: style() } }),
    base("t2", { x: 300, y: 530, width: 220, height: 40, kind: "text", fills: [{ r: 0.8, g: 0.1, b: 0.3, a: 1 }],
      text: { content: "Bold centered", style: style({ fontWeight: "700", fontSize: 22, align: "center" }) } }),
    base("t3", { x: 560, y: 530, width: 220, height: 40, kind: "text", fills: [{ r: 0.1, g: 0.4, b: 0.8, a: 1 }],
      text: { content: "Right aligned 24px", style: style({ fontSize: 24, align: "right" }) } }),
    base("t4", { x: 30, y: 640, width: 300, height: 40, kind: "text", fills: [{ r: 0, g: 0, b: 0, a: 1 }],
      strokes: [{ color: { r: 1, g: 0.5, b: 0, a: 1 }, weight: 1, align: "center" }],
      text: { content: "Stroked & 2 lines\nsecond line", style: style({ fontSize: 28, fontWeight: "700" }) } }),
    base("t5", { x: 360, y: 640, width: 200, height: 40, kind: "text", fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: {
      kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0,
      stops: [{ color: { r: 0.9, g: 0.1, b: 0.1, a: 1 }, position: 0 }, { color: { r: 0.1, g: 0.1, b: 0.9, a: 1 }, position: 1 }],
    } }], text: { content: "Gradient text", style: style({ fontSize: 26, fontWeight: "700" }) } }),
    base("t6", { x: 600, y: 640, width: 200, height: 60, kind: "text", fills: [{ r: 0.1, g: 0.1, b: 0.1, a: 1 }],
      effects: [{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.4 }, offsetX: 3, offsetY: 3, blur: 4 }],
      text: { content: "Shadowed", style: style({ fontSize: 30, fontWeight: "700" }) } }),

    // fila 7: vettoriale
    base("vOpen", { x: 800, y: 420, width: 100, height: 60, kind: "vector", fills: [{ r: 0.8, g: 0.1, b: 0.1, a: 1 }],
      vector: { subpaths: [{ closed: false, anchors: [
        { x: 0, y: 50, inX: 0, inY: 0, outX: 20, outY: -60 }, { x: 50, y: 0, inX: -20, inY: 0, outX: 20, outY: 0 }, { x: 100, y: 50, inX: -20, inY: -60, outX: 0, outY: 0 },
      ] }] } }),
    base("vHole", { x: 930, y: 410, width: 90, height: 90, kind: "vector", fills: [{ r: 0.2, g: 0.5, b: 0.8, a: 1 }],
      vector: { subpaths: [
        { closed: true, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 90, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 90, y: 90, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 0, y: 90, inX: 0, inY: 0, outX: 0, outY: 0 }] },
        { closed: true, anchors: [{ x: 25, y: 25, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 65, y: 25, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 65, y: 65, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 25, y: 65, inX: 0, inY: 0, outX: 0, outY: 0 }] },
      ] } }),
    base("vDot", { x: 1060, y: 430, width: 0, height: 0, kind: "vector", fills: [{ r: 0.1, g: 0.1, b: 0.1, a: 1 }],
      vector: { subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }] } }),

    // fila 8: immagini segnaposto e istanza
    base("imgLoading", { x: 30, y: 730, width: 120, height: 60, kind: "image", fills: [], image: { assetHash: "loading" } }),
    base("imgMissing", { x: 170, y: 730, width: 120, height: 60, kind: "image", fills: [], image: { assetHash: "missing" } }),
    base("master", { x: 0, y: 0, parentId: "components", width: 100, height: 50, kind: "frame", clipsContent: true, fills: [{ r: 0.9, g: 0.9, b: 0.95, a: 1 }] }),
    base("masterLabel", { x: 10, y: 10, parentId: "master", width: 60, height: 30, fills: [{ r: 0.3, g: 0.3, b: 0.7, a: 1 }], cornerRadius: 6 }),
    base("inst1", { x: 330, y: 735, width: 0, height: 0, kind: "instance", fills: [], instance: { componentId: "c1", overrides: [] } }),
    base("inst2", { x: 460, y: 735, width: 0, height: 0, kind: "instance", fills: [], instance: { componentId: "c1", overrides: [{ masterNodeId: "masterLabel", fills: [{ r: 0.9, g: 0.4, b: 0.1, a: 1 }] }] } }),
  ];
  const s = emptyScene("gallery", "gallery");
  return { ...s, nodes: NodeMap.from(nodes.map((n) => [n.id, n] as const)), components: { c1: { rootNodeId: "master", name: "C" } } };
}
