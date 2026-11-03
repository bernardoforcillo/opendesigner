import { cmykToRgb, rgbToCmyk, type Cmyk, type Rgb } from "@/color/cmyk";
import { swatchCmyk } from "@/store/graphics";
import type { NodeLite, SceneState } from "@/store/types";

// PRINT PREVIEW: separations, overprint and trapping (docs/text-international.md is about type; this is docs/print-preview.md).
// Pure functions over the scene. HONEST SCOPE: the model is the textbook one (no ICC profile, no dot gain, inks combine
// multiplicatively); it shows which plate carries what and where inks overprint, it is not a proof.

export const PROCESS_PLATES = ["Cyan", "Magenta", "Yellow", "Black"] as const;

/** The ink of one paint: process percentages (0..100), plus an optional spot at a tint (0..1) with its CMYK alternate. */
export interface Ink {
  process: Cmyk;
  spot?: { name: string; tint: number; alt: Cmyk };
}

/** The ink of paint slot `slot` of node `n` (`fills.0` ...), from its swatch binding or, failing that, its RGB colour. */
export function inkOf(scene: Pick<SceneState, "variables">, n: NodeLite, slot = "fills.0"): Ink | null {
  const paint = slot.startsWith("strokes") ? n.strokes[Number(slot.split(".")[1] ?? 0)] : n.fills[Number(slot.split(".")[1] ?? 0)];
  if (!paint || (paint as { a: number }).a <= 0) return null;
  const id = n.bindings?.[slot];
  const v = id ? scene.variables[id] : undefined;
  if (v?.swatch) {
    const base = v.tintOf ? scene.variables[v.tintOf] : v;
    const tint = v.tintOf ? Math.min(1, Math.max(0, (v.tint ?? 100) / 100)) : 1;
    const cm = base ? swatchCmyk(base) : null;
    if (base?.spotName && cm) return { process: { c: 0, m: 0, y: 0, k: 0 }, spot: { name: base.spotName, tint, alt: cm } };
    if (cm) return { process: { c: cm.c * tint, m: cm.m * tint, y: cm.y * tint, k: cm.k * tint } };
  }
  return { process: rgbToCmyk(paint as Rgb) };
}

/** Coverage (0..1) of `plate` (Cyan | Magenta | Yellow | Black | a spot name) in `ink`. */
export function coverage(ink: Ink, plate: string): number {
  switch (plate) {
    case "Cyan": return ink.process.c / 100;
    case "Magenta": return ink.process.m / 100;
    case "Yellow": return ink.process.y / 100;
    case "Black": return ink.process.k / 100;
    default: return ink.spot?.name === plate ? ink.spot.tint : 0;
  }
}

/** The plates a document prints on: the four process plates that are used, then its spots (sorted). */
export function platesOf(scene: SceneState): string[] {
  const used = new Set<string>();
  for (const n of scene.nodes.values()) {
    if (n.fromMaster) continue;
    for (const slot of ["fills.0", "strokes.0"]) {
      const ink = inkOf(scene, n, slot);
      if (!ink) continue;
      for (const p of PROCESS_PLATES) if (coverage(ink, p) > 0) used.add(p);
      if (ink.spot) used.add(ink.spot.name);
    }
  }
  return [...PROCESS_PLATES.filter((p) => used.has(p)), ...[...used].filter((p) => !(PROCESS_PLATES as readonly string[]).includes(p)).sort()];
}

/** The screen colour of an ink: process inks and the spot's alternate combine multiplicatively (like inks on white paper). */
export function inkToRgb(ink: Ink): Rgb {
  const a = cmykToRgb(ink.process);
  if (!ink.spot) return a;
  const b = cmykToRgb({ c: ink.spot.alt.c * ink.spot.tint, m: ink.spot.alt.m * ink.spot.tint, y: ink.spot.alt.y * ink.spot.tint, k: ink.spot.alt.k * ink.spot.tint });
  return { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b };
}

/**
 * What the plate shows: for every node with a fill, a grey 0..1 (1 = paper, 0 = full ink), the way a plate is proofed in
 * black and white. Nodes with no ink on that plate are left out (they knock nothing out of it).
 */
