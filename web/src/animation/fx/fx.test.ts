// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import type { CanvasKit } from "canvaskit-wasm";
import { FX_CATALOG } from "@/animation/fx/catalog";
import { builtInPath } from "@/animation/fx/kernelsText";
import { formatNumber, formatTimecode } from "@/animation/fx/kernelsSim";
import { invertHomography, unitSquareTo } from "@/animation/fx/kernelsDistort";
import { FX_LIBRARY, fxDef, fxParam, hsv, resolveFx } from "@/animation/fx/library";
import { makeLutShader, readHistogram } from "@/animation/fx/lutImage";
import { buildFx, fxOutset } from "@/animation/fx/apply";
import { MAX_FX_TEXT_BYTES, fxStringProp, parseFxStringProp, fxLayerProp, fxRefKey, fxProp, isFxProp, parseFxLayerProp, parseFxProp } from "@/animation/fx/props";
import { isTrackProp, sampleClip } from "@/animation/engine";
import { mergeAnim, poseScene } from "@/animation/pose";
import { isValidClip } from "@/animation/validate";
import { setStringParam, stringParamOf, addPropertyTrack, baseValueOf, clampValue, propLabel } from "@/animation/timelineLogic";
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
      expect([d.filter, d.overlay, d.kernel, d.time, d.text, d.audio, d.carrier].filter(Boolean).length, `${d.id}: exactly one kind`).toBe(1);
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

  const draw = (animFx: Record<string, Record<string, number>>, flat = true, text?: Record<string, Record<string, string>>) => {
    const surface = CK.MakeSurface(64, 64)!;
    const sk = surface.getCanvas();
    sk.clear(CK.TRANSPARENT);
    const garbage: { delete(): void }[] = [];
    const fx = buildFx(CK, animFx, (o) => garbage.push(o), text);
    const paint = new CK.Paint();
    if (fx?.filter) paint.setImageFilter(fx.filter);
    sk.saveLayer(paint, CK.XYWHRect(0, 0, 64, 64));
    const body = new CK.Paint();
    // kernels: the node is drawn offscreen and read through each SkSL shader, as ckRenderer.drawLayerBody does
    const bodyPaint = (c: import("canvaskit-wasm").Canvas) => {
      const bp = new CK.Paint();
      if (flat) bp.setColor(CK.Color4f(0.8, 0.3, 0.2, 1));
      // a low-contrast horizontal ramp, grey 80..160
      else bp.setShader(CK.Shader.MakeLinearGradient([16, 0], [48, 0], [CK.Color4f(80 / 255, 80 / 255, 80 / 255, 1), CK.Color4f(160 / 255, 160 / 255, 160 / 255, 1)], null, CK.TileMode.Clamp));
      c.drawRect(CK.XYWHRect(16, 16, 32, 32), bp);
      bp.delete();
    };
    let current: ((c: import("canvaskit-wasm").Canvas) => void) | null = null;
    for (const k of fx?.kernels ?? []) {
      if (k.skip) continue;
      const eff = CK.RuntimeEffect.Make(k.sksl, (err) => { throw new Error(err); });
      expect(eff).not.toBeNull();
      const off = CK.MakeSurface(64, 64)!;
      const oc = off.getCanvas();
      oc.clear(CK.TRANSPARENT);
      (current ?? bodyPaint)(oc);
      const img = off.makeImageSnapshot();
      const srcShader = img.makeShaderOptions(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Linear, CK.MipmapMode.None);
      const children = [srcShader];
      if (k.lut) {
        const lut = makeLutShader(CK, k.lut(readHistogram(CK, img)!))!;
        children.push(lut.shader);
        garbage.push(lut.image, lut.shader);
      }
      if (k.image) {
        const li = CK.MakeImage({ width: k.image.width, height: k.image.height, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Opaque, colorSpace: CK.ColorSpace.SRGB }, k.image.bytes, k.image.width * 4)!;
        const ls = li.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Nearest, CK.MipmapMode.None);
        children.push(ls);
        garbage.push(li, ls);
      }
      // a second image for the kernels that take one: a grey square covering the left half of the node
      if (k.other) {
        const o = CK.MakeSurface(64, 64)!;
        const oc = o.getCanvas();
        oc.clear(CK.TRANSPARENT);
        const op = new CK.Paint();
        op.setColor(CK.Color4f(0.5, 0.5, 0.5, 1));
        oc.drawRect(CK.XYWHRect(0, 0, 32, 64), op);
        op.delete();
        const oi = o.makeImageSnapshot();
        const os = oi.makeShaderOptions(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Linear, CK.MipmapMode.None);
        children.push(os);
        if (k.other2) children.push(os);
        garbage.push(o, oi, os);
      }
      const sh = eff!.makeShaderWithChildren([16, 16, 32, 32, ...k.uniforms], children);
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
      p.setBlendMode(overlay.blend === "dstin" ? CK.BlendMode.DstIn : overlay.blend === "srcover" ? CK.BlendMode.SrcOver : CK.BlendMode.SrcATop);
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

  it("auto levels stretches a low-contrast ramp, equalize spreads it, a flat node is untouched", () => {
    const before = draw({}, false);
    expect(at(before, 17, 32)[0]).toBeGreaterThan(70);
    expect(at(before, 46, 32)[0]).toBeLessThan(170);
    const lv = draw({ "ec.color.autolevels": { blackClip: 0, whiteClip: 0, blend: 0 } }, false);
    expect(at(lv, 17, 32)[0]).toBeLessThan(25);
    expect(at(lv, 46, 32)[0]).toBeGreaterThan(230);
    const eq = draw({ "ec.color.equalize": { method: 2, amount: 100 } }, false);
    expect(at(eq, 17, 32)[0]).toBeLessThan(30);
    expect(at(eq, 46, 32)[0]).toBeGreaterThan(225);
    const ac = draw({ "ec.color.autocontrast": { blackClip: 0, whiteClip: 0, blend: 0 } }, false);
    expect(at(ac, 46, 32)[0]).toBeGreaterThan(230);
    expect(at(ac, 8, 8)[3]).toBe(0); // outside the node stays transparent
    const flat = at(draw({ "ec.color.autolevels": { blackClip: 0, whiteClip: 0, blend: 0 } }), 32, 32);
    expect(Math.abs(flat[0] - 204)).toBeLessThanOrEqual(2);
  });

  it("text effects draw glyph pixels over the whole layer; shatter at 0 is the node, at 100 it is gone from where it was", () => {
    const num = draw({ "ec.text.numbers": { value: 8, size: 28, x: 50, y: 50, opacity: 100 } });
    let lit = 0;
    for (let i = 3; i < num.length; i += 4) if (num[i] > 0) lit++;
    expect(lit).toBeGreaterThan(40);
    const none = draw({ "ec.sim.shatter": { phase: 0 } });
    expect(at(none, 32, 32)[3]).toBe(255);
    const gone = draw({ "ec.sim.shatter": { phase: 100, force: 1200, grav: 0, piece: 8 } });
    expect(at(gone, 32, 32)[3]).toBeLessThan(255);
    // a card wipe at 0 keeps the node, at 100 shows the back (transparent)
    expect(at(draw({ "ec.transition.cardwipe": { completion: 0 } }), 32, 32)[3]).toBe(255);
    expect(at(draw({ "ec.transition.cardwipe": { completion: 100, back: 0 } }), 32, 32)[3]).toBe(0);
  });
  it("second-layer effects read the layer: set matte keeps the node where the layer is opaque, blend mixes the two", () => {
    // the test layer is a grey square over the left half of the node, transparent on the right
    const matte = draw({ "ec.channel.setmatte": { channel: 4, invert: 0, mode: 0, premultiply: 0, opacity: 100 } });
    expect(at(matte, 20, 32)[3]).toBe(255);
    expect(at(matte, 44, 32)[3]).toBe(0);
    const inv = draw({ "ec.channel.setmatte": { channel: 4, invert: 1, mode: 0, premultiply: 0, opacity: 100 } });
    expect(at(inv, 20, 32)[3]).toBe(0);
    expect(at(inv, 44, 32)[3]).toBe(255);
    // blend 100% on the left shows the grey layer instead of the node
    const blend = at(draw({ "ec.channel.blend": { ratio: 100, mode: 0 } }), 20, 32);
    expect(Math.abs(blend[0] - 128)).toBeLessThanOrEqual(3);
    // set channels: red from the layer's green gives grey 128 on the left, 0 where the layer is empty
    const sc = draw({ "ec.channel.setchannels": { red: 6, green: 1, blue: 2, alpha: 3, premultiply: 0 } });
    expect(Math.abs(at(sc, 20, 32)[0] - 128)).toBeLessThanOrEqual(3);
    expect(at(sc, 44, 32)[0]).toBe(0);
    // difference matte: where the layer equals the node it is keyed out, where it differs it stays
    const diff = draw({ "ec.key.differencematte": { tolerance: 5, softness: 0, blur: 0, view: 0, invert: 0, cleanup: 0 } });
    expect(at(diff, 44, 32)[3]).toBe(255);
    // cc composite: the node composited with its own original is unchanged
    expect(at(draw({ "ec.channel.cccomposite": { composite: 0, rgbOnly: 0, opacity: 100 } }), 20, 32)[3]).toBe(255);
  });

  it("mask-based effects: warps with nothing moved are the identity, shapes and brushes draw only what they should", () => {
    const base = at(draw({}), 32, 32);
    const same = (a: number[], b: number[], what: string) => a.forEach((v, i) => expect(Math.abs(v - b[i]), what).toBeLessThanOrEqual(2));
    same(at(draw({ "ec.distort.puppet": {} }), 32, 32), base, "puppet");
    same(at(draw({ "ec.distort.liquify": {} }), 32, 32), base, "liquify");
    same(at(draw({ "ec.distort.meshwarp": {} }), 32, 32), base, "mesh warp");
    same(at(draw({ "ec.distort.reshape": { sw: 40, dw: 40 } }), 32, 32), base, "reshape");
    // a push moves pixels
    expect(at(draw({ "ec.distort.liquify": { dx1: 200, dy1: 0, r1: 200, x1: 50, y1: 50 } }), 20, 32)).not.toEqual(at(draw({}), 20, 32));
    // write-on and glue gun: nothing is drawn at 0%, something is at 100% (they paint over the node, so compare the pictures)
    const differs = (x: Uint8Array, y: Uint8Array) => { let n = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 8) n++; return n; };
    const plain = draw({});
    expect(differs(draw({ "ec.generate.writeon": { progress: 0 } }), plain)).toBe(0);
    expect(differs(draw({ "ec.generate.writeon": { progress: 100, size: 8 } }), plain)).toBeGreaterThan(30);
    expect(differs(draw({ "ec.generate.ccgluegun": { progress: 0 } }), plain)).toBe(0);
    expect(differs(draw({ "ec.generate.ccgluegun": { progress: 100 } }), plain)).toBeGreaterThan(10);
    // the shape mask keeps the node in the shape and removes it elsewhere; inverted it is the other way round
    const mask = draw({ "ec.obsolete.mochashape": { shape: 1, x: 50, y: 50, w: 30, h: 30, feather: 0, expand: 0, invert: 0, opacity: 100, rotation: 0 } });
    expect(at(mask, 32, 32)[3]).toBe(255);
    expect(at(mask, 18, 18)[3]).toBe(0);
    const inv = draw({ "ec.obsolete.mochashape": { shape: 1, x: 50, y: 50, w: 30, h: 30, feather: 0, expand: 0, invert: 1, opacity: 100, rotation: 0 } });
    expect(at(inv, 32, 32)[3]).toBe(0);
    expect(at(inv, 18, 18)[3]).toBe(255);
  });
});

