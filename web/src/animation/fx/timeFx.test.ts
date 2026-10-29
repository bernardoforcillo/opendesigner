// @vitest-environment node
import { describe, it, expect } from "vitest";
import { baseScene, child } from "@/flow/testSupport";
import { nodesWith } from "@/store/nodeMap";
import { sampleClip } from "@/animation/engine";
import { poseScene } from "@/animation/pose";
import { fxDef, resolveFx } from "@/animation/fx/library";

import { createRequire } from "node:module";
import type { CanvasKit } from "canvaskit-wasm";
import { DISPLACE_FRAMES, DISPLACE_SKSL } from "@/animation/fx/timeFx";

// x runs 0 -> 1000 over 1000 ms, so the pose at time t has x = t
const kf = (time: number, value: number) => ({ time, value, easing: "linear" });
function setup(fx: Record<string, number[]>) {
  const s = baseScene();
  const scene = { ...s, nodes: nodesWith(s.nodes, { n: { ...child("n", "A", 0, 0), width: 10, height: 10 } }) };
  const tracks = [{ nodeId: "n", prop: "x", keyframes: [kf(0, 0), kf(1000, 1000)] }];
  for (const [prop, [v]] of Object.entries(fx)) tracks.push({ nodeId: "n", prop, keyframes: [kf(0, v)] });
  const clip = { tracks };
  const at = (t: number) => sampleClip(clip, Math.min(1000, Math.max(0, t)));
  const pose = (t: number) => poseScene(scene, at(t), { t, at: (dt) => at(t + dt) }).nodes.at("n");
  return { pose };
}
const xs = (n: ReturnType<ReturnType<typeof setup>["pose"]>) => n.animEcho!.samples.map((x) => Math.round(x.node.x));

describe("time effects re-pose the node at other moments", () => {
  it("echo: the past poses oldest first, then now; weights decay", () => {
    const { pose } = setup({ "fx.ec.time.echo.echoTime": [-0.1], "fx.ec.time.echo.echoes": [3], "fx.ec.time.echo.decay": [0.5] });
    const n = pose(500);
    expect(n.animEcho!.mode).toBe("plus");
    expect(xs(n)).toEqual([200, 300, 400, 500]);
    expect(n.animEcho!.samples.map((s) => s.weight)).toEqual([0.25, 0.5, 1, 1]);
  });

  it("motion blur: samples spread over the shutter ending now and add up to 1", () => {
    const { pose } = setup({ "fx.ec.time.pixelmotionblur.shutterAngle": [360], "fx.ec.time.pixelmotionblur.samples": [5], "fx.ec.time.pixelmotionblur.fps": [10] });
    const n = pose(600);
    expect(xs(n)).toEqual([500, 525, 550, 575, 600]);
    expect(n.animEcho!.samples.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1);
  });

  it("posterize time holds the pose for a whole frame", () => {
    const { pose } = setup({ "fx.ec.time.posterizetime.fps": [10] });
    expect(xs(pose(640))).toEqual([600]);
    expect(xs(pose(699))).toEqual([600]);
    expect(xs(pose(700))).toEqual([700]);
  });

  it("timewarp doubles the speed and never goes before the start", () => {
    const { pose } = setup({ "fx.ec.time.timewarp.speed": [200] });
    expect(xs(pose(300))).toEqual([600]);
    const back = setup({ "fx.ec.time.timewarp.speed": [-100] }).pose(300);
    expect(xs(back)).toEqual([0]);
  });

  it("time difference blends the past under now with Difference", () => {
    const n = setup({ "fx.ec.time.timedifference.offset": [-0.2] }).pose(500);
    expect(n.animEcho!.mode).toBe("difference");
    expect(xs(n)).toEqual([300, 500]);
  });

  it("wide time spans both sides and the nodes carry no nested echo", () => {
    const n = setup({ "fx.ec.time.ccwidetime.forward": [1], "fx.ec.time.ccwidetime.backward": [1], "fx.ec.time.ccwidetime.interval": [0.1] }).pose(500);
    expect(xs(n)).toEqual([400, 500, 600]);
    for (const s of n.animEcho!.samples) expect(s.node.animEcho).toBeUndefined();
  });

  it("without a time source, or without a time effect, nothing is added", () => {
    expect(fxDef("ec.time.echo")!.time).toBeTypeOf("function");
    expect(resolveFx(fxDef("ec.time.echo")!, undefined).echoes).toBe(8);
    const s = baseScene();
    const scene = { ...s, nodes: nodesWith(s.nodes, { n: child("n", "A", 0, 0) }) };
    const anim = sampleClip({ tracks: [{ nodeId: "n", prop: "fx.ec.time.echo.echoes", keyframes: [kf(0, 3)] }] }, 0);
    expect(poseScene(scene, anim).nodes.at("n").animEcho).toBeUndefined();
  });

  it("time displacement: frames spread over +-max, the node now is the last (the map)", () => {
    const n = setup({ "fx.ec.time.timedisplacement.maxDisplacement": [0.35] }).pose(500);
    expect(n.animEcho!.mode).toBe("displace");
    expect(n.animEcho!.samples).toHaveLength(DISPLACE_FRAMES + 1);
    expect(xs(n)).toEqual([150, 250, 350, 450, 550, 650, 750, 850, 500]);
    expect(n.animEcho!.uniforms).toEqual([0, 1, 0]);
  });
});

// The real shader: with solid-colour "frames", the map value picks the frame.
describe("time displacement shader", () => {
  it("compiles and picks frame i for map value i / 7, blending between", async () => {
    const require = createRequire(import.meta.url);
    const init = require("canvaskit-wasm/bin/full/canvaskit.js") as (o: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
    const wasm = require.resolve("canvaskit-wasm/bin/full/canvaskit.wasm");
    const CK = await init({ locateFile: () => wasm });
    const effect = CK.RuntimeEffect.Make(DISPLACE_SKSL, (e) => { throw new Error(e); })!;
    const frames = Array.from({ length: DISPLACE_FRAMES }, (_, i) => CK.Shader.MakeColor(CK.Color4f(i / 7, 0, 0, 1), CK.ColorSpace.SRGB));
    const render = (gray: number, uniforms = [0, 1, 0]) => {
      const surface = CK.MakeSurface(4, 4)!;
      const map = CK.Shader.MakeColor(CK.Color4f(gray, gray, gray, 1), CK.ColorSpace.SRGB);
      const sh = effect.makeShaderWithChildren([0, 0, 4, 4, ...uniforms, ...new Array(9).fill(0)], [map, ...frames]);
      const p = new CK.Paint();
      p.setShader(sh);
      surface.getCanvas().drawRect(CK.XYWHRect(0, 0, 4, 4), p);
      const px = surface.getCanvas().readPixels(0, 0, { width: 1, height: 1, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
      p.delete(); sh.delete(); map.delete(); surface.delete();
      return px[0];
    };
    expect(render(0)).toBe(0);                       // frame 0
    expect(render(1)).toBe(255);                     // frame 7
    expect(render(3 / 7)).toBeCloseTo(255 * 3 / 7, -1);
    expect(render(1, [0, 1, 1])).toBe(0);            // inverted map
  }, 60_000);
});
