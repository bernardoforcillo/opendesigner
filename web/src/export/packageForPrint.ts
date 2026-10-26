import type { SceneState } from "@/store/types";
import { sfntKind } from "@/pdf/sfnt";
import { dataUrlBytes } from "@/pdf/write/pdfImages";
import type { PdfReport } from "@/pdf/write/pdfDocument";
import type { PreflightIssue } from "@/export/preflight";
import { zipStore, type ZipEntry } from "@/export/zip";

// PACKAGE FOR PRINT: one zip a print shop can open without this editor -- the PDF, every uploaded font,
// every placed image file, and a plain-text report of what is in it. It does NOT contain the editable
// document (that stays in the app and on the server); it is the OUTPUT and its ingredients.
//
//   <Name>/<Name>.pdf        the export, with the options chosen
//   <Name>/Fonts/            the uploaded fonts, as they were uploaded
//   <Name>/Links/            the placed images, as they were uploaded
//   <Name>/Report.txt        pages, standard, colour, fonts, links, preflight

const enc = new TextEncoder();

const safe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^[-\s.]+|[-\s.]+$/g, "") || "file";

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

export interface PackageDeps {
  loadAssetDataUrl: (docId: string, hash: string) => Promise<string | null>;
}

export interface PackageInput {
  scene: SceneState;
  pdf: Uint8Array;
  report: PdfReport;
  issues: readonly PreflightIssue[];
  now: Date;
}

/** `name`, `name-2`, `name-3`... so two files never share a path. */
function unique(taken: Set<string>, base: string, ext: string): string {
  let n = 1, name = `${base}.${ext}`;
  while (taken.has(name.toLowerCase())) name = `${base}-${++n}.${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

export async function buildPackage(input: PackageInput, deps: PackageDeps): Promise<{ bytes: Uint8Array; missing: string[] }> {
  const { scene } = input;
  const root = safe(scene.name || "opendesigner");
  const entries: ZipEntry[] = [{ name: `${root}/${root}.pdf`, data: input.pdf }];
  const missing: string[] = [];

  const fontNames = new Set<string>();
  const fontLines: string[] = [];
  for (const f of Object.values(scene.fonts).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const uri = await deps.loadAssetDataUrl(scene.id, f.assetHash).catch(() => null);
    const d = uri === null ? null : dataUrlBytes(uri);
    if (!d) { missing.push(`font ${f.family}`); fontLines.push(`  ${f.family} ${f.weight}${f.style === "italic" ? " italic" : ""}: MISSING`); continue; }
    const name = unique(fontNames, safe(`${f.family}-${f.weight}${f.style === "italic" ? "-italic" : ""}`), sfntKind(d.bytes) ?? "ttf");
    entries.push({ name: `${root}/Fonts/${name}`, data: d.bytes });
    fontLines.push(`  ${f.family} ${f.weight}${f.style === "italic" ? " italic" : ""} → Fonts/${name}`);
  }

  const linkNames = new Set<string>();
  const linkLines: string[] = [];
  const seen = new Set<string>();
  for (const n of scene.nodes.values()) {
    const hash = n.kind === "image" ? n.image?.assetHash : n.fills[0]?.image?.assetHash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const uri = await deps.loadAssetDataUrl(scene.id, hash).catch(() => null);
    const d = uri === null ? null : dataUrlBytes(uri);
    const label = n.image?.originalName || hash.slice(0, 12);
    if (!d) { missing.push(`image ${label}`); linkLines.push(`  ${label}: MISSING`); continue; }
    const given = n.image?.originalName ?? "";
    const dot = given.lastIndexOf(".");
    const base = safe(dot > 0 ? given.slice(0, dot) : given || hash.slice(0, 12));
    const ext = dot > 0 && dot > given.length - 6 ? given.slice(dot + 1).toLowerCase() : MIME_EXT[d.mime] ?? "bin";
    const name = unique(linkNames, base, ext);
    entries.push({ name: `${root}/Links/${name}`, data: d.bytes });
    linkLines.push(`  ${label} → Links/${name}${n.image?.pixelWidth ? ` (${n.image.pixelWidth} × ${n.image.pixelHeight} px)` : ""}`);
  }

  const r = input.report;
  const lines = [
    `${scene.name || "opendesigner"} — package for print`,
    `Created: ${input.now.toISOString()}`,
    "",
    `PDF: ${root}.pdf — ${r.pages} page${r.pages === 1 ? "" : "s"}, standard: ${r.pdfx === "none" ? "none" : r.pdfx.toUpperCase().replace("X", "X-")} (ready, not validated)`,
    `Colour mode: ${scene.settings?.colorMode === "cmyk" ? "CMYK" : "RGB"}; output condition: ${scene.settings?.iccProfile || "none set"} (recorded, no profile embedded)`,
    `Colours used in the PDF: ${[r.usesRgb ? "RGB" : "", r.usesCmyk ? "CMYK" : "", ...r.spots.map((s) => `spot ${s}`)].filter(Boolean).join(", ") || "none"}`,
    `Transparency: ${r.transparency ? "yes" : "no"}`,
    "",
    "Fonts (uploaded):", ...(fontLines.length ? fontLines : ["  none"]),
    ...(r.substitutedFonts.length ? ["Fonts NOT embedded (standard faces used):", ...r.substitutedFonts.map((s) => `  ${s}`)] : []),
    "",
    "Links (placed images):", ...(linkLines.length ? linkLines : ["  none"]),
    "",
    "Preflight:", ...(input.issues.length ? input.issues.map((i) => `  [${i.severity}] ${i.message}`) : ["  no problems found"]),
    "",
  ];
  entries.push({ name: `${root}/Report.txt`, data: enc.encode(lines.join("\n")) });
  return { bytes: zipStore(entries), missing };
}
