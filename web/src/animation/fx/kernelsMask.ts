// MASK-BASED EFFECTS. This editor has no free-hand mask tool, so what After Effects draws as masks, pins, brush strokes and
// meshes is given here in the ways the document does have:
//   - a mask is another LAYER (a shape, a vector, an image: its alpha) named by the effect (fx/kernelsLayer.ts explains how);
//   - pins, pushes, mesh points, regions and path points are numeric PARAMETERS, so they animate like everything else.
// Roto Brush and Inner/Outer Key estimate the foreground and background colours near the matte edge from the node itself and
// re-compute the alpha there (a closed-form "refine edge"); Puppet, Liquify, Mesh Warp and Reshape are inverse-mapped warps.

import type { FxDef } from "@/animation/fx/library";
import { P, kern, over } from "@/animation/fx/kit";

const HUE = (id: string, label: string, def: number) => P(id, label, 0, 360, def, 1, "°");

// Foreground / background colour estimates around a pixel, given each tap's foreground weight (SkSL source pieces).
const ESTIMATE = (radius: string, taps: number, fgWeight: (q: string) => string, bgWeight: (q: string) => string) => `
  float3 F = float3(0.0), B = float3(0.0); float wf = 0.0, wb = 0.0;
  for (int i = 0; i < ${taps}; i++) {
    float2 q = xy + ring(float(i), ${taps}.0) * ${radius};
    half4 sq = S(q); float3 cq = unp(sq); float aq = float(sq.a);
    float f = ${fgWeight("q")} * aq, b = ${bgWeight("q")} * aq;
    F += cq * f; wf += f; B += cq * b; wb += b;
  }
  F = wf > 1e-3 ? F / wf : unp(S(xy)); B = wb > 1e-3 ? B / wb : unp(S(xy));`;

// alpha of colour c between the background and the foreground estimate (projection), 0.5 if they do not differ
const PROJECT = `
  float3 d = F - B; float den = dot(d, d);
  float proj = den > 2e-3 ? clamp(dot(cc - B, d) / den, 0.0, 1.0) : -1.0;`;

