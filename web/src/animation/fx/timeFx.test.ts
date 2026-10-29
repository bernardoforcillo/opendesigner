import { describe, it, expect } from "vitest";
import { baseScene, child } from "@/flow/testSupport";
import { nodesWith } from "@/store/nodeMap";
import { sampleClip } from "@/animation/engine";
import { poseScene } from "@/animation/pose";
import { fxDef, resolveFx } from "@/animation/fx/library";

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
});
