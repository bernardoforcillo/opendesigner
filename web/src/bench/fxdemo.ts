import { CanvasKitRenderer } from "@/renderer/ck/ckRenderer";
import { FontBook, loadCanvasKit } from "@/renderer/ck/canvaskit";
import { NodeMap } from "@/store/nodeMap";
import { emptyScene } from "@/store/types";
import type { NodeLite, SceneState } from "@/store/types";
import { sampleClip } from "@/animation/engine";
import { poseScene } from "@/animation/pose";
import { fxStringProp } from "@/animation/fx/props";
import { registerSound } from "@/animation/audio/library";

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
// An optional 4th element makes a hidden second layer for the effect (`effect`) and points the case's node at it.
// A 5th element sets string parameters: [effect, param, text].
type Layer = { effect: string; node: Partial<NodeLite>; dx?: number; dy?: number; second?: { node: Partial<NodeLite>; dx?: number; dy?: number } };
type Case = [string, Partial<NodeLite>, Record<string, [number, number]>, Layer?, [string, string, string][]?];
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
const green = [{ r: 0.2, g: 0.8, b: 0.3, a: 1 }];
const SET3: Case[] = [
  ["set matte (circle)", {}, {}, { effect: "ec.channel.setmatte", node: { kind: "ellipse", fills: green, width: 80, height: 80 }, dx: 10, dy: 10 }],
  ["set matte inverted", {}, { [A + "channel.setmatte.invert"]: [1, 1] }, { effect: "ec.channel.setmatte", node: { kind: "ellipse", fills: green, width: 80, height: 80 }, dx: 10, dy: 10 }],
  ["set matte, node rotated 30", { rotation: 30 }, {}, { effect: "ec.channel.setmatte", node: { kind: "ellipse", fills: green, width: 80, height: 80 }, dx: 10, dy: 10 }],
  ["set matte, animated layer", {}, {}, { effect: "ec.channel.setmatte", node: { kind: "ellipse", fills: green, width: 60, height: 60 }, dx: -10, dy: 20 }],
  ["blend 50%", {}, { [A + "channel.blend.ratio"]: [50, 50] }, { effect: "ec.channel.blend", node: { fills: green } }],
  ["set channels", {}, { [A + "channel.setchannels.red"]: [6, 6], [A + "channel.setchannels.blue"]: [5, 5] }, { effect: "ec.channel.setchannels", node: { fills: green } }],
  ["difference matte", {}, { [A + "key.differencematte.tolerance"]: [8, 8] }, { effect: "ec.key.differencematte", node: { cornerRadius: 14 } }],
  ["object matte, feathered", {}, { [A + "matte.objectmatte.feather"]: [10, 10] }, { effect: "ec.matte.objectmatte", node: { kind: "ellipse", fills: green, width: 70, height: 70 }, dx: 15, dy: 15 }],
  ["calculations (multiply)", {}, {}, { effect: "ec.channel.calculations", node: { fills: [{ r: 0.9, g: 0.9, b: 0.2, a: 1 }], kind: "ellipse" } }],
  ["compound arithmetic (add)", {}, { [A + "channel.compoundarithmetic.op"]: [1, 1] }, { effect: "ec.channel.compoundarithmetic", node: { fills: [{ r: 0.1, g: 0.1, b: 0.4, a: 1 }] } }],
  ["environment", {}, { [A + "perspective.ccenvironment.amount"]: [80, 80] }, { effect: "ec.perspective.ccenvironment", node: { fills: green, width: 140, height: 140 }, dx: -20, dy: -20 }],
  ["color stabilizer", {}, { [A + "color.colorstabilizer.amount"]: [100, 100] }, { effect: "ec.color.colorstabilizer", node: { fills: green } }],
  ["match grain", {}, { [A + "noise.matchgrain.amount"]: [100, 100] }, { effect: "ec.noise.matchgrain", node: { fills: green } }],
  ["cc composite (original)", {}, { [A + "channel.cccomposite.composite"]: [1, 1], [A + "stylize.mosaic.h"]: [6, 6], [A + "stylize.mosaic.v"]: [6, 6] }],
  ["layer is missing", {}, {}, { effect: "ec.channel.setmatte", node: { kind: "ellipse", fills: green, width: 80, height: 80 } }],
  ["matte + blur chain", {}, { [A + "blur.gaussian.blurriness"]: [5, 5] }, { effect: "ec.channel.setmatte", node: { kind: "ellipse", fills: green, width: 80, height: 80 }, dx: 10, dy: 10 }],
];
// a disc of one colour on a ground of another, the usual thing to cut out
const disc = { fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: { kind: "radial" as const, x1: 0.5, y1: 0.5, x2: 1, y2: 0.5, stops: [
  { color: { r: 0.95, g: 0.75, b: 0.15, a: 1 }, position: 0 }, { color: { r: 0.95, g: 0.75, b: 0.15, a: 1 }, position: 0.42 },
  { color: { r: 0.15, g: 0.35, b: 0.8, a: 1 }, position: 0.43 }, { color: { r: 0.15, g: 0.35, b: 0.8, a: 1 }, position: 1 }] } }], cornerRadius: 0 };
