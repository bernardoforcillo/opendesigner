import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op, Variable, VariableCollection } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../rpc/client";
import { insertDiagram } from "../diagram/insert";
import { useScene } from "../store/store";
import { viewportCenter } from "../tools/svgImport";

// IMPORTING A FIGMA FILE (document menu → Import .fig file…). EXPERIMENTAL: .fig is not a public
// format, so the server reads it with a best-effort reader (internal/figimport) and says what it
// could not carry over. The nodes come back like a drawn diagram -- a wrapper group first, one
// gesture, one undo step -- and the warnings are shown to the person. The file's variable collections
// and variables come back beside the nodes (whose bindings and modes name them): they are created
// first, in the order given (an alias after its target), in the same gesture.

export interface FigImportResult {
  ok: boolean;
  /** What to tell the person: what came across, or why nothing did. */
  message: string;
  warnings: string[];
}

export interface FigClient {
  importFig(req: { docId: string; data: Uint8Array; name: string }): Promise<{
    nodes: unknown[]; width: number; height: number; warnings: string[];
    collections?: VariableCollection[]; variables?: Variable[];
  }>;
}

/** The ops creating the imported collections, then the variables. */
export function variableOps(docId: string, collections: VariableCollection[] = [], variables: Variable[] = []): Op[] {
  const op = (kind: MessageInitShape<typeof OpSchema>["kind"]) => create(OpSchema, { opId: crypto.randomUUID(), docId, kind });
  return [
    ...collections.map((collection) => op({ case: "setCollection", value: { collection } })),
    ...variables.map((variable) => op({ case: "setVariable", value: { variable } })),
  ];
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
    const id = insert(res as Parameters<typeof insertDiagram>[0], viewportCenter(), undefined, variableOps(docId, res.collections, res.variables));
    if (id === null) return { ok: false, message: "Could not insert it (another edit is in progress).", warnings: res.warnings };
    const nv = res.variables?.length ?? 0;
    const nc = res.collections?.length ?? 0;
    const vars = nv > 0 ? ` and ${nv} variable${nv === 1 ? "" : "s"} in ${nc} collection${nc === 1 ? "" : "s"}` : "";
    return { ok: true, message: `Imported ${res.nodes.length - 1} layers${vars} from ${file.name}.`, warnings: res.warnings };
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