describe("text formatting", () => {
  it("numbers: decimals, commas and sign", () => {
    expect(formatNumber(1234.5, 1, true)).toBe("1,234.5");
    expect(formatNumber(-0.04, 1, false)).toBe("0.0");
    expect(formatNumber(-7, 0, false)).toBe("-7");
    expect(formatNumber(1234567, 0, true)).toBe("1,234,567");
  });
  it("timecode: frames roll into seconds, minutes, hours", () => {
    expect(formatTimecode(61.5, 24, 0)).toBe("00:01:01:12");
    expect(formatTimecode(3600, 30, 0)).toBe("01:00:00:00");
    expect(formatTimecode(61.5, 24, 1)).toBe("00:01:01");
    expect(formatTimecode(2, 25, 2)).toBe("50");
  });
});

describe("layer references", () => {
  it("are tracks named fx.<effect>.layer.<id>; parsed, valid and sampled", () => {
    const prop = fxLayerProp("ec.channel.setmatte", "3f2a9c10-aa55");
    expect(prop).toBe("fx.ec.channel.setmatte.layer.3f2a9c10-aa55");
    expect(parseFxLayerProp(prop)).toEqual({ effect: "ec.channel.setmatte", layerId: "3f2a9c10-aa55", slot: 1 });
    expect(parseFxLayerProp(fxLayerProp("ec.key.innerouter", "B", 2))).toEqual({ effect: "ec.key.innerouter", layerId: "B", slot: 2 });
    expect(fxLayerProp("ec.key.innerouter", "B", 2)).toBe("fx.ec.key.innerouter.layer2.B");
    expect(fxRefKey("ec.key.innerouter", 2)).toBe("ec.key.innerouter#2");
    expect(parseFxProp(prop)).toBeNull();
    expect(isFxProp(prop)).toBe(true);
    expect(isTrackProp(prop)).toBe(true);
    expect(isTrackProp("fx.ec.channel.setmatte.layer.")).toBe(false);
    expect(isTrackProp("fx.ec.channel.setmatte.layer.a.b")).toBe(false);
    const a = sampleClip({ tracks: [{ nodeId: "n", prop, keyframes: [{ time: 0, value: 1, easing: "linear" }] }] }, 100).get("n");
    expect(a?.fxRefs).toEqual({ "ec.channel.setmatte": "3f2a9c10-aa55" });
    expect(a?.fx).toEqual({ "ec.channel.setmatte": {} }); // naming a layer is enough to have the effect
  });
  it("the label names the layer and the base value is a constant", () => {
    const prop = fxLayerProp("ec.channel.setmatte", "L1");
    expect(propLabel(prop, (id) => (id === "L1" ? "Matte" : undefined))).toBe("Set Matte · Layer: Matte");
    expect(propLabel(prop)).toBe("Set Matte · Layer: (missing)");
    expect(baseValueOf({ x: 0, y: 0, rotation: 0, opacity: 1 }, prop)).toBe(1);
  });
  it("adding one makes a single constant keyframe; every effect that needs a layer says so", () => {
    const clip = { id: "c", name: "c", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "n", tracks: [] };
    const next = addPropertyTrack(clip, { id: "n", x: 0, y: 0, rotation: 0, opacity: 1 }, fxLayerProp("ec.channel.setmatte", "L"));
    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0].keyframes).toEqual([{ time: 0, value: 1, easing: "easeInOut" }]);
    const need = FX_LIBRARY.filter((d) => d.needsLayer).map((d) => d.id).sort();
    expect(need).toEqual([
      "ec.channel.blend", "ec.channel.calculations", "ec.channel.compoundarithmetic", "ec.channel.setchannels", "ec.channel.setmatte",
      "ec.color.colorstabilizer", "ec.key.differencematte", "ec.key.innerouter", "ec.matte.objectmatte", "ec.matte.rotobrush", "ec.noise.matchgrain", "ec.perspective.ccenvironment",
    ]);
  });
  it("reach the posed node as animFxRefs, merged across clips", () => {
    const s = baseScene();
    const scene = { ...s, nodes: nodesWith(s.nodes, { n: child("n", "A", 0, 0), L: child("L", "B", 50, 0) }) };
    const anim = sampleClip({ tracks: [{ nodeId: "n", prop: fxLayerProp("ec.key.differencematte", "L"), keyframes: [{ time: 0, value: 1, easing: "linear" }] }] }, 0);
    const posed = poseScene(scene, anim);
    expect(posed.nodes.at("n").animFxRefs).toEqual({ "ec.key.differencematte": "L" });
    const merged = mergeAnim(new Map([["n", { fxRefs: { a: "1" } }]]), new Map([["n", { fxRefs: { b: "2" } }]]));
    expect(merged.get("n")?.fxRefs).toEqual({ a: "1", b: "2" });
  });
});

