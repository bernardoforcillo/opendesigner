import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { templateOps } from "../templates/catalog";
import type { Template } from "../templates/catalog";

// CREATING A DOCUMENT FROM A TEMPLATE, from the Home: creates the document on the server,
// reads the id of its first page and sends it the template's Ops ONE AFTER
// THE OTHER (the parent must exist before the children, and SubmitOp replies when
// the op is already durable). The editor then opens on an already full document, as if
// the user had drawn those screens.

/** The part of the RPC client needed here: tests pass a fake one. */
export interface StartClient {
  createDocument(req: { name: string }): Promise<{ id: string }>;
  openDocument(req: { docId: string }): Promise<{ snapshot?: { pages: { id: string }[] } }>;
  submitOp(req: { docId: string; clientId: string; op: Op }): Promise<unknown>;
}

export interface StartOptions {
  /** Id of the client that appears as the author of the Ops. */
  clientId?: string;
  onProgress?: (done: number, total: number) => void;
  /** Id for the nodes (tests make it deterministic). */
  newId?: () => string;
}

export class StartError extends Error {
  constructor(message: string, readonly docId: string | null) {
    super(message);
  }
}

/**
 * Sends the template's Ops to an ALREADY existing document, in order. It serves
 * `startDocument` and the "Where do you want to start?" card inside the editor: there the Ops
 * go via RPC and come back to the editor from the stream as "remote" records (a
 * template has up to 150 ops, more than the SyncClient's optimistic queue).
 */
export async function applyTemplate(
  client: Pick<StartClient, "submitOp">, docId: string, pageId: string, t: Template, opts: StartOptions = {},
): Promise<void> {
  const ops = templateOps(t, docId, pageId, opts.newId);
  const clientId = opts.clientId ?? "home";
  for (let i = 0; i < ops.length; i++) {
    await client.submitOp({ docId, clientId, op: ops[i] });
    opts.onProgress?.(i + 1, ops.length);
  }
}

/** Creates the document and applies the template; returns the id. */
export async function startDocument(client: StartClient, t: Template, opts: StartOptions = {}): Promise<string> {
  let docId: string | null = null;
  try {
    docId = (await client.createDocument({ name: t.docName })).id;
    if (t.id === "blank") return docId;
    const snap = (await client.openDocument({ docId })).snapshot;
    const pageId = snap?.pages[0]?.id ?? "page1";
    await applyTemplate(client, docId, pageId, t, opts);
    return docId;
  } catch (err) {
    // A document created but half filled stays in the Home list (it can be
    // opened, deleted): the error carries the id so it can be reported.
    throw new StartError(err instanceof Error ? err.message : String(err), docId);
  }
}
