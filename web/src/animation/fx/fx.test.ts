// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import type { CanvasKit } from "canvaskit-wasm";
import { FX_CATALOG } from "@/animation/fx/catalog";
import { invertHomography, unitSquareTo } from "@/animation/fx/kernelsDistort";
import { FX_LIBRARY, fxDef, fxParam, hsv, resolveFx } from "@/animation/fx/library";
import { buildFx, fxOutset } from "@/animation/fx/apply";
import { fxProp, isFxProp, parseFxProp } from "@/animation/fx/props";
import { isTrackProp, sampleClip } from "@/animation/engine";
import { isValidClip } from "@/animation/validate";
import { baseValueOf, clampValue, propLabel } from "@/animation/timelineLogic";
import { baseScene, child } from "@/flow/testSupport";
import { nodesWith } from "@/store/nodeMap";

describe("the catalog", () => {
  it("lists every EffectCraft effect once, with an ec.<category>.<name> id", () => {
    expect(FX_CATALOG.length).toBe(307);
    expect(new Set(FX_CATALOG.map((e) => e.id)).size).toBe(307);
    for (const e of FX_CATALOG) expect(e.id).toMatch(/^ec\.[a-z0-9]+\.[a-z0-9]+$/);
  });
  it("only implements effects that exist in it", () => {
    const ids = new Set(FX_CATALOG.map((e) => e.id));
    for (const d of FX_LIBRARY) expect(ids.has(d.id), d.id).toBe(true);
  });
  it("gives every parameter a sane range and a default inside it", () => {
    for (const d of FX_LIBRARY) {
      expect(d.params.length, d.id).toBeGreaterThan(0);
      expect([d.filter, d.overlay, d.kernel, d.time, d.carrier].filter(Boolean).length, `${d.id}: exactly one kind`).toBe(1);
      for (const p of d.params) {
        expect(p.min, `${d.id}.${p.id}`).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        expect(p.id).toMatch(/^[A-Za-z0-9]+$/);
      }
    }
  });
});

describe("effect tracks", () => {
  it("fx.<effect>.<param> is a track property; others are not", () => {
    expect(parseFxProp("fx.ec.blur.gaussian.blurriness")).toEqual({ effect: "ec.blur.gaussian", param: "blurriness" });
    expect(fxProp("ec.blur.gaussian", "blurriness")).toBe("fx.ec.blur.gaussian.blurriness");
    expect(isFxProp("fx.ec.blur.gaussian")).toBe(false);
    expect(isFxProp("width")).toBe(false);
    expect(isTrackProp("opacity")).toBe(true);
    expect(isTrackProp("fx.ec.blur.gaussian.blurriness")).toBe(true);
    expect(isTrackProp("fx.blur.gaussian.blurriness")).toBe(false);
  });

  it("samples into NodeAnim.fx and interpolates", () => {
    const clip = {
      tracks: [{ nodeId: "a", prop: "fx.ec.blur.gaussian.blurriness", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 1000, value: 100, easing: "linear" }] }],
    };
    expect(sampleClip(clip, 500).get("a")?.fx).toEqual({ "ec.blur.gaussian": { blurriness: 50 } });
  });

  it("validates like Go: a clip with an fx track is valid, a malformed one is not", () => {
    const s = baseScene();
    const scene = { ...s, nodes: nodesWith(s.nodes, { n: child("n", "A", 0, 0) }) };
    const clip = (prop: string, value = 10) => ({
      id: "c", name: "c", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "n",
      tracks: [{ nodeId: "n", prop, keyframes: [{ time: 0, value, easing: "linear" }] }],
    });
    expect(isValidClip(scene, clip("fx.ec.blur.gaussian.blurriness", 400))).toBe(true);
    expect(isValidClip(scene, clip("fx.ec.blur.gaussian"))).toBe(false);
    expect(isValidClip(scene, clip("fx.ec.blur.gaussian.blurriness", Number.NaN))).toBe(false);
  });

  it("labels, defaults and clamps through the library", () => {
    const p = "fx.ec.blur.gaussian.blurriness";
    expect(propLabel(p)).toBe("Gaussian Blur · Blurriness");
    expect(baseValueOf({ x: 0, y: 0, rotation: 0, opacity: 1 }, p)).toBe(10);
    expect(clampValue(p, 9999)).toBe(250);
    expect(clampValue(p, -5)).toBe(0);
  });

  it("resolves missing and out-of-range values", () => {
    const d = fxDef("ec.blur.gaussian")!;
    expect(resolveFx(d, undefined)).toEqual({ blurriness: 10, dimensions: 0 });
    expect(resolveFx(d, { blurriness: 1e9 }).blurriness).toBe(250);
    expect(fxParam("ec.blur.gaussian", "nope")).toBeUndefined();
  });

  it("reports how far an animated effect paints", () => {
    expect(fxOutset(undefined)).toBe(0);
    expect(fxOutset({ "ec.blur.gaussian": { blurriness: 20 } })).toBe(30);
  });

  it("hsv gives primaries", () => {
    expect(hsv(0, 1, 1).map(Math.round)).toEqual([1, 0, 0]);
    expect(hsv(120, 1, 1).map(Math.round)).toEqual([0, 1, 0]);
  });
});

