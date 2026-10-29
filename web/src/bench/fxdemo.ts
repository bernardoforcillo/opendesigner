import { CanvasKitRenderer } from "@/renderer/ck/ckRenderer";
import { FontBook, loadCanvasKit } from "@/renderer/ck/canvaskit";
import { NodeMap } from "@/store/nodeMap";
import { emptyScene } from "@/store/types";
import type { NodeLite, SceneState } from "@/store/types";
import { sampleClip } from "@/animation/engine";
import { poseScene } from "@/animation/pose";

// Draws EffectCraft effect tracks through the REAL pipeline (clip -> pose -> CanvasKitRenderer on WebGL), one node per
// effect, so the offscreen kernels, layers, time effects and the lookup-table read-back can be looked at.
const images = { get: () => ({ status: "missing" as const, image: null }) };
let k = 0;
const node = (id: string, x: number, y: number, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: `a${String(k++).padStart(4, "0")}`, name: id, visible: true, opacity: 1,
  x, y, width: 100, height: 100, rotation: 0, strokes: [], kind: "rect", cornerRadius: 14, clipsContent: false,
  fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 1, stops: [
    { color: { r: 0.95, g: 0.35, b: 0.2, a: 1 }, position: 0 }, { color: { r: 0.2, g: 0.5, b: 0.95, a: 1 }, position: 1 }] } }],
  ...over,
});
const lowContrast = { fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: { kind: "linear" as const, x1: 0, y1: 0, x2: 1, y2: 0, stops: [
  { color: { r: 0.32, g: 0.32, b: 0.34, a: 1 }, position: 0 }, { color: { r: 0.62, g: 0.6, b: 0.58, a: 1 }, position: 1 }] } }] };

// [label, node overrides, tracks: prop -> [value at t0, value at t1]]
type Case = [string, Partial<NodeLite>, Record<string, [number, number]>];
const SET1: Case[] = [
  ["blur", {}, { "fx.ec.blur.gaussian.blurriness": [12, 12] }],
  ["wave (kernel)", {}, { "fx.ec.distort.wavewarp.height": [8, 8], "fx.ec.distort.wavewarp.width": [40, 40] }],
  ["mosaic (kernel)", {}, { "fx.ec.stylize.mosaic.h": [8, 8], "fx.ec.stylize.mosaic.v": [8, 8] }],
  ["twirl rotated", { rotation: 25 }, { "fx.ec.distort.twirl.angle": [160, 160], "fx.ec.distort.twirl.radius": [70, 70] }],
  ["autolevels (LUT)", lowContrast, { "fx.ec.color.autolevels.blend": [0, 0] }],
  ["equalize (LUT)", lowContrast, { "fx.ec.color.equalize.amount": [100, 100] }],
  ["grain (overlay)", {}, { "fx.ec.noise.addgrain.intensity": [4, 4] }],
  ["linear wipe", {}, { "fx.ec.transition.linearwipe.completion": [0, 100] }],
  ["blur + mosaic chain", {}, { "fx.ec.blur.gaussian.blurriness": [4, 4], "fx.ec.stylize.mosaic.h": [10, 10], "fx.ec.stylize.mosaic.v": [10, 10] }],
  ["echo (time)", { width: 50, height: 50 }, { x: [20, 200], "fx.ec.time.echo.echoes": [6, 6], "fx.ec.time.echo.echoTime": [-0.06, -0.06], "fx.ec.time.echo.operator": [4, 4] }],
  ["motion blur (time)", { width: 50, height: 50 }, { x: [20, 200], "fx.ec.time.pixelmotionblur.shutterAngle": [360, 360], "fx.ec.time.pixelmotionblur.fps": [8, 8] }],
  ["time displace", {}, { x: [0, 60], "fx.ec.time.timedisplacement.maxDisplacement": [0.25, 0.25] }],
  ["drop shadow (kernel)", {}, { "fx.ec.perspective.dropshadow.distance": [10, 10], "fx.ec.perspective.dropshadow.softness": [8, 8] }],
  ["sphere", {}, { "fx.ec.perspective.ccsphere.radius": [55, 55] }],
  ["hex tile", {}, { "fx.ec.stylize.cchextile.size": [16, 16] }],
  ["glow", {}, { "fx.ec.stylize.glow.radius": [14, 14] }],
];
const A = "fx.ec.";
const SET2: Case[] = [
  ["shatter", {}, { [A + "sim.shatter.phase"]: [0, 60], [A + "sim.shatter.piece"]: [14, 14] }],
  ["card dance", {}, { [A + "sim.carddance.phase"]: [0, 80], [A + "sim.carddance.piece"]: [20, 20] }],
  ["card wipe", {}, { [A + "transition.cardwipe.completion"]: [0, 100], [A + "transition.cardwipe.piece"]: [20, 20] }],
  ["pixel polly", {}, { [A + "sim.ccpixelpolly.phase"]: [0, 70] }],
  ["particle world", {}, { [A + "sim.ccparticleworld.phase"]: [0, 720] }],
  ["particle playground", {}, { [A + "sim.particleplayground.phase"]: [0, 360] }],
  ["numbers", {}, { [A + "text.numbers.value"]: [0, 1234.5], [A + "text.numbers.decimals"]: [1, 1], [A + "text.numbers.commas"]: [1, 1], [A + "text.numbers.size"]: [18, 18] }],
  ["timecode", {}, { [A + "text.timecode.seconds"]: [0, 61.5], [A + "text.timecode.size"]: [14, 14] }],
  ["wave world", {}, { [A + "sim.waveworld.phase"]: [0, 360] }],
  ["mercury", {}, { [A + "sim.ccmrmercury.phase"]: [0, 360] }],
  ["hair", {}, { [A + "sim.cchair.length"]: [22, 22] }],
  ["bezier warp", {}, { [A + "distort.bezierwarp.top"]: [30, 30], [A + "distort.bezierwarp.trx"]: [-10, -10], [A + "distort.bezierwarp.bly"]: [-12, -12] }],
  ["stroke (alpha edge)", {}, { [A + "generate.stroke.width"]: [4, 4], [A + "generate.stroke.hue"]: [50, 50], [A + "generate.stroke.sat"]: [90, 90] }],
  ["vegas", {}, { [A + "generate.vegas.phase"]: [0, 360], [A + "generate.vegas.width"]: [3, 3] }],
  ["depth of field", {}, { [A + "3d.depthoffield.maxBlur"]: [10, 10], [A + "3d.depthoffield.focal"]: [0.5, 0.5] }],
  ["paint bucket", {}, { [A + "generate.paintbucket.x"]: [10, 10], [A + "generate.paintbucket.y"]: [10, 10], [A + "generate.paintbucket.tolerance"]: [25, 25] }],
];
const SETS = [SET1, SET2];