const white = [{ r: 1, g: 1, b: 1, a: 1 }];
const SET4: Case[] = [
  ["roto brush (rough matte)", disc, {}, { effect: "ec.matte.rotobrush", node: { kind: "ellipse", fills: white, width: 50, height: 50 }, dx: 25, dy: 25 }],
  ["roto brush: matte view", disc, { [A + "matte.rotobrush.view"]: [1, 1] }, { effect: "ec.matte.rotobrush", node: { kind: "ellipse", fills: white, width: 50, height: 50 }, dx: 25, dy: 25 }],
  ["inner/outer key", disc, {}, { effect: "ec.key.innerouter", node: { kind: "ellipse", fills: white, width: 34, height: 34 }, dx: 33, dy: 33, second: { node: { kind: "ellipse", fills: white, width: 62, height: 62 }, dx: 19, dy: 19 } }],
  ["inner/outer: matte view", disc, { [A + "key.innerouter.view"]: [1, 1] }, { effect: "ec.key.innerouter", node: { kind: "ellipse", fills: white, width: 34, height: 34 }, dx: 33, dy: 33, second: { node: { kind: "ellipse", fills: white, width: 62, height: 62 }, dx: 19, dy: 19 } }],
  ["puppet (pins)", {}, { [A + "distort.puppet.d1x"]: [0, 0], [A + "distort.puppet.d1y"]: [-25, -25], [A + "distort.puppet.d4x"]: [20, 20], [A + "distort.puppet.d4y"]: [10, 10] }],
  ["liquify (push)", {}, { [A + "distort.liquify.dx1"]: [30, 30], [A + "distort.liquify.dy1"]: [10, 10], [A + "distort.liquify.dx2"]: [-30, -30], [A + "distort.liquify.dy2"]: [-10, -10] }],
  ["liquify (twirl)", {}, { [A + "distort.liquify.mode"]: [3, 3], [A + "distort.liquify.dx1"]: [60, 60], [A + "distort.liquify.r1"]: [60, 60] }],
  ["mesh warp", {}, { [A + "distort.meshwarp.m1x"]: [18, 18], [A + "distort.meshwarp.m1y"]: [-12, -12], [A + "distort.meshwarp.m4x"]: [-18, -18], [A + "distort.meshwarp.m4y"]: [14, 14] }],
  ["reshape", disc, { [A + "distort.reshape.dw"]: [75, 75] }],
  ["write-on", {}, { [A + "generate.writeon.progress"]: [0, 100] }],
  ["glue gun", {}, { [A + "generate.ccgluegun.progress"]: [0, 100] }],
  ["mask shape (ellipse)", {}, { [A + "obsolete.mochashape.w"]: [70, 70], [A + "obsolete.mochashape.feather"]: [10, 10] }],
];
const wave = { kind: "vector" as const, fills: [], strokes: [{ color: { r: 1, g: 1, b: 1, a: 0.5 }, weight: 1, align: "center" as const }], width: 100, height: 60, cornerRadius: 0, vector: { subpaths: [{ closed: false, anchors: [
  { x: 0, y: 40, inX: 0, inY: 0, outX: 25, outY: -50 }, { x: 100, y: 40, inX: -25, inY: 50, outX: 0, outY: 0 }] }] } };