// The real CanvasKit (wasm), CPU surface: every SkSL shader must compile and every effect must draw.
describe("drawing every effect with CanvasKit", () => {
  let CK: CanvasKit;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const init = require("canvaskit-wasm/bin/full/canvaskit.js") as (o: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
    const dir = require.resolve("canvaskit-wasm/bin/full/canvaskit.wasm");
    CK = await init({ locateFile: () => dir });
  }, 60_000);

  const draw = (animFx: Record<string, Record<string, number>>) => {
    const surface = CK.MakeSurface(64, 64)!;
    const sk = surface.getCanvas();
    sk.clear(CK.TRANSPARENT);
    const garbage: { delete(): void }[] = [];
    const fx = buildFx(CK, animFx, (o) => garbage.push(o));
    const paint = new CK.Paint();
    if (fx?.filter) paint.setImageFilter(fx.filter);
    sk.saveLayer(paint, CK.XYWHRect(0, 0, 64, 64));
    const body = new CK.Paint();
    // kernels: the node is drawn offscreen and read through each SkSL shader, as ckRenderer.drawLayerBody does
    const bodyPaint = (c: import("canvaskit-wasm").Canvas) => {
      const bp = new CK.Paint();
      bp.setColor(CK.Color4f(0.8, 0.3, 0.2, 1));
      c.drawRect(CK.XYWHRect(16, 16, 32, 32), bp);
      bp.delete();
    };
    let current: ((c: import("canvaskit-wasm").Canvas) => void) | null = null;
    for (const k of fx?.kernels ?? []) {
      const eff = CK.RuntimeEffect.Make(k.sksl, (err) => { throw new Error(err); });
      expect(eff).not.toBeNull();
      const off = CK.MakeSurface(64, 64)!;
      const oc = off.getCanvas();
      oc.clear(CK.TRANSPARENT);
      (current ?? bodyPaint)(oc);
      const img = off.makeImageSnapshot();
      const srcShader = img.makeShaderOptions(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Linear, CK.MipmapMode.None);
      const sh = eff!.makeShaderWithChildren([16, 16, 32, 32, ...k.uniforms], [srcShader]);
      garbage.push(off, img, srcShader, sh, eff!);
      current = (c) => { const kp = new CK.Paint(); kp.setShader(sh); c.drawRect(CK.XYWHRect(0, 0, 64, 64), kp); kp.delete(); };
    }
    (current ?? bodyPaint)(sk);
    for (const { overlay, values } of fx?.overlays ?? []) {
      const e = CK.RuntimeEffect.Make(overlay.sksl, (err) => { throw new Error(err); });
      expect(e).not.toBeNull();
      const shader = e!.makeShader([16, 16, 32, 32, ...overlay.uniforms(values)]);
      const p = new CK.Paint();
      p.setShader(shader);
      p.setBlendMode(overlay.blend === "dstin" ? CK.BlendMode.DstIn : CK.BlendMode.SrcATop);
      sk.drawRect(CK.XYWHRect(0, 0, 64, 64), p);
      p.delete(); shader.delete(); e!.delete();
    }
    sk.restore();
    const px = sk.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
    paint.delete(); body.delete(); garbage.forEach((g) => g.delete()); surface.delete();
    return px;
  };
  const at = (px: Uint8Array, x: number, y: number) => Array.from(px.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));

  it.each(FX_LIBRARY.filter((d) => !d.time).map((d) => d.id))("%s draws with defaults and at the extremes", (id) => {
    const d = fxDef(id)!;
    expect(draw({ [id]: {} }).length).toBe(64 * 64 * 4);
    expect(draw({ [id]: Object.fromEntries(d.params.map((p) => [p.id, p.min])) }).length).toBe(64 * 64 * 4);
    expect(draw({ [id]: Object.fromEntries(d.params.map((p) => [p.id, p.max])) }).length).toBe(64 * 64 * 4);
  });

  it("the blur spreads the square's edge; no effect leaves it sharp", () => {
    expect(at(draw({}), 12, 32)[3]).toBe(0);
    expect(at(draw({ "ec.blur.gaussian": { blurriness: 20 } }), 12, 32)[3]).toBeGreaterThan(0);
  });

  it("invert flips the colour, black&white removes the saturation", () => {
    const [r, g, b] = at(draw({ "ec.channel.invert": { blend: 0 } }), 32, 32);
    expect([r, g, b]).toEqual([255 - 204, 255 - 77, 255 - 51].map((v) => expect.closeTo(v, -1)));
    const bw = at(draw({ "ec.color.blackwhite": { amount: 100 } }), 32, 32);
    expect(Math.abs(bw[0] - bw[1])).toBeLessThanOrEqual(2);
  });

  it("a linear wipe at 100% removes the node, at 0% keeps it", () => {
    expect(at(draw({ "ec.transition.linearwipe": { completion: 100, angle: 90, feather: 0 } }), 32, 32)[3]).toBe(0);
    expect(at(draw({ "ec.transition.linearwipe": { completion: 0, angle: 90, feather: 0 } }), 32, 32)[3]).toBe(255);
  });

  it("an overlay only lands where the node has pixels (srcatop)", () => {
    const px = draw({ "ec.generate.fill": { hue: 120, saturation: 100, value: 100, opacity: 100 } });
    expect(at(px, 4, 4)[3]).toBe(0);
    expect(at(px, 32, 32)[1]).toBeGreaterThan(200);
  });

  it("kernels read the node's pixels: mirror reflects it, posterize quantises it, offset moves them", () => {
    // the square covers 16..48; mirroring about x = 16 puts a copy on 0..16
    expect(at(draw({}), 8, 32)[3]).toBe(0);
    expect(at(draw({ "ec.distort.mirror": { centerX: 0, centerY: 50, angle: 0 } }), 8, 32)[3]).toBe(255);
    const q = at(draw({ "ec.stylize.posterize": { level: 2 } }), 32, 32);
    for (const ch of q.slice(0, 3)) expect([0, 255]).toContain(ch);
    expect(at(draw({ "ec.distort.offset": { x: 10, y: 0 } }), 54, 32)[3]).toBe(255);
  });

  it("a kernel chain reads the previous kernel: two mirrors compose", () => {
    const once = draw({ "ec.stylize.mosaic": { h: 2, v: 2 } });
    const twice = draw({ "ec.stylize.mosaic": { h: 2, v: 2 }, "ec.distort.mirror": { centerX: 25, centerY: 50, angle: 180 } });
    expect(twice).not.toEqual(once);
  });

  it("corner pin with no offsets is the identity; the homography inverts", () => {
    const base = draw({});
    expect(at(draw({ "ec.distort.cornerpin": {} }), 32, 32)).toEqual(at(base, 32, 32));
    const m = unitSquareTo([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(invertHomography(m).map((x) => Math.round(x * 1000) / 1000 + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("carriers draw nothing and the keyer removes the key colour", () => {
    expect(at(draw({ "ec.control.slider": { slider: 5 } }), 32, 32)[3]).toBe(255);
    const keyed = draw({ "ec.key.linearcolor": { hue: 10, saturation: 75, value: 80, tolerance: 40, softness: 5, keep: 0 } });
    expect(at(keyed, 32, 32)[3]).toBeLessThan(255);
  });

  it("identity settings leave the node alone (CDL, colour space, curves, grade, hue shift of 0)", () => {
    const base = at(draw({}), 32, 32);
    const near = (a: number[], b: number[], what = "") => a.forEach((v, i) => expect(Math.abs(v - b[i]), `${what} ${a} vs ${b}`).toBeLessThanOrEqual(2));
    near(at(draw({ "ec.color.ociocdl": {} }), 32, 32), base, "ec.color.ociocdl");
    near(at(draw({ "ec.color.ociocolorspace": { from: 0, to: 0 } }), 32, 32), base, "ec.color.ociocolorspace");
    near(at(draw({ "ec.color.ociocolorspace": { from: 2, to: 2 } }), 32, 32), base, "ec.color.ociocolorspace");
    near(at(draw({ "ec.color.curves": {} }), 32, 32), base, "ec.color.curves");
    near(at(draw({ "ec.color.lumetri": {} }), 32, 32), base, "ec.color.lumetri");
    near(at(draw({ "ec.color.levelsic": {} }), 32, 32), base, "ec.color.levelsic");
    near(at(draw({ "ec.utility.colorprofileconverter": { from: 0, to: 0 } }), 32, 32), base, "ec.utility.colorprofileconverter");
  });

  it("colour space round trip and keyers behave", () => {
    // sRGB -> linear darkens a mid colour
    expect(at(draw({ "ec.utility.colorprofileconverter": { from: 0, to: 1 } }), 32, 32)[0]).toBeLessThan(at(draw({}), 32, 32)[0]);
    // a luma key that keys out darker than 255 removes the (mid-luma) square; one that keys out brighter keeps it
    expect(at(draw({ "ec.key.luma": { type: 1, threshold: 255, tolerance: 0, feather: 0 } }), 32, 32)[3]).toBe(0);
    expect(at(draw({ "ec.key.luma": { type: 0, threshold: 255, tolerance: 0, feather: 0 } }), 32, 32)[3]).toBe(255);
  });
});
