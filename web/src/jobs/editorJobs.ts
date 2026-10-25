import { runDocumentExport, runExport, runPackage, runPreflight, type DocumentExportDeps } from "../export/exportScene";
import type { PrintPdfOptions } from "../export/printPdf";
import { useScene } from "../store/store";
import { runCommand } from "./commands";

// EDITOR JOBS: the outputs an agent asks for over MCP that only the editor can make, because they need the text
// layout and the fonts it has (PDF, EPUB, PNG, SVG, the print package, the full preflight). The server hands a job
// to an editor with the document open (rpc/jobs.ts); this runs it through the very same functions the menus use,
// capturing the file instead of downloading it. The result is what the menu would have produced -- a notice
// the editor shows ("PDF written with warnings: ...") travels back as the job's message.

export interface JobResult {
  ok: boolean;
  message?: string;
  filename?: string;
  contentType?: string;
  data?: Uint8Array;
  text?: string;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };
const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "";

const STANDARDS = new Set(["none", "x1a", "x3", "x4"]);

function printOptions(o: Record<string, unknown>): PrintPdfOptions | string {
  const out: PrintPdfOptions = {};
  if (o.standard !== undefined) {
    if (typeof o.standard !== "string" || !STANDARDS.has(o.standard)) return `standard must be none, x1a, x3 or x4`;
    out.pdfx = o.standard as PrintPdfOptions["pdfx"];
  }
  for (const k of ["bleed", "marks", "slug", "spreads", "interactive", "booklet", "tagged"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return `${k} must be true or false`;
    out[k] = o[k] as boolean;
  }
  return out;
}

/** Runs one job. Never throws: a failure is a result with `ok: false` and the reason. */
export async function executeJob(kind: string, optionsJson: string, deps: DocumentExportDeps = {}, input: { name: string; data: Uint8Array } | null = null): Promise<JobResult> {
  let o: Record<string, unknown> = {};
  if (optionsJson.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(optionsJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: "options must be a JSON object" };
      o = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, message: "options are not valid JSON" };
    }
  }
  if (!useScene.getState().scene) return { ok: false, message: "the editor has no document open" };

  let got: { blob: Blob; filename: string } | null = null;
  const capture: DocumentExportDeps = { ...deps, download: (blob, filename) => { got = { blob, filename }; } };
  useScene.setState({ notice: null });
  let ok: boolean;
  try {
    switch (kind) {
      case "export_pdf":
      case "export_package": {
        const po = printOptions(o);
        if (typeof po === "string") return { ok: false, message: po };
        ok = kind === "export_pdf" ? await runDocumentExport("pdf", capture, po) : await runPackage(capture, po);
        break;
      }
      case "export_epub":
        ok = await runDocumentExport("epub", capture);
        break;
      case "export_pptx":
        ok = await runDocumentExport("pptx", capture);
        break;
      case "export_idml":
        ok = await runDocumentExport("idml", capture);
        break;
      case "export_html":
        ok = await runDocumentExport("html", capture);
        break;
      case "export_epub_reflow":
        ok = await runDocumentExport("epub-reflow", capture);
        break;
      case "export_png":
      case "export_svg": {
        const scale = o.scale === undefined ? 1 : o.scale;
        if (scale !== 1 && scale !== 2 && scale !== 3) return { ok: false, message: "scale must be 1, 2 or 3" };
        if (o.pageId !== undefined && typeof o.pageId !== "string") return { ok: false, message: "pageId must be a string" };
        if (o.nodeIds !== undefined && !(Array.isArray(o.nodeIds) && o.nodeIds.every((x) => typeof x === "string"))) return { ok: false, message: "nodeIds must be a list of ids" };
        ok = await runExport({
          format: kind === "export_png" ? "png" : "svg", scope: o.nodeIds ? "selection" : "page", scale,
          ...(o.pageId ? { pageId: o.pageId as string } : {}), ...(o.nodeIds ? { nodeIds: o.nodeIds as string[] } : {}),
        }, capture);
        break;
      }
      case "preflight": {
        const po = printOptions(o);
        if (typeof po === "string") return { ok: false, message: po };
        const issues = await runPreflight(capture, po);
        if (issues === null) return { ok: false, message: "nothing to check: every page is empty" };
        return { ok: true, text: JSON.stringify({ issues, errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length }) };
      }
      case "command":
        return await runCommand(o, input && input.data.length > 0 ? new File([input.data as BlobPart], input.name || "file", { type: mimeOf(input.name) }) : null);
      default:
        return { ok: false, message: `unknown job kind ${kind}` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const notice = useScene.getState().notice ?? undefined;
  const file = got as { blob: Blob; filename: string } | null;
  if (!ok || !file) return { ok: false, message: notice ?? "nothing was produced" };
  return {
    ok: true, message: notice, filename: file.filename, contentType: file.blob.type || "application/octet-stream",
    data: new Uint8Array(await file.blob.arrayBuffer()),
  };
}
