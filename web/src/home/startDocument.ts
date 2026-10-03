import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { templateOps } from "../templates/catalog";
import type { Template } from "../templates/catalog";

// CREARE UN DOCUMENTO DA UN TEMPLATE, dalla Home: crea il documento sul server,
// legge l'id della sua prima pagina e gli manda gli Op del template UNO DOPO
// L'ALTRO (il padre deve esistere prima dei figli, e SubmitOp risponde quando
// l'op è già durevole). L'editor poi si apre su un documento già pieno, come se
// quelle schermate le avesse disegnate l'utente.

/** La parte del client RPC che serve qui: i test passano un finto. */
export interface StartClient {
  createDocument(req: { name: string }): Promise<{ id: string }>;
  openDocument(req: { docId: string }): Promise<{ snapshot?: { pages: { id: string }[] } }>;
  submitOp(req: { docId: string; clientId: string; op: Op }): Promise<unknown>;
}

export interface StartOptions {
  /** Id del client che figura come autore degli Op. */
  clientId?: string;
  onProgress?: (done: number, total: number) => void;
  /** Id per i nodi (i test lo rendono deterministico). */
  newId?: () => string;
}

export class StartError extends Error {
  constructor(message: string, readonly docId: string | null) {
    super(message);
  }
}

/**
 * Manda gli Op del template a un documento GIÀ esistente, in ordine. Serve a
 * `startDocument` e alla scheda "Da dove parti?" dentro l'editor: lì gli Op
 * vanno per RPC e tornano all'editor dallo stream come record "remoti" (un
 * template ha anche 150 op, più della coda ottimistica del SyncClient).
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

/** Crea il documento e applica il template; ritorna l'id. */
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
    // Un documento creato ma riempito a metà resta nell'elenco della Home (si
    // apre, si elimina): l'errore porta l'id per poterlo dire.
    throw new StartError(err instanceof Error ? err.message : String(err), docId);
  }
}