function build(CASES: Case[]): { scene: SceneState; anim: (t: number) => ReturnType<typeof sampleClip> } {
  const nodes: NodeLite[] = [];
  const tracks: { nodeId: string; prop: string; keyframes: { time: number; value: number; easing: string }[] }[] = [];
  CASES.forEach(([, over, tr], i) => {
    const id = `n${i}`;
    const col = i % 4, row = Math.floor(i / 4);
    nodes.push(node(id, 40 + col * 290 + (over.width ? 0 : 0), 40 + row * 170, over));
    for (const [prop, [a, b]] of Object.entries(tr)) {
      const base = nodes[nodes.length - 1];
      const off = prop === "x" ? base.x : 0;
      tracks.push({ nodeId: id, prop, keyframes: [{ time: 0, value: a + off, easing: "linear" }, { time: 1000, value: b + off, easing: "linear" }] });
    }
  });
  const s = emptyScene("fx", "fx");
  return { scene: { ...s, nodes: NodeMap.from(nodes.map((n) => [n.id, n] as const)) }, anim: (t) => sampleClip({ tracks }, t) };
}

// @ts-expect-error exposed to Playwright
window.runFx = async (zoom = 1, t = 500, set = 0) => {
  const CASES = SETS[set] ?? SET1;
  const CK = await loadCanvasKit();
  const fonts = new FontBook(CK);
  await fonts.ready();
  const cgl = document.getElementById("cgl") as HTMLCanvasElement;
  const r = new CanvasKitRenderer(CK, cgl, fonts, images);
  const { scene, anim } = build(CASES);
  const posed = poseScene(scene, anim(t), { t, at: (dt) => anim(Math.min(1000, Math.max(0, t + dt))) });
  const errors: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { errors.push(a.join(" ")); warn(...a); };
  r.draw(posed, { x: 0, y: 0, zoom }, "page1");
  const copy = document.createElement("canvas");
  copy.width = cgl.width; copy.height = cgl.height;
  const c = copy.getContext("2d")!;
  c.fillStyle = "#2b2b30"; c.fillRect(0, 0, copy.width, copy.height);
  c.drawImage(cgl, 0, 0);
  // labels
  c.fillStyle = "#fff"; c.font = "12px sans-serif";
  CASES.forEach(([label], i) => c.fillText(label, (40 + (i % 4) * 290) * zoom, (40 + Math.floor(i / 4) * 170 - 6) * zoom));
  r.dispose();
  return { png: copy.toDataURL("image/png"), errors };
};
