import { Code, ConnectError } from "@connectrpc/connect";
import { docClient } from "../rpc/client";
import { insertDiagram } from "../diagram/insert";
import { useScene } from "../store/store";
import { viewportCenter } from "../tools/svgImport";

// IMPORTING A FIGMA FILE (document menu → Import Figma file…). EXPERIMENTAL: .fig is not a public
// format, so the server reads it with a best-effort reader (internal/figimport) and says what it
// could not carry over. The nodes come back like a drawn diagram -- a wrapper group first, one
// gesture, one undo step -- and the warnings are shown to the person.

export interface FigImportResult {
  ok: boolean;
  /** What to tell the person: what came across, or why nothing did. */
  message: string;
  warnings: string[];
}

export interface FigClient {
  importFig(req: { docId: string; data: Uint8Array; name: string }): Promise<{ nodes: unknown[]; width: number; height: number; warnings: string[] }>;
}

/** Imports `file` into the open document at the center of the view. */
export async function importFigFile(
  file: File,
  client: FigClient = docClient as unknown as FigClient,
  insert: typeof insertDiagram = insertDiagram,
): Promise<FigImportResult> {
  const docId = useScene.getState().scene?.id;
  if (!docId) return { ok: false, message: "No document is open.", warnings: [] };
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const res = await client.importFig({ docId, data, name: file.name });
    // The wrapper group is the first node; the rest follow their parents.
    const id = insert(res as Parameters<typeof insertDiagram>[0], viewportCenter());
    if (id === null) return { ok: false, message: "Could not insert it (another edit is in progress).", warnings: res.warnings };
    return { ok: true, message: `Imported ${res.nodes.length - 1} layers from ${file.name}.`, warnings: res.warnings };
  } catch (e) {
    const ce = ConnectError.from(e);
    return {
      ok: false,
      message: ce.code === Code.InvalidArgument ? ce.rawMessage.replace(/^figimport:\s*/, "") : "The server did not answer: try again.",
      warnings: [],
    };
  }
}

/** The file picker for ".fig" files. */
export function pickFigFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".fig,application/octet-stream";
    input.style.display = "none";
    const done = (f: File | null) => { input.remove(); resolve(f); };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
