import type { NodeLite, SceneState } from "@/store/types";
import { fontFamilyOf, placeTextLines, type MeasureText } from "@/renderer/text";
import type { PdfReport, PdfXMode } from "@/pdf/write/pdfDocument";

// PREFLIGHT: what a print shop's checker would flag, as far as this editor can see it. Two parts:
//  - `preflightScene` reads the document (no export needed): fonts, overset text, bleed, colour mode,
//    layers, unsized pages;
//  - `preflightReport` reads what the PDF writer actually did (images' resolution, glyphs a font
//    lacks, effects it could not reproduce, transparency under X-1a/X-3, RGB in a CMYK-only mode).
// It is a checklist of known problems, NOT a PDF/X validator: a clean preflight is not a guarantee.

export type Severity = "error" | "warning" | "info";
export interface PreflightIssue { severity: Severity; code: string; message: string; nodeId?: string; pageId?: string }

export interface PreflightOptions { pdfx?: PdfXMode; bleed?: boolean; marks?: boolean }

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+)$/i;

function familyList(n: NodeLite): string[] {
  const style = n.text?.style;
  return style ? [fontFamilyOf(style).split(",")[0]!.trim().replace(/^["']|["']$/g, "")] : [];
}

export function preflightScene(scene: SceneState, opts: PreflightOptions = {}, measure?: MeasureText): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  const x = (opts.pdfx ?? "none") !== "none";
  const uploaded = new Set(Object.values(scene.fonts).map((f) => f.family.toLowerCase()));
  const pageOf = new Map<string, string>();
  for (const p of scene.pages) if (!p.isMaster) pageOf.set(p.id, p.id);
  const pageIdOf = (n: NodeLite): string | undefined => {
    for (let c: NodeLite | undefined = n, g = 0; c && g < 64; c = scene.nodes.get(c.parentId), g++) if (pageOf.has(c.parentId)) return c.parentId;
    return undefined;
  };

  // Fonts that are not uploaded cannot be embedded: the PDF falls back to a standard face.
  const seen = new Set<string>();
  for (const n of scene.nodes.values()) {
    for (const fam of familyList(n)) {
      if (GENERIC.test(fam) || uploaded.has(fam.toLowerCase()) || seen.has(fam)) continue;
      seen.add(fam);
      out.push({
        severity: x ? "error" : "warning", code: "font-not-embedded", nodeId: n.id, pageId: pageIdOf(n),
        message: `Font "${fam}" is not uploaded to the document, so it cannot be embedded: the PDF uses a standard face instead.${x ? " PDF/X requires every font embedded." : ""}`,
      });
    }
  }

  // Text that does not fit its frame (threaded frames are laid out as a story, so they are not judged here).
  if (measure) {
    for (const n of scene.nodes.values()) {
      if (n.kind !== "text" || !n.text || n.meta?.["text.next"] || n.meta?.["text.prev"]) continue;
      const lines = placeTextLines((s) => measure(s, n.text!.style), n, (st) => (s) => measure(s, st));
      const last = lines[lines.length - 1];
      if (last && last.y > n.y + n.height + n.text.style.fontSize * 0.3) {
        out.push({ severity: "warning", code: "overset", nodeId: n.id, pageId: pageIdOf(n), message: `Text in "${n.name}" does not fit its frame; it runs past the bottom.` });
      }
    }
  }

  const pages = scene.pages.filter((p) => !p.isMaster);
  for (const p of pages) {
    if (!(p.width && p.height)) out.push({ severity: "warning", code: "page-unsized", pageId: p.id, message: `Page "${p.name}" has no size; it is exported as the bounds of what is drawn on it.` });
    else if ((opts.bleed || opts.marks) && !p.bleed) out.push({ severity: "warning", code: "no-bleed", pageId: p.id, message: `Page "${p.name}" has no bleed; artwork that reaches the edge may show white slivers when trimmed.` });
  }

  if (scene.layers.some((l) => l.noPrint)) {
    const names = scene.layers.filter((l) => l.noPrint).map((l) => l.name).join(", ");
    out.push({ severity: "info", code: "no-print-layer", message: `Layers that do not print: ${names}.` });
  }
  if (scene.layers.some((l) => l.hidden)) out.push({ severity: "info", code: "hidden-layer", message: "Hidden layers are not exported." });

  if (x && scene.settings?.colorMode !== "cmyk" && (opts.pdfx === "x1a")) {
    out.push({ severity: "info", code: "convert-cmyk", message: "PDF/X-1a is CMYK only: RGB colours are converted with the plain device conversion (no ICC profile is applied)." });
  }
  if (x && !scene.settings?.iccProfile) {
    out.push({ severity: "warning", code: "no-condition", message: "No output condition (ICC profile name) is set in Swatches and colour mode; the output intent will read \"Custom\"." });
  }
  for (const n of scene.nodes.values()) {
    const mode = n.meta?.["overprint"];
    if (!mode || n.fromMaster) continue;
    const white = (f: { r: number; g: number; b: number } | undefined) => !!f && f.r >= 0.995 && f.g >= 0.995 && f.b >= 0.995;
    if (((mode === "fill" || mode === "both") && white(n.fills[0])) || ((mode === "stroke" || mode === "both") && white(n.strokes[0]?.color))) {
      out.push({ severity: "warning", code: "overprint-white", nodeId: n.id, pageId: pageIdOf(n), message: `"${n.name}" overprints white: it will not show on press (white knocks nothing out).` });
    }
  }
  if (x && (opts.pdfx === "x1a" || opts.pdfx === "x3")) {
    const total = Object.values(scene.variables).filter((v) => v.swatch && v.cmyk && !v.spotName && Math.round((v.cmyk.c + v.cmyk.m + v.cmyk.y + v.cmyk.k) * 100) > 300);
    if (total.length > 0) out.push({ severity: "warning", code: "ink-limit", message: `Total ink over 300% in: ${total.map((v) => v.name).join(", ")}.` });
  }
  const spots = Object.values(scene.variables).filter((v) => v.swatch && v.spotName);
  if (spots.length > 0) out.push({ severity: "info", code: "spot-colours", message: `Spot colours become separations: ${[...new Set(spots.map((s) => s.spotName))].join(", ")}.` });
  return out;
}

/** What the writer found while writing the file. */
export function preflightReport(report: PdfReport, opts: PreflightOptions = {}, missingImages = 0, missingFonts = 0): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  const x = (opts.pdfx ?? "none") !== "none";
  for (const l of report.lowResolution) out.push({ severity: x ? "error" : "warning", code: "low-resolution", message: `An image on "${l.page}" prints at ${l.ppi} ppi (under 150).` });
  for (const g of report.missingGlyphs) out.push({ severity: "warning", code: "missing-glyph", message: `Font lacks a glyph: ${g}.` });
  if (missingImages > 0) out.push({ severity: "error", code: "missing-image", message: `${missingImages} image${missingImages === 1 ? "" : "s"} could not be read and ${missingImages === 1 ? "is" : "are"} drawn as placeholders.` });
  if (missingFonts > 0) out.push({ severity: "warning", code: "font-unreadable", message: `${missingFonts} uploaded font${missingFonts === 1 ? "" : "s"} could not be read.` });
  if (report.transparency && (opts.pdfx === "x1a" || opts.pdfx === "x3")) out.push({ severity: "error", code: "transparency", message: `${opts.pdfx === "x1a" ? "PDF/X-1a" : "PDF/X-3"} does not allow transparency (opacity, blend modes); this file uses it. Use PDF/X-4 or flatten.` });
  if (report.usesRgb && opts.pdfx === "x1a") out.push({ severity: "error", code: "rgb", message: "RGB content remains (images); PDF/X-1a is CMYK only." });
  if (report.flattened.length > 0) out.push({ severity: "warning", code: "effects", message: `${report.flattened.length} object${report.flattened.length === 1 ? "" : "s"} use blur or inner-shadow effects the PDF cannot reproduce (drop shadows are drawn hard-edged).` });
  return out;
}

export const hasErrors = (issues: readonly PreflightIssue[]) => issues.some((i) => i.severity === "error");