export function separationView(scene: SceneState, plate: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of scene.nodes.values()) {
    const ink = inkOf(scene, n);
    if (!ink) continue;
    const cov = coverage(ink, plate);
    if (cov > 0) out.set(n.id, 1 - cov);
  }
  return out;
}

export type OverprintLite = "fill" | "stroke" | "both";

/**
 * `top` printed over `under`. Without overprint the top ink knocks the under ink out. With overprint (the PDF's OPM 1: a
 * plate the top ink does not use does not knock out) the plates merge: where both use a plate the top value wins, where
 * only one does that one stays, and an under spot stays next to a top spot.
 */
export function overprintResult(top: Ink, under: Ink, overprint: boolean): Ink {
  if (!overprint) return top;
  const pick = (t: number, u: number) => (t > 0 ? t : u);
  const process = { c: pick(top.process.c, under.process.c), m: pick(top.process.m, under.process.m), y: pick(top.process.y, under.process.y), k: pick(top.process.k, under.process.k) };
  // Only one spot rides in an Ink: the top one, else the under one. A second spot is dropped from the preview.
  const spot = top.spot ?? under.spot;
  return spot ? { process, spot } : { process };
}

/** The on-screen colour of `top` over `under` with the overprint setting applied (what the overprint preview draws). */
export function overprintPreviewColor(top: Ink, under: Ink, mode: OverprintLite | undefined): Rgb {
  return inkToRgb(overprintResult(top, under, mode === "fill" || mode === "both"));
}

/** Neutral density of an ink, 0 (paper) .. ~1+ (black): decides which of two inks is the lighter. */
export function density(ink: Ink): number {
  const p = ink.process;
  const s = ink.spot;
  const spot = s ? (0.3 * s.alt.c + 0.59 * s.alt.m + 0.11 * s.alt.y + s.alt.k) / 100 * s.tint : 0;
  return (0.3 * p.c + 0.59 * p.m + 0.11 * p.y + p.k) / 100 + spot;
}

export interface TrapSuggestion {
  /** The lighter object: it spreads under the darker one. */
  spread: string;
  /** The darker object. */
  under: string;
  /** Spread distance in document units. */
  width: number;
  /** "spread": lighter into darker. "centered": nearly the same density, the trap straddles the edge. */
  kind: "spread" | "centered";
}

const touches = (a: NodeLite, b: NodeLite, gap: number): boolean =>
  a.x <= b.x + b.width + gap && b.x <= a.x + a.width + gap && a.y <= b.y + b.height + gap && b.y <= a.y + a.height + gap;

const plates = (i: Ink): Set<string> => {
  const s = new Set<string>();
  for (const p of PROCESS_PLATES) if (coverage(i, p) > 0) s.add(p);
  if (i.spot) s.add(i.spot.name);
  return s;
};

/**
 * Where a misregistered plate would show a white gap: two solid-filled siblings that touch or overlap, neither
 * overprinting, and sharing no plate (a shared plate prints through the edge on its own). The lighter spreads into the
 * darker; inks of about the same density get a centered trap. Detection and advice only: the document is not changed,
 * and the bounds are the nodes' boxes (a rotated or rounded shape is judged by its box).
 */
export function trapSuggestions(scene: SceneState, width = 0.25): TrapSuggestion[] {
  const out: TrapSuggestion[] = [];
  const byParent = new Map<string, NodeLite[]>();
  for (const n of scene.nodes.values()) {
    if (n.fromMaster || n.kind === "text" || !n.visible || n.meta?.["overprint"]) continue;
    if (!inkOf(scene, n)) continue;
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        if (!touches(a, b, 0.01)) continue;
        const ia = inkOf(scene, a)!, ib = inkOf(scene, b)!;
        const pa = plates(ia);
        if ([...plates(ib)].some((p) => pa.has(p))) continue;
        const da = density(ia), db = density(ib);
        if (Math.abs(da - db) < 0.05) out.push({ spread: a.id, under: b.id, width, kind: "centered" });
        else out.push(da < db ? { spread: a.id, under: b.id, width, kind: "spread" } : { spread: b.id, under: a.id, width, kind: "spread" });
      }
    }
  }
  return out;
}