describe("string parameters", () => {
  it("live in a track's name: UTF-8 in unpadded base64url, round-tripped, never a keyframe value", () => {
    for (const text of ["", "Hello", "Ünïcode ✓ 日本語 — 😀", "line one\nline two", "a/b+c=d?e&f", "x".repeat(900)]) {
      const prop = fxStringProp("ec.obsolete.basictext", "text", text);
      expect(prop).toMatch(/^fx\.ec\.obsolete\.basictext\.str\.text\.[A-Za-z0-9_-]*$/);
      expect(parseFxStringProp(prop)).toEqual({ effect: "ec.obsolete.basictext", param: "text", text });
      expect(isFxProp(prop)).toBe(true);
      expect(isTrackProp(prop)).toBe(true);
      expect(parseFxProp(prop)).toBeNull();
    }
  });
  it("are cut at a size the prop shape allows, and bad shapes are not string props", () => {
    const long = fxStringProp("ec.obsolete.basictext", "text", "é".repeat(5000));
    expect(long.length).toBeLessThan(4200);
    expect(new TextEncoder().encode(parseFxStringProp(long)!.text).length).toBeLessThanOrEqual(MAX_FX_TEXT_BYTES);
    for (const bad of ["fx.ec.obsolete.basictext.str.text", "fx.ec.obsolete.basictext.str..AAAA", "fx.ec.obsolete.basictext.str.text.a+b", "fx.ec.obsolete.basictext.str.text.a b", "fx.obsolete.basictext.str.text.AAAA"]) {
      expect(parseFxStringProp(bad), bad).toBeNull();
      expect(isTrackProp(bad), bad).toBe(false);
    }
    expect(parseFxStringProp("fx.ec.obsolete.basictext.str.text.//")).toBeNull();
  });
  it("sample into NodeAnim.fxText, activate the effect, and reach the posed node", () => {
    const tracks = [{ nodeId: "n", prop: fxStringProp("ec.obsolete.basictext", "text", "Hi ✓"), keyframes: [{ time: 0, value: 1, easing: "linear" }] }];
    const a = sampleClip({ tracks }, 50).get("n");
    expect(a?.fxText).toEqual({ "ec.obsolete.basictext": { text: "Hi ✓" } });
    expect(a?.fx).toEqual({ "ec.obsolete.basictext": {} });
    const s = baseScene();
    const scene = { ...s, nodes: nodesWith(s.nodes, { n: child("n", "A", 0, 0) }) };
    expect(poseScene(scene, sampleClip({ tracks }, 0)).nodes.at("n").animFxText).toEqual({ "ec.obsolete.basictext": { text: "Hi ✓" } });
    const merged = mergeAnim(new Map([["n", { fxText: { a: { x: "1" } } }]]), new Map([["n", { fxText: { a: { y: "2" }, b: { z: "3" } } }]]));
    expect(merged.get("n")?.fxText).toEqual({ a: { x: "1", y: "2" }, b: { z: "3" } });
  });
  it("a track for the same parameter replaces the earlier one; nothing changes if the text is the same", () => {
    const clip = { id: "c", name: "c", duration: 1000, trigger: "enter", delay: 0, repeat: 0, yoyo: false, targetId: "n", tracks: [] };
    const one = setStringParam(clip, "n", "ec.obsolete.basictext", "text", "first");
    expect(one.tracks).toHaveLength(1);
    expect(one.tracks[0].keyframes).toHaveLength(1);
    const two = setStringParam(one, "n", "ec.obsolete.basictext", "text", "second");
    expect(two.tracks).toHaveLength(1);
    expect(stringParamOf(two, "n", "ec.obsolete.basictext", "text")).toBe("second");
    expect(setStringParam(two, "n", "ec.obsolete.basictext", "text", "second")).toBe(two);
    // other parameters and other nodes are left alone
    const withFont = setStringParam(two, "n", "ec.obsolete.basictext", "font", "Georgia");
    expect(withFont.tracks).toHaveLength(2);
    expect(stringParamOf(withFont, "m", "ec.obsolete.basictext", "text")).toBeUndefined();
    expect(baseValueOf({ x: 0, y: 0, rotation: 0, opacity: 1 }, fxStringProp("ec.obsolete.basictext", "text", "x"))).toBe(1);
  });
  it("the label shows the text, shortened", () => {
    expect(propLabel(fxStringProp("ec.obsolete.basictext", "text", "Hello"))).toBe('Basic Text · Text: "Hello"');
    expect(propLabel(fxStringProp("ec.obsolete.basictext", "text", "a\nb   c"))).toBe('Basic Text · Text: "a b c"');
    expect(propLabel(fxStringProp("ec.obsolete.basictext", "text", "x".repeat(40)))).toBe(`Basic Text · Text: "${"x".repeat(23)}…"`);
  });
  it("the text effects build their spec from the values and the strings, with defaults", () => {
    const basic = fxDef("ec.obsolete.basictext")!;
    expect(basic.strings?.map((x) => x.id)).toEqual(["text", "font"]);
    const spec = basic.text!(resolveFx(basic, { size: 20, weight: 640, align: 2, x: 30, hue: 0, sat: 0, val: 100 }), { text: "Hi", font: "Georgia" });
    expect(spec).toMatchObject({ content: "Hi", fontFamily: "Georgia", fontWeight: "600", fontSize: 20, align: "right", ax: 0.3, color: { r: 1, g: 1, b: 1 } });
    const path = fxDef("ec.obsolete.pathtext")!;
    expect(path.layerOptional).toBe(true);
    expect(path.text!(resolveFx(path, {}), { text: "x", font: "Inter" }).path).toBe("layer");
    const circle = path.text!(resolveFx(path, { shape: 1 }), { text: "x", font: "Inter" }).path as { x: number; y: number }[];
    expect(circle[0].x).toBeCloseTo(0, 1);
    expect(circle[0].y).toBeCloseTo(-0.38, 2);
  });
  it("built-in text paths: a line, a wave and a circle start where they say", () => {
    const v = { radius: 0.4, sweep: 180, start: 0, amplitude: 0.1 };
    const line = builtInPath(4, v);
    expect([line[0].x, line[line.length - 1].x]).toEqual([-0.5, 0.5]);
    const wave = builtInPath(3, v);
    expect(Math.max(...wave.map((p) => p.y))).toBeCloseTo(0.1, 2);
    const arc = builtInPath(2, v);
    expect(Math.hypot(arc[40].x, arc[40].y)).toBeCloseTo(0.4, 5);
    // an arc of 180 degrees from the top ends at the bottom
    expect(arc[arc.length - 1].y).toBeCloseTo(0.4, 2);
  });
});