export const MASK_FX: FxDef[] = [
  kern("ec.matte.rotobrush", [
    P("radius", "Search Radius", 2, 60, 14, 0.5), P("band", "Edge Band", 0, 1, 0.6, 0.01), P("shift", "Shift Edge", -50, 50, 0, 0.5), P("feather", "Feather", 0, 30, 0, 0.5),
    P("contrast", "Edge Contrast", 0.2, 4, 1.4, 0.05), P("reduceChatter", "Smoothness", 0, 1, 0.3, 0.01), P("decontaminate", "Decontaminate Edge Colors", 0, 100, 60), P("view", "View (0 Result, 1 Matte, 2 Rough Matte)", 0, 2, 0),
  ], `
  half4 c0 = S(xy); float3 cc = unp(c0);
  float m = float(O(xy).a);
  // how far the rough matte is from sure (0 or 1) around here: the band where the edge is re-computed
  float mb = 0.0;
  for (int i = 0; i < 12; i++) { mb += float(O(xy + ring(float(i), 12.0) * p[0] * 0.5).a); }
  mb /= 12.0;
  float unsure = 1.0 - pow(abs(mb * 2.0 - 1.0), mix(8.0, 1.5, p[1]));
  ${ESTIMATE("p[0]", 16, (q) => `float(O(${q}).a)`, (q) => `(1.0 - float(O(${q}).a))`)}
  ${PROJECT}
  float a = proj < 0.0 ? m : mix(m, proj, unsure);
  a = mix(a, mb, p[5] * unsure);
  a = clamp((a - 0.5) * p[4] + 0.5 + p[2] / 100.0, 0.0, 1.0);
  if (p[3] > 0.0) { a = mix(a, mb, clamp(p[3] / 30.0, 0.0, 1.0)); }
  float inBox = step(box.x, xy.x) * step(xy.x, box.x + box.z) * step(box.y, xy.y) * step(xy.y, box.y + box.w);
  if (p[7] > 0.5 && p[7] < 1.5) { return pre(float3(a), inBox); }
  if (p[7] > 1.5) { return pre(float3(m), inBox); }
  float3 col = mix(cc, F, p[6] / 100.0 * unsure * smoothstep(0.0, 1.0, a));
  return pre(col, a * float(c0.a));`, { other: "layer", outset: (v) => v.radius + v.feather }),

  kern("ec.key.innerouter", [
    P("radius", "Search Radius", 2, 80, 20, 0.5), P("softness", "Edge Softness", 0, 1, 0.3, 0.01), P("cleanFg", "Clean Foreground", 0, 100, 0), P("cleanBg", "Clean Background", 0, 100, 0),
    P("spill", "Spill Suppression", 0, 100, 0), P("shift", "Shift Edge", -50, 50, 0, 0.5), P("contrast", "Edge Contrast", 0.2, 4, 1.2, 0.05), P("view", "View (0 Result, 1 Matte)", 0, 1, 0),
  ], `
  // layer 1 (inner): inside it is surely foreground. layer 2 (outer): outside it is surely background. In between, the matte is
  // computed from the colours the node has nearby inside the inner and outside the outer layer.
  half4 c0 = S(xy); float3 cc = unp(c0);
  float inner = float(O(xy).a), outer = float(O2(xy).a);
  ${ESTIMATE("p[0]", 20, (q) => `float(O(${q}).a)`, (q) => `(1.0 - float(O2(${q}).a))`)}
  ${PROJECT}
  float band = outer * (1.0 - inner);
  float a = proj < 0.0 ? inner : mix(inner, proj, band);
  a = mix(a, a * a * (3.0 - 2.0 * a), p[1]);
  a = clamp((a - 0.5) * p[6] + 0.5 + p[5] / 100.0, 0.0, 1.0);
  a = mix(a, 1.0, p[2] / 100.0 * inner);
  a = mix(a, 0.0, p[3] / 100.0 * (1.0 - outer));
  float inBox = step(box.x, xy.x) * step(xy.x, box.x + box.z) * step(box.y, xy.y) * step(xy.y, box.y + box.w);
  if (p[7] > 0.5) { return pre(float3(a), inBox); }
  float3 col = mix(cc, F, p[4] / 100.0 * band * (1.0 - a));
  return pre(col, a * float(c0.a));`, { other: "layer", other2: true, outset: (v) => v.radius }),

  // Warps whose control points are parameters -----------------------------------------------------------------------
  kern("ec.distort.puppet", [
    P("p1x", "Pin 1 X", -100, 200, 20, 0.5, "%"), P("p1y", "Pin 1 Y", -100, 200, 20, 0.5, "%"), P("d1x", "Pin 1 Move X", -500, 500, 0), P("d1y", "Pin 1 Move Y", -500, 500, 0),
    P("p2x", "Pin 2 X", -100, 200, 80, 0.5, "%"), P("p2y", "Pin 2 Y", -100, 200, 20, 0.5, "%"), P("d2x", "Pin 2 Move X", -500, 500, 0), P("d2y", "Pin 2 Move Y", -500, 500, 0),
    P("p3x", "Pin 3 X", -100, 200, 20, 0.5, "%"), P("p3y", "Pin 3 Y", -100, 200, 80, 0.5, "%"), P("d3x", "Pin 3 Move X", -500, 500, 0), P("d3y", "Pin 3 Move Y", -500, 500, 0),
    P("p4x", "Pin 4 X", -100, 200, 80, 0.5, "%"), P("p4y", "Pin 4 Y", -100, 200, 80, 0.5, "%"), P("d4x", "Pin 4 Move X", -500, 500, 0), P("d4y", "Pin 4 Move Y", -500, 500, 0),
    P("stiffness", "Stiffness", 0.5, 4, 1.5, 0.05), P("anchors", "Hold Corners", 0, 1, 0.3, 0.01),
  ], `
  // each pin drags the pixels around it: the displacement is an inverse-distance blend of the pins' moves (corners hold still)
  float2 u = xy;
  float2 acc = float2(0.0); float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float2 pin = box.xy + box.zw * float2(p[i * 4], p[i * 4 + 1]) / 100.0;
    float2 mv = float2(p[i * 4 + 2], p[i * 4 + 3]);
    // the pixel at xy now shows what was at xy - move near the pin, so the move is looked up at the pin's moved position
    float d = length(xy - pin - mv) / max(length(box.zw), 1.0) + 0.02;
    float w = 1.0 / pow(d, 2.0 * p[16]);
    acc += mv * w; wsum += w;
  }
  float hold = p[17] * 4.0;
  for (int k = 0; k < 4; k++) {
    float2 corner = box.xy + float2(mod(float(k), 2.0), floor(float(k) / 2.0)) * box.zw;
    float d = length(xy - corner) / max(length(box.zw), 1.0) + 0.02;
    wsum += hold / pow(d, 2.0 * p[16]);
  }
  return S(xy - acc / wsum);`, { slots: 24, outset: (v) => Math.max(...["d1x", "d1y", "d2x", "d2y", "d3x", "d3y", "d4x", "d4y"].map((k) => Math.abs(v[k]))) }),

  kern("ec.distort.liquify", [
    P("mode", "Tool (0 Push, 1 Bloat, 2 Pucker, 3 Twirl)", 0, 3, 0),
    P("x1", "Push 1 X", -100, 200, 30, 0.5, "%"), P("y1", "Push 1 Y", -100, 200, 50, 0.5, "%"), P("dx1", "Push 1 Move X", -300, 300, 0), P("dy1", "Push 1 Move Y", -300, 300, 0), P("r1", "Push 1 Size", 1, 400, 40),
    P("x2", "Push 2 X", -100, 200, 70, 0.5, "%"), P("y2", "Push 2 Y", -100, 200, 50, 0.5, "%"), P("dx2", "Push 2 Move X", -300, 300, 0), P("dy2", "Push 2 Move Y", -300, 300, 0), P("r2", "Push 2 Size", 1, 400, 40),
    P("x3", "Push 3 X", -100, 200, 50, 0.5, "%"), P("y3", "Push 3 Y", -100, 200, 20, 0.5, "%"), P("dx3", "Push 3 Move X", -300, 300, 0), P("dy3", "Push 3 Move Y", -300, 300, 0), P("r3", "Push 3 Size", 1, 400, 40),
    P("pressure", "Brush Pressure", 0, 1, 1, 0.01),
  ], `
  // up to three brush dabs; each moves (push), grows (bloat), shrinks (pucker) or turns (twirl) what is under it, smoothly to its edge
  float2 s = xy;
  for (int i = 0; i < 3; i++) {
    float2 c = box.xy + box.zw * float2(p[1 + i * 5], p[2 + i * 5]) / 100.0;
    float2 mv = float2(p[3 + i * 5], p[4 + i * 5]);
    float R = max(p[5 + i * 5], 1.0);
    float2 q = xy - c;
    float fall = 1.0 - smoothstep(0.0, R, length(q)); fall *= fall * p[16];
    if (p[0] < 0.5) { s -= mv * fall; }
    else if (p[0] < 1.5) { s -= q * 0.6 * fall * (length(mv) > 0.0 ? clamp(length(mv) / R, 0.0, 2.0) : 0.5); }
    else if (p[0] < 2.5) { s += q * 0.6 * fall * (length(mv) > 0.0 ? clamp(length(mv) / R, 0.0, 2.0) : 0.5); }
    else { s = c + rot(s - c, fall * length(mv) / R * (mv.x >= 0.0 ? 1.0 : -1.0)); }
  }
  return S(s);`, { slots: 24, outset: (v) => Math.max(...["dx1", "dy1", "dx2", "dy2", "dx3", "dy3"].map((k) => Math.abs(v[k]))) + 150 }),

  kern("ec.distort.meshwarp", [
    P("m1x", "Point 1 Move X", -200, 200, 0), P("m1y", "Point 1 Move Y", -200, 200, 0), P("m2x", "Point 2 Move X", -200, 200, 0), P("m2y", "Point 2 Move Y", -200, 200, 0),
    P("m3x", "Point 3 Move X", -200, 200, 0), P("m3y", "Point 3 Move Y", -200, 200, 0), P("m4x", "Point 4 Move X", -200, 200, 0), P("m4y", "Point 4 Move Y", -200, 200, 0),
    P("smooth", "Smoothness", 0, 1, 1, 0.01),
  ], `
  // a 4 x 4 lattice whose four inner points can move; the move is spread over the cells around each with a smooth hat
  float2 u = (xy - box.xy) / max(box.zw, float2(1.0));
  float2 acc = float2(0.0);
  for (int k = 0; k < 4; k++) {
    float2 g = float2(1.0 + mod(float(k), 2.0), 1.0 + floor(float(k) / 2.0)) / 3.0;
    float2 t = abs(u - g) * 3.0;
    float2 h = clamp(1.0 - t, float2(0.0), float2(1.0));
    h = mix(h, h * h * (3.0 - 2.0 * h), p[8]);
    acc += float2(p[k * 2], p[k * 2 + 1]) * h.x * h.y;
  }
  return S(xy - acc);`, { slots: 12, outset: (v) => Math.max(...["m1x", "m1y", "m2x", "m2y", "m3x", "m3y", "m4x", "m4y"].map((k) => Math.abs(v[k]))) }),

  kern("ec.distort.reshape", [
    P("shape", "Region Shape (0 Rectangle, 1 Ellipse)", 0, 1, 1), P("sx", "Source Center X", -100, 200, 50, 0.5, "%"), P("sy", "Source Center Y", -100, 200, 50, 0.5, "%"), P("sw", "Source Width", 1, 400, 40, 0.5, "%"),
    P("dx", "Destination Center X", -100, 200, 50, 0.5, "%"), P("dy", "Destination Center Y", -100, 200, 50, 0.5, "%"), P("dw", "Destination Width", 1, 400, 70, 0.5, "%"),
    P("aspect", "Height / Width", 0.2, 5, 1, 0.01), P("falloff", "Elasticity (Falloff)", 0, 100, 40, 1, "%"), P("blend", "Blend With Original", 0, 100, 0),
  ], `
  // what is inside the source region is stretched to fill the destination region; the surroundings give way over the falloff
  float2 sc = box.xy + box.zw * float2(p[1], p[2]) / 100.0, dc = box.xy + box.zw * float2(p[4], p[5]) / 100.0;
  float2 ss = box.zw * float2(p[3], p[3] * p[7]) / 100.0, ds = box.zw * float2(p[6], p[6] * p[7]) / 100.0;
  float2 q = (xy - dc) / max(ds * 0.5, float2(1.0));
  float r = p[0] < 0.5 ? max(abs(q.x), abs(q.y)) : length(q);
  float2 inside = sc + q * ss * 0.5;
  float fo = max(p[8] / 100.0, 0.001) * 1.5;
  float w = 1.0 - smoothstep(1.0, 1.0 + fo, r);
  // outside the region the sample slides from the stretched position back to the plain one
  float2 outside = mix(sc + (xy - dc) * (ss / max(ds, float2(1.0))), xy, smoothstep(1.0, 1.0 + fo, r));
  float2 src = r <= 1.0 ? inside : outside;
  return mix(S(src), S(xy), half(p[9] / 100.0));`, { outset: (v) => 100 + v.dw }),

  // Generators with a path given by points ---------------------------------------------------------------------------
  over("ec.generate.writeon", [
    P("x1", "Point 1 X", -100, 200, 15, 0.5, "%"), P("y1", "Point 1 Y", -100, 200, 70, 0.5, "%"), P("x2", "Point 2 X", -100, 200, 40, 0.5, "%"), P("y2", "Point 2 Y", -100, 200, 25, 0.5, "%"),
    P("x3", "Point 3 X", -100, 200, 65, 0.5, "%"), P("y3", "Point 3 Y", -100, 200, 75, 0.5, "%"), P("x4", "Point 4 X", -100, 200, 85, 0.5, "%"), P("y4", "Point 4 Y", -100, 200, 30, 0.5, "%"),
    P("progress", "Write-on Progress", 0, 100, 60, 1, "%"), P("size", "Brush Size", 0.5, 100, 6, 0.5), P("hardness", "Brush Hardness", 0, 100, 70), HUE("hue", "Color (hue)", 40), P("sat", "Saturation", 0, 100, 0),
    P("opacity", "Opacity", 0, 100, 100), P("taper", "Taper", 0, 1, 0.5, 0.01), P("round", "Round the Path", 0, 1, 0.5, 0.01),
  ], `
  // the brush follows the polyline through the four points, up to the progress, with a rounded corner at each bend
  float2 a = box.xy + box.zw * float2(p[0], p[1]) / 100.0, b = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 c = box.xy + box.zw * float2(p[4], p[5]) / 100.0, d = box.xy + box.zw * float2(p[6], p[7]) / 100.0;
  float l1 = length(b - a), l2 = length(c - b), l3 = length(d - c);
  float total = max(l1 + l2 + l3, 1e-3);
  float reach = total * p[8] / 100.0;
  float best = 0.0;
  float done = 0.0;
  for (int i = 0; i < 3; i++) {
    float2 s0 = i == 0 ? a : i == 1 ? b : c;
    float2 s1 = i == 0 ? b : i == 1 ? c : d;
    float len = i == 0 ? l1 : i == 1 ? l2 : l3;
    float tmax = clamp((reach - done) / max(len, 1e-3), 0.0, 1.0);
    float2 sd = s1 - s0;
    float t = clamp(dot(xy - s0, sd) / max(dot(sd, sd), 1e-3), 0.0, tmax);
    float dist = length(xy - (s0 + sd * t));
    float along = (done + len * t) / total;
    float radius = p[9] * 0.5 * mix(1.0, 1.0 - 0.8 * along, p[14]);
    float edge = mix(0.0, 1.0, p[10] / 100.0);
    best = max(best, 1.0 - smoothstep(radius * edge, radius + 0.5, dist));
    done += len;
  }
  float3 col = p[12] > 0.0 ? hsv2rgb(float3(p[11] / 360.0, p[12] / 100.0, 1.0)) : float3(1.0);
  return tint(col, best * p[13] / 100.0 * step(0.001, p[8]));`, "srcover", { slots: 24, outset: (v) => v.size * 2 }),

  over("ec.generate.ccgluegun", [
    P("x1", "Start X", -100, 200, 20, 0.5, "%"), P("y1", "Start Y", -100, 200, 30, 0.5, "%"), P("x2", "End X", -100, 200, 80, 0.5, "%"), P("y2", "End Y", -100, 200, 30, 0.5, "%"),
    P("progress", "Glue Progress", 0, 100, 70, 1, "%"), P("size", "Bead Size", 1, 60, 8, 0.5), P("drip", "Drip Length", 0, 200, 40), P("drips", "Drips", 0, 12, 5), HUE("hue", "Glue Color (hue)", 50), P("sat", "Saturation", 0, 100, 10),
    P("shine", "Shine", 0, 100, 50), P("seed", "Seed", 0, 1000, 1),
  ], `
  // a bead of glue is laid along a line up to the progress, and drips hang from it
  float2 a = box.xy + box.zw * float2(p[0], p[1]) / 100.0, b = box.xy + box.zw * float2(p[2], p[3]) / 100.0;
  float2 ab = b - a; float len = max(length(ab), 1e-3);
  float reach = p[4] / 100.0;
  float t = clamp(dot(xy - a, ab) / (len * len), 0.0, reach);
  float2 on = a + ab * t;
  float2 off = xy - on;
  float wob = 1.0 + 0.25 * sin(t * len / max(p[5], 1.0) * 1.7 + p[11]);
  float bead = 1.0 - smoothstep(p[5] * 0.5 * wob - 1.0, p[5] * 0.5 * wob + 0.5, length(off));
  float drip = 0.0;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= p[7]) { break; }
    float fi = float(i);
    float tt = (fi + 0.5 + (hash21(float2(fi, p[11])) - 0.5) * 0.6) / p[7] * reach;
    float2 base = a + ab * tt;
    float L = p[6] * (0.4 + 0.6 * hash21(float2(fi + 9.0, p[11])));
    float2 q = xy - base;
    float within = step(0.0, q.y) * step(q.y, L);
    float width = p[5] * 0.22 * (1.0 - 0.5 * q.y / max(L, 1.0));
    drip = max(drip, within * (1.0 - smoothstep(width - 0.5, width + 0.5, abs(q.x))));
    drip = max(drip, 1.0 - smoothstep(p[5] * 0.3 - 0.5, p[5] * 0.3 + 0.5, length(q - float2(0.0, L))));
  }
  float body = max(bead, drip);
  float3 base = hsv2rgb(float3(p[8] / 360.0, p[9] / 100.0, 0.95));
  float hl = pow(clamp(1.0 - length((off - float2(-p[5] * 0.15, -p[5] * 0.2)) / (p[5] * 0.25)), 0.0, 1.0), 2.0) * p[10] / 100.0;
  return tint(base + hl, body * 0.9 * step(0.001, p[4]));`, "srcover", { slots: 12, outset: (v) => v.size + v.drip }),

  over("ec.obsolete.mochashape", [
    P("shape", "Shape (0 Rectangle, 1 Ellipse, 2 Rounded Rectangle)", 0, 2, 1), P("x", "Center X", -100, 200, 50, 0.5, "%"), P("y", "Center Y", -100, 200, 50, 0.5, "%"), P("w", "Width", 1, 400, 70, 0.5, "%"),
    P("h", "Height", 1, 400, 70, 0.5, "%"), P("feather", "Feather", 0, 200, 8, 0.5), P("expand", "Expansion", -200, 200, 0, 0.5), P("invert", "Invert", 0, 1, 0), P("opacity", "Mask Opacity", 0, 100, 100, 1, "%"),
    P("rotation", "Rotation", -360, 360, 0, 1, "°"),
  ], `
  // a shape mask placed with parameters: keeps the node where the shape is
  float2 c = box.xy + box.zw * float2(p[1], p[2]) / 100.0;
  float2 hs = box.zw * float2(p[3], p[4]) / 200.0 + p[6];
  float2 q = rot(xy - c, -radians(p[9]));
  float d;
  if (p[0] < 0.5) { float2 e = abs(q) - hs; d = max(e.x, e.y); }
  else if (p[0] < 1.5) { d = (length(q / max(hs, float2(1.0))) - 1.0) * min(hs.x, hs.y); }
  else { float r = min(hs.x, hs.y) * 0.3; float2 e = abs(q) - hs + r; d = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - r; }
  float m = 1.0 - smoothstep(-p[5] * 0.5, p[5] * 0.5 + 0.001, d);
  if (p[7] > 0.5) { m = 1.0 - m; }
  m = mix(1.0, m, p[8] / 100.0);
  return half4(half(m));`, "dstin", { slots: 12 }),
];