const SET5: Case[] = [
  ["basic text", {}, {}, undefined, [["ec.obsolete.basictext", "text", "Hello, effects"], ["ec.obsolete.basictext", "font", "Inter"]]],
  ["basic text: size, weight, colour", {}, { [A + "obsolete.basictext.size"]: [26, 26], [A + "obsolete.basictext.weight"]: [700, 700], [A + "obsolete.basictext.hue"]: [50, 50], [A + "obsolete.basictext.sat"]: [90, 90] }, undefined, [["ec.obsolete.basictext", "text", "Bold\nyellow\ntext"]]],
  ["basic text: unicode, wrapped", {}, { [A + "obsolete.basictext.size"]: [16, 16], [A + "obsolete.basictext.align"]: [0, 0], [A + "obsolete.basictext.x"]: [50, 50] }, undefined, [["ec.obsolete.basictext", "text", "Ünïcode ✓ 日本語 — a longer sentence that has to wrap inside the box"]]],
  ["path text: circle", {}, { [A + "obsolete.pathtext.size"]: [13, 13], [A + "obsolete.pathtext.shape"]: [1, 1], [A + "obsolete.pathtext.radius"]: [0.38, 0.38] }, undefined, [["ec.obsolete.pathtext", "text", "Text running round a circle • "]]],
  ["path text: wave", {}, { [A + "obsolete.pathtext.size"]: [14, 14], [A + "obsolete.pathtext.shape"]: [3, 3] }, undefined, [["ec.obsolete.pathtext", "text", "Waves of words along a wave"]]],
  ["path text: on a vector layer", {}, { [A + "obsolete.pathtext.size"]: [14, 14] }, { effect: "ec.obsolete.pathtext", node: wave, dx: 0, dy: 20 }, [["ec.obsolete.pathtext", "text", "Following a drawn curve"]]],
  ["text without a string track (default)", {}, { [A + "obsolete.basictext.size"]: [22, 22] }],
  ["text + blur chain", {}, { [A + "blur.gaussian.blurriness"]: [3, 3] }, undefined, [["ec.obsolete.basictext", "text", "Blurred"]]],
];
// a sound for the audio visualisers: three tones, one rising, under a slow envelope
const SOUND_HASH = "ab".repeat(32);
{
  const sr = 44100, n = sr * 3;
  const ctx = new OfflineAudioContext(1, n, sr);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    d[i] = 0.35 * (0.6 + 0.4 * Math.sin(t * 5)) * (Math.sin(2 * Math.PI * (200 + 300 * t) * t) + 0.5 * Math.sin(2 * Math.PI * 1800 * t) + 0.25 * Math.sin(2 * Math.PI * 5200 * t));
  }
  registerSound(SOUND_HASH, b);
}
const withSound = { meta: { "audio.hash": SOUND_HASH } };
const SET6: Case[] = [
  ["spectrum bars (own sound)", withSound, { [A + "generate.audiospectrum.bands"]: [32, 32] }],
  ["spectrum line", withSound, { [A + "generate.audiospectrum.style"]: [1, 1], [A + "generate.audiospectrum.bands"]: [48, 48] }],
  ["spectrum dots, mirrored", withSound, { [A + "generate.audiospectrum.style"]: [2, 2], [A + "generate.audiospectrum.mirror"]: [1, 1], [A + "generate.audiospectrum.bands"]: [24, 24] }],
  ["spectrum of a named layer", {}, {}, { effect: "ec.generate.audiospectrum", node: { ...withSound, fills: [] } }],
  ["waveform line", withSound, { [A + "generate.audiowaveform.window"]: [60, 60] }],
  ["waveform bars", withSound, { [A + "generate.audiowaveform.style"]: [1, 1], [A + "generate.audiowaveform.window"]: [120, 120] }],
  ["waveform, animated over time", withSound, { [A + "generate.audiowaveform.thickness"]: [2, 4] }],
  ["no sound: nothing drawn", {}, { [A + "generate.audiospectrum.bands"]: [32, 32] }],
];
const SETS = [SET1, SET2, SET3, SET4, SET5, SET6];

function build(CASES: Case[]): { scene: SceneState; anim: (t: number) => ReturnType<typeof sampleClip> } {
  const nodes: NodeLite[] = [];
  const tracks: { nodeId: string; prop: string; keyframes: { time: number; value: number; easing: string }[] }[] = [];
  CASES.forEach(([label, over, tr, layer, strs], i) => {
    const id = `n${i}`;
    const col = i % 4, row = Math.floor(i / 4);
    nodes.push(node(id, 40 + col * 290, 40 + row * 170, over));
    for (const [effect, param, text] of strs ?? []) {
      tracks.push({ nodeId: id, prop: fxStringProp(effect, param, text), keyframes: [{ time: 0, value: 1, easing: "linear" }] });
    }
    if (layer) {
      // the second layer is hidden, as a matte layer usually is, and sits in the same row; "layer is missing" names a node that is not there
      const rid = label === "layer is missing" ? "gone" : `r${i}`;
      if (rid !== "gone") nodes.push(node(rid, 40 + col * 290 + (layer.dx ?? 0), 40 + row * 170 + (layer.dy ?? 0), { visible: false, ...layer.node }));
      tracks.push({ nodeId: id, prop: `fx.${layer.effect}.layer.${rid}`, keyframes: [{ time: 0, value: 1, easing: "linear" }] });
      if (layer.second) {
        const sid = `s${i}`;
        nodes.push(node(sid, 40 + col * 290 + (layer.second.dx ?? 0), 40 + row * 170 + (layer.second.dy ?? 0), { visible: false, ...layer.second.node }));
        tracks.push({ nodeId: id, prop: `fx.${layer.effect}.layer2.${sid}`, keyframes: [{ time: 0, value: 1, easing: "linear" }] });
      }
    }
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
window.runFx = async (zoom = 1, t = 500, set = 0, pan = 0) => {
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
  // pan > 0: draw the SAME scene again with the camera moved, which is what the renderer's frame reuse is for
  let exact = true;
  if (pan !== 0) exact = r.draw(posed, { x: pan, y: 0, zoom }, "page1");
  const copy = document.createElement("canvas");
  copy.width = cgl.width; copy.height = cgl.height;
  const c = copy.getContext("2d")!;
  c.fillStyle = "#2b2b30"; c.fillRect(0, 0, copy.width, copy.height);
  c.drawImage(cgl, 0, 0);
  // labels
  c.fillStyle = "#fff"; c.font = "12px sans-serif";
  CASES.forEach(([label], i) => c.fillText(label, (40 + (i % 4) * 290) * zoom + pan, (40 + Math.floor(i / 4) * 170 - 6) * zoom));
  r.dispose();
  return { png: copy.toDataURL("image/png"), errors, exact };
};