// The effects that read a file (fx/files.ts, fx/kernelsFiles.ts): parsers, then the real shaders over a node of known colour.
import { parseCube, parse3dl, parseCdl, parseCurves, parseFxFile, registerFxData, packImage, invert1d, type FxData } from "@/animation/fx/files";

describe("colour lookup files", () => {
  const cube = (n: number, f: (r: number, g: number, b: number) => [number, number, number], extra = "") => {
    const rows: string[] = [];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).join(" "));
    return `TITLE "t"\n# c\nLUT_3D_SIZE ${n}\n${extra}${rows.join("\n")}\n`;
  };

  it("reads .cube cubes (red fastest) and 1D tables, and refuses malformed ones", () => {
    const d = parseCube(cube(3, (r, g, b) => [b, g, r]))!;
    expect(d.kind).toBe("lut3d");
    expect(d.size).toBe(3);
    // entry for r = 1, g = 0, b = 0 is the 2nd triple: (b, g, r) = (0, 0, 0.5)
    expect(Array.from(d.table.slice(3, 6))).toEqual([0, 0, 0.5]);
    const one = parseCube("LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\n0 0 0\n1 1 1\n");
    expect(one?.kind).toBe("lut1d"); // DOMAIN_MIN carries three numbers; the first is taken
    expect(parseCube("LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n")?.kind).toBe("lut1d");
    expect(parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toBeNull();
    expect(parseCube("LUT_3D_SIZE 2\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\nx y z\n")).toBeNull();
    expect(parseCube("hello")).toBeNull();
  });
  it("reads .3dl (blue fastest, integer codes), ASC CDL xml and Photoshop curves", () => {
    const rows: string[] = [];
    for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) rows.push(`${r * 1023} ${g * 1023} ${b * 1023}`);
    const d3 = parse3dl(`0 1023\n${rows.join("\n")}\n`)!;
    expect(d3.size).toBe(2);
    expect(Array.from(d3.table.slice(3, 6))).toEqual([1, 0, 0]); // second entry (r = 1) in the red-fastest cube
    const cdl = parseCdl("<ColorCorrection><SOPNode><Slope>2 1 1</Slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode><SatNode><Saturation>0.5</Saturation></SatNode></ColorCorrection>")!;
    expect(cdl.kind === "lut1d" && cdl.sat).toBe(0.5);
    expect(cdl.kind === "lut1d" && cdl.table[(512 * 3)]).toBeCloseTo(1, 5); // red slope 2 at 0.5 -> 1
    const acv = new Uint8Array([0, 4, 0, 1, 0, 2, 0, 0, 0, 0, 0, 255, 0, 128]); // one curve: (in 0 -> out 0), (in 128 -> out 255)
    const c = parseCurves(acv)!;
    expect(c.kind === "lut1d" && c.table[(128) * 3]).toBeGreaterThan(0.95);
    expect(parseCurves(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseFxFile(new TextEncoder().encode("LUT_3D_SIZE 2"))).toBeNull(); // not wrapped: not ours
  });
  it("inverts a 1D table and packs cubes as size² x size", () => {
    const d = parseCube("LUT_1D_SIZE 3\n0 0 0\n0.25 0.25 0.25\n1 1 1\n")! as Extract<FxData, { kind: "lut1d" }>;
    const inv = invert1d(d);
    expect(inv.table[3]).toBeCloseTo(2 / 3, 3); // the output 0.5 lies a third of the way from 0.25 (step 1) to 1 (step 2): (1 + 1/3) / 2
    const img = packImage(parseCube(cube(4, (r, g, b) => [r, g, b]))!, false);
    expect([img.width, img.height, img.bytes.length]).toEqual([16, 4, 16 * 4 * 4]);
  });

  describe("drawn", () => {
    let CK2: CanvasKit;
    beforeAll(async () => {
      const require = createRequire(import.meta.url);
      const init = require("canvaskit-wasm/bin/full/canvaskit.js") as (o: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
      CK2 = await init({ locateFile: () => require.resolve("canvaskit-wasm/bin/full/canvaskit.wasm") });
    }, 60_000);

    // the node is a flat (0.8, 0.3, 0.2) square; read its centre after the effect
    const run = (effect: string, values: Record<string, number>, data: FxData | null, hash: string) => {
      if (data) registerFxData(hash, data);
      const surface = CK2.MakeSurface(64, 64)!;
      const garbage: { delete(): void }[] = [];
      const fx = buildFx(CK2, { [effect]: values }, (o) => garbage.push(o), { [effect]: { file: hash } })!;
      let px: Uint8Array | null = null;
      for (const k of fx.kernels) {
        if (k.skip) { px = null; break; }
        const eff = CK2.RuntimeEffect.Make(k.sksl, (e) => { throw new Error(e); })!;
        const off = CK2.MakeSurface(64, 64)!;
        const oc = off.getCanvas();
        const bp = new CK2.Paint();
        bp.setColor(CK2.Color4f(0.8, 0.3, 0.2, 1));
        oc.drawRect(CK2.XYWHRect(16, 16, 32, 32), bp);
        bp.delete();
        const img = off.makeImageSnapshot();
        const src = img.makeShaderOptions(CK2.TileMode.Decal, CK2.TileMode.Decal, CK2.FilterMode.Linear, CK2.MipmapMode.None);
        const children = [src];
        if (k.image) {
          const li = CK2.MakeImage({ width: k.image.width, height: k.image.height, colorType: CK2.ColorType.RGBA_8888, alphaType: CK2.AlphaType.Opaque, colorSpace: CK2.ColorSpace.SRGB }, k.image.bytes, k.image.width * 4)!;
          const ls = li.makeShaderOptions(CK2.TileMode.Clamp, CK2.TileMode.Clamp, CK2.FilterMode.Nearest, CK2.MipmapMode.None);
          children.push(ls);
          garbage.push(li, ls);
        }
        const sh = eff.makeShaderWithChildren([16, 16, 32, 32, ...k.uniforms], children);
        const sk = surface.getCanvas();
        const p = new CK2.Paint();
        p.setShader(sh);
        sk.drawRect(CK2.XYWHRect(0, 0, 64, 64), p);
        p.delete();
        garbage.push(off, img, src, sh, eff);
        px = sk.readPixels(32, 32, { width: 1, height: 1, colorType: CK2.ColorType.RGBA_8888, alphaType: CK2.AlphaType.Unpremul, colorSpace: CK2.ColorSpace.SRGB }) as Uint8Array;
      }
      garbage.forEach((g) => g.delete());
      surface.delete();
      return px ? Array.from(px.slice(0, 3)) : null;
    };
    const near = (a: number[] | null, b: number[], tol = 4) => { expect(a).not.toBeNull(); a!.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(tol)); };
    const H = (c: string) => c.repeat(64);

    it("without its file the effect leaves the node alone", () => {
      expect(run("ec.utility.applylut", {}, null, H("1"))).toBeNull();
    });
    it("a cube that swaps red and blue does so, in every interpolation", () => {
      const d = parseCube(cube(17, (r, g, b) => [b, g, r]))!;
      for (const interp of [0, 1, 2]) near(run("ec.utility.applylut", { amount: 100 }, d, H("2")), [51, 77, 204], 1 + 0 * interp);
      for (const interp of [0, 2]) near(run("ec.color.ociofile", { interpolation: interp, direction: 0, amount: 100, linear: 0 }, d, H("2")), [51, 77, 204], 1);
      near(run("ec.color.ociofile", { interpolation: 1, direction: 0, amount: 100, linear: 0 }, d, H("2")), [51, 77, 204], 16);
    });
    it("amount blends with the original, and the inverse of the swap is the swap", () => {
      const d = parseCube(cube(17, (r, g, b) => [b, g, r]))!;
      near(run("ec.utility.applylut", { amount: 0 }, d, H("2")), [204, 77, 51], 1);
      near(run("ec.utility.applylut", { amount: 50 }, d, H("2")), [128, 77, 128], 2);
      near(run("ec.color.ociofile", { interpolation: 0, direction: 1, amount: 100, linear: 0 }, d, H("2")), [51, 77, 204], 4);
    });
    it("a 1D invert table inverts; the inverse direction undoes a gamma table", () => {
      const inv = parseCube("LUT_1D_SIZE 2\n1 1 1\n0 0 0\n")!;
      near(run("ec.color.ociofile", { interpolation: 0, direction: 0, amount: 100, linear: 0 }, inv, H("3")), [51, 178, 204], 1);
      const n = 64;
      const gamma = parseCube(`LUT_1D_SIZE ${n}\n${Array.from({ length: n }, (_, i) => { const v = (i / (n - 1)) ** 2; return `${v} ${v} ${v}`; }).join("\n")}\n`)!;
      near(run("ec.color.ociofile", { interpolation: 0, direction: 1, amount: 100, linear: 0 }, gamma, H("4")), [Math.round(Math.sqrt(0.8) * 255), Math.round(Math.sqrt(0.3) * 255), Math.round(Math.sqrt(0.2) * 255)], 4);
    });
    it("a CDL look changes the colour and the look's saturation can be turned down", () => {
      const cdl = parseCdl("<Slope>0.5 0.5 0.5</Slope>")!;
      near(run("ec.color.ociolook", { direction: 0, interpolation: 0, amount: 100, linear: 0, saturation: 100, keepLuma: 0 }, cdl, H("5")), [102, 38, 26], 2);
      const grey = run("ec.color.ociolook", { direction: 0, interpolation: 0, amount: 100, linear: 0, saturation: 0, keepLuma: 0 }, cdl, H("5"))!;
      expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(2);
    });
    it("a curves file maps the channels: a curve that raises everything brightens, and the map can keep luminance", () => {
      const acv = new Uint8Array([0, 4, 0, 1, 0, 2, 0, 0, 0, 0, 0, 255, 0, 255]); // (0 -> 0), (255 -> 255): identity
      near(run("ec.color.psarbitrarymap", { amount: 100, keepLuma: 0 }, parseCurves(acv)!, H("6")), [204, 77, 51], 2);
      const up = new Uint8Array([0, 4, 0, 1, 0, 3, 0, 0, 0, 0, 0, 200, 0, 128, 0, 255, 0, 255]); // 128 -> 200
      const lit = run("ec.color.psarbitrarymap", { amount: 100, keepLuma: 0 }, parseCurves(up)!, H("7"))!;
      expect(lit[1]).toBeGreaterThan(77 + 30);
    });
  });
});
