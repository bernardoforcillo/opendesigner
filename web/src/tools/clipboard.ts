import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { nextOrderKey, orderKeyBetween } from "../store/orderKey";
import {
  toPbNode,
  toTextStyleLite,
  type FillLite,
  type NodeLite,
  type SceneState,
  type StrokeAlignLite,
  type StrokeLite,
  type TextAlignLite,
  type TextLite,
} from "../store/types";
import { makeCreateNodeOp, uuid } from "./ops";
import { isTextField } from "./toolManager";

// COPIA / INCOLLA / DUPLICA (traccia 3, task 1).
//
// La clipboard di SISTEMA con un payload JSON tutto nostro, e non solo un
// buffer in memoria: è l'unica forma che permette di copiare in un documento e
// incollare in un ALTRO (o in un'altra finestra), che è il punto della
// funzione. Il buffer in memoria resta come RIPIEGO -- `navigator.clipboard`
// non esiste fuori dai contesti sicuri (http:// non-localhost), e anche dove
// esiste la lettura può essere negata dal permesso "clipboard-read". In quei
// casi copia e incolla continuano a funzionare dentro la finestra.
//
// Il payload è etichettato e versionato apposta: sulla clipboard ci finisce
// anche il testo di chiunque altro, e un incolla non deve tentare di
// interpretare come scena qualunque cosa capiti lì dentro.

export const CLIPBOARD_FORMAT = "brawt/clipboard";
export const CLIPBOARD_VERSION = 1;

// Scostamento (unità MONDO) dei nodi incollati o duplicati. Serve a rendere la
// copia visibile: senza, atterrerebbe esattamente sopra l'originale e sembrerebbe
// che non sia successo niente.
export const PASTE_OFFSET = 16;

// L'avviso quando il payload è nostro ma parla di qualcosa che questa build non
// conosce. Passa da `notice` e non da `lastError`: nessuna modifica è stata
// annullata (non è stata nemmeno tentata), ed è un'informazione, non un errore
// del server.
const UNSUPPORTED_NOTICE =
  "gli appunti contengono un elemento che questa versione non sa leggere: non è stato incollato niente";

// --- il formato -------------------------------------------------------------

// I tipi di nodo che questa build sa ricostruire. È un Record indicizzato su
// NodeLite["kind"] e non un array di stringhe: aggiungere un kind al modello
// senza elencarlo qui diventa un errore di COMPILAZIONE, invece di un payload
// che si incolla come rettangolo perché il campo non è stato riconosciuto.
// `image` è qui, e con lui si copia solo l'HASH: i byte restano nella cartella
// assets del documento di partenza. Incollare in un ALTRO documento produce
// quindi un nodo il cui asset non c'è -- che il renderer disegna come
// segnaposto invece di sparire o esplodere. È il comportamento onesto: la copia
// dice a quale immagine si riferisce, e se quell'immagine non è raggiungibile
// da lì lo si vede. (Copiare anche i byte vorrebbe dire mettere una foto negli
// appunti di sistema come JSON: proprio ciò che l'indirizzamento per contenuto
// esiste per evitare.)
const KNOWN_KINDS: Record<NodeLite["kind"], true> = {
  rect: true,
  ellipse: true,
  text: true,
  image: true,
};

function isKnownKind(kind: unknown): kind is NodeLite["kind"] {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(KNOWN_KINDS, kind);
}

// L'esito di una lettura degli appunti. Le due forme di rifiuto sono diverse e
// vanno tenute distinte:
//  - "foreign": non è roba nostra (testo di un'altra applicazione, JSON di
//    qualcun altro, appunti vuoti). Non è un errore: semplicemente non c'è
//    niente da incollare da lì. Attenzione, non è nemmeno un lasciapassare per
//    il buffer in memoria: se gli appunti si sono lasciati leggere, quel testo
//    È la copia più recente dell'utente (vedi pasteClipboard).
//  - "unsupported": è un payload brawt, ma di una versione o con un tipo di
//    nodo che questa build non sa ricostruire. Qui il ripiego sarebbe SBAGLIATO
//    (l'utente ha copiato QUELLO), e degradare il nodo lo sarebbe di più: si
//    rifiuta e lo si dice.
export type ClipboardParse =
  | { ok: true; nodes: NodeLite[] }
  | { ok: false; reason: "foreign" }
  | { ok: false; reason: "unsupported" };

export function serializeNodes(nodes: readonly NodeLite[]): string {
  return JSON.stringify({ format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, nodes });
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function toFills(v: unknown): FillLite[] {
  if (!Array.isArray(v)) return [];
  return v.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return { r: num(o.r, 0), g: num(o.g, 0), b: num(o.b, 0), a: num(o.a, 1) };
  });
}

const STROKE_ALIGNS: Record<StrokeAlignLite, true> = { center: true, inside: true, outside: true };

function toStrokeAlign(v: unknown): StrokeAlignLite {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(STROKE_ALIGNS, v)
    ? (v as StrokeAlignLite)
    : "center";
}

// Come toFills, dal lato del tratto: il payload della clipboard è JSON del
// nostro stesso formato, riletto in modo difensivo -- un campo mancante o
// storto ricade sul default onesto (nessun tratto, peso 0) invece di far
// esplodere l'incolla. Preserva lo stroke di un nodo copiato attraverso il
// round-trip serializza/incolla.
function toStrokes(v: unknown): StrokeLite[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const c = (o.color ?? {}) as Record<string, unknown>;
    return {
      color: { r: num(c.r, 0), g: num(c.g, 0), b: num(c.b, 0), a: num(c.a, 1) },
      weight: num(o.weight, 0),
      align: toStrokeAlign(o.align),
    };
  });
}

const ALIGNS: Record<TextAlignLite, true> = { left: true, center: true, right: true };

function toAlign(v: unknown): TextAlignLite {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ALIGNS, v)
    ? (v as TextAlignLite)
    : "left";
}

// Un nodo di testo senza `text` non è un errore da rifiutare: è un payload
// scritto male o troncato, e un testo VUOTO è la ricostruzione onesta (lo
// stesso default che toTextStyleLite dà a uno stile assente). Rifiutare qui
// vorrebbe dire buttare via anche i nodi sani che gli stanno accanto.
function toText(v: unknown): TextLite {
  const o = (v ?? {}) as Record<string, unknown>;
  const s = (o.style ?? {}) as Record<string, unknown>;
  const zero = toTextStyleLite(undefined);
  return {
    content: str(o.content, ""),
    style: {
      fontFamily: str(s.fontFamily, zero.fontFamily),
      fontSize: num(s.fontSize, zero.fontSize),
      fontWeight: str(s.fontWeight, zero.fontWeight),
      lineHeight: num(s.lineHeight, zero.lineHeight),
      align: toAlign(s.align),
    },
  };
}

export function parseClipboard(text: string): ClipboardParse {
  if (text.trim() === "") return { ok: false, reason: "foreign" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "foreign" };
  }
  if (typeof payload !== "object" || payload === null) return { ok: false, reason: "foreign" };
  const p = payload as Record<string, unknown>;
  if (p.format !== CLIPBOARD_FORMAT) return { ok: false, reason: "foreign" };
  // Da qui in poi il payload è NOSTRO: ogni rifiuto è "unsupported", mai
  // "foreign" -- l'utente ha copiato questo, e ripiegare in silenzio su una
  // copia precedente incollerebbe una cosa per un'altra.
  if (p.version !== CLIPBOARD_VERSION) return { ok: false, reason: "unsupported" };
  if (!Array.isArray(p.nodes)) return { ok: false, reason: "unsupported" };

  const nodes: NodeLite[] = [];
  for (const raw of p.nodes) {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "unsupported" };
    const n = raw as Record<string, unknown>;
    // IL controllo che conta: un tipo che questa build non conosce (un
    // VectorNode dalla traccia 4, un InstanceNode di M4, una build futura) va
    // rifiutato in BLOCCO. Ricostruirlo come rettangolo -- che è ciò che
    // farebbe qualunque default silenzioso, toNodeLite compreso -- creerebbe un
    // nodo che non è quello che l'utente ha copiato, dentro un documento che
    // poi lo persiste.
    if (!isKnownKind(n.kind)) return { ok: false, reason: "unsupported" };
    const kind = n.kind;
    nodes.push({
      id: str(n.id, ""),
      parentId: str(n.parentId, ""),
      orderKey: str(n.orderKey, ""),
      name: str(n.name, ""),
      visible: bool(n.visible, true),
      opacity: num(n.opacity, 1),
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: num(n.width, 0),
      height: num(n.height, 0),
      rotation: num(n.rotation, 0),
      fills: toFills(n.fills),
      strokes: toStrokes(n.strokes),
      kind,
      cornerRadius: num(n.cornerRadius, 0),
      ...(kind === "text" ? { text: toText(n.text) } : {}),
      // Un'immagine senza hash leggibile non è un payload da rifiutare: è un
      // nodo il cui asset non si trova, cioè esattamente il caso che il
      // renderer già disegna come segnaposto. Stessa scelta di toText su un
      // testo troncato.
      ...(kind === "image"
        ? { image: { assetHash: str((n.image as Record<string, unknown> | undefined)?.assetHash, "") } }
        : {}),
    });
  }
  return { ok: true, nodes };
}

// --- gli op di incolla ------------------------------------------------------

function byOrderKey(a: NodeLite, b: NodeLite): number {
  return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0;
}

// Un id che il documento di destinazione conosce: un nodo oppure una pagina
// (le pagine non stanno in `nodes`, ma sono parent legittimi -- oggi anzi gli
// unici).
function existsInScene(scene: SceneState, id: string): boolean {
  return id in scene.nodes || scene.pages.some((p) => p.id === id);
}

export interface PasteOps {
  ops: Op[];
  // Gli id NUOVI, nell'ordine in cui i nodi vengono creati: la selezione da
  // installare dopo l'incolla.
  ids: string[];
}

/**
 * Gli op di creazione per incollare `nodes` dentro `scene`.
 *
 * Scritta in termini dei NODI PASSATI e del loro parent, mai di "tutti i nodi
 * del documento": è ciò che le permette di sopravvivere all'annidamento
 * (traccia 1), dove un payload conterrà un contenitore insieme ai suoi figli.
 *
 * Ogni nodo riceve un id NUOVO (un id duplicato farebbe rifiutare l'op dal
 * server -- ErrNodeExists in core.applyCreate -- lasciando la scena locale
 * divergente) e una order key NUOVA presa dall'indice frazionario, in cima al
 * documento e nell'ordine relativo dei nodi di partenza.
 */
export function pasteOps(
  scene: SceneState,
  nodes: readonly NodeLite[],
  offset: number = PASTE_OFFSET,
): PasteOps {
  const sorted = [...nodes].sort(byOrderKey);
  // Un id nuovo per POSIZIONE nell'elenco, non per id di partenza. La
  // differenza conta perché gli id del payload non sono garantiti: parseClipboard
  // tollera un nodo senza `id` (lo legge come "") e niente vieta a un payload
  // scritto a mano di ripetere due volte lo stesso id. Indicizzando sull'id,
  // quei nodi collasserebbero su UN SOLO uuid e uscirebbero da qui due CreateNode
  // con lo stesso id: in locale applyOp scarta il secondo (parità con
  // core.applyCreate, ErrNodeExists) e la scena guadagna un nodo mentre `ids` e
  // la voce di undo ne dichiarano due; contro il server l'op viene RIFIUTATO a
  // gesto iniziato e parte il rollback. N nodi passati, N nodi creati, sempre.
  const freshIds = sorted.map(() => uuid());

  // La corrispondenza vecchio id -> nuovo id, calcolata PRIMA di costruire gli
  // op: serve SOLO a rimappare i parent (vedi sotto), che possono puntare a un
  // nodo che viene dopo nell'elenco. Due esclusioni, entrambe necessarie:
  //  - l'id VUOTO non è un'identità: mapparlo attaccherebbe ogni nodo senza
  //    parent (parentId "") alla copia del nodo senza id;
  //  - un id RIPETUTO è ambiguo (a quale delle due copie si riferisce un
  //    figlio?): si registra `null` e non si rimappa affatto, così il parent
  //    ricade sui casi 2/3 qui sotto invece di essere tirato a sorte.
  const byOldId = new Map<string, string | null>();
  sorted.forEach((n, i) => {
    if (n.id === "") return;
    byOldId.set(n.id, byOldId.has(n.id) ? null : freshIds[i]);
  });

  const fallbackParent = scene.pages[0]?.id ?? "";
  let key = nextOrderKey(scene);
  const ops: Op[] = [];
  const ids: string[] = [];

  for (const [i, n] of sorted.entries()) {
    const id = freshIds[i];
    // Un nodo che dichiara sé stesso come proprio parent è un ciclo: non lo si
    // rimappa (oggi sarebbe innocuo, con l'annidamento della traccia 1 no).
    const mapped = n.parentId === n.id ? null : (byOldId.get(n.parentId) ?? null);
    // Tre casi, in quest'ordine:
    //  1. il parent è anch'esso nel payload -> il figlio segue la COPIA, non
    //     l'originale (senza questo, incollare un gruppo lascerebbe i figli
    //     attaccati al gruppo di partenza);
    //  2. il parent esiste nel documento di destinazione -> resta dov'è;
    //  3. non esiste (incolla in un ALTRO documento) -> il nodo atterra sulla
    //     pagina, invece di restare orfano di un parent inesistente.
    const parentId =
      mapped ?? (existsInScene(scene, n.parentId) ? n.parentId : fallbackParent);
    // L'offset lo prendono solo le RADICI dell'insieme incollato. Oggi le
    // coordinate sono tutte mondo e la scena è piatta, quindi sono tutti i
    // nodi; quando le coordinate diventeranno relative al parent, spostare
    // anche i figli li sposterebbe due volte. "Radice" = parent NON rimappato:
    // un parent ambiguo o inesistente lascia il nodo scoperto, quindi radice.
    const moved = mapped !== null ? { x: n.x, y: n.y } : { x: n.x + offset, y: n.y + offset };
    // toPbNode è l'inverso ESATTO di toNodeLite (store/types.ts): passare da lì
    // invece di ricostruire il Node a mano è ciò che fa sopravvivere alla copia
    // ogni campo del modello, compresi quelli aggiunti dopo.
    ops.push(makeCreateNodeOp(toPbNode({ ...n, id, parentId, orderKey: key, ...moved })));
    ids.push(id);
    key = orderKeyBetween(key, null);
  }
  return { ops, ids };
}

// --- la clipboard di sistema ------------------------------------------------

// Il RIPIEGO: l'ultima copia fatta in questa finestra. Serve quando la
// clipboard di sistema non c'è o non si lascia leggere; dentro la finestra
// copia e incolla continuano a funzionare comunque.
//
// Un oggetto esportato e non una `let` privata: è stato di MODULO, quindi vive
// quanto la pagina, e "non è mai stata fatta una copia" è uno stato di partenza
// legittimo che va poter essere ripristinato (i test lo azzerano come azzerano
// lo store). `null` = nessuna copia in questa finestra.
//
// `onSystem` dice se l'ultima copia è ARRIVATA sulla clipboard di sistema. È
// ciò che distingue "il buffer è una comodità, la copia vera è là fuori" da "il
// buffer è l'UNICA copia che esiste": solo nel secondo caso ripiegarci sopra è
// legittimo quando gli appunti si leggono ma contengono roba di qualcun altro
// (vedi pasteClipboard).
export const clipboardMemory: { text: string | null; onSystem: boolean } = {
  text: null,
  onSystem: false,
};

// Un incolla per volta. La lettura degli appunti è ASINCRONA e può restare
// appesa a lungo -- Chromium non risolve `readText()` finché il documento non
// ha il fuoco -- e nel frattempo l'utente che non vede succedere niente preme
// Ctrl+V di nuovo. Senza guardia quelle letture si accodano tutte e atterrano
// INSIEME appena la prima si sblocca: una raffica di incolla che nessuno ha
// chiesto, per giunta da disfare un Ctrl+Z per volta.
let pasting = false;

function systemClipboard(): Clipboard | undefined {
  // `navigator` esiste ovunque giri questo codice, ma `clipboard` no (contesti
  // non sicuri): il controllo è sulla proprietà, non sull'oggetto.
  return globalThis.navigator?.clipboard as Clipboard | undefined;
}

async function writeSystem(text: string): Promise<boolean> {
  const cb = systemClipboard();
  if (typeof cb?.writeText !== "function") return false;
  try {
    await cb.writeText(text);
    return true;
  } catch {
    // Permesso negato, documento non a fuoco: la copia resta valida in memoria.
    return false;
  }
}

async function readSystem(): Promise<string | null> {
  const cb = systemClipboard();
  if (typeof cb?.readText !== "function") return null;
  try {
    return await cb.readText();
  } catch {
    return null;
  }
}

// --- i comandi --------------------------------------------------------------

function selectedNodes(): NodeLite[] {
  const { scene, selection } = useScene.getState();
  if (!scene) return [];
  // Passa dalla SELEZIONE e non da Object.values(scene.nodes): è la stessa
  // ragione per cui pasteOps parla dei nodi passati e non del documento --
  // sopravvivere all'annidamento senza riscritture.
  return selection.map((id) => scene.nodes[id]).filter((n): n is NodeLite => n !== undefined);
}

/**
 * Ctrl+C. Ritorna false quando non c'è niente da copiare (nessuna selezione,
 * nessun documento): in quel caso la clipboard di sistema NON viene toccata --
 * svuotarla sarebbe una modifica che l'utente non ha chiesto.
 */
export async function copySelection(): Promise<boolean> {
  const nodes = selectedNodes();
  if (nodes.length === 0) return false;
  const text = serializeNodes(nodes);
  // Il buffer in memoria si scrive SEMPRE, anche quando la clipboard di sistema
  // è disponibile: se la scrittura di sistema fallisce a metà (permesso, focus
  // perso) l'incolla dentro questa finestra deve comunque funzionare.
  clipboardMemory.text = text;
  clipboardMemory.onSystem = await writeSystem(text);
  return true;
}

// Il tratto comune di incolla e duplica: UN gesto, quindi UNA voce di undo --
// un Ctrl+Z toglie tutto l'incollato insieme, non un nodo per volta.
function pasteNodes(nodes: readonly NodeLite[]): string[] {
  const store = useScene.getState();
  const scene = store.scene;
  if (!scene || nodes.length === 0) return [];
  // Stessa guardia di undo/redo (store.ts): a gesto aperto (un drag in corso)
  // gli op finirebbero nella BASE del gesto, e il pointerup successivo
  // ricostruirebbe la scena su uno stato che non è quello da cui il drag è
  // partito.
  if (store.gesture) return [];

  const { ops, ids } = pasteOps(scene, nodes);
  store.beginGesture();
  // La selezione va sui nodi NUOVI, come in ogni editor: è l'incollato che si
  // sposta subito dopo. Impostata prima di endGesture, che la riconcilia contro
  // la scena FINALE (quella che contiene i nodi appena creati) -- vedi il
  // commento su `intended` in store.ts.
  useScene.getState().setSelection(ids);
  useScene.getState().endGesture(ops);
  return ids;
}

/**
 * Ctrl+V. Legge la clipboard di SISTEMA (così un payload copiato in un'altra
 * finestra o in un altro documento si incolla qui) e ripiega sul buffer in
 * memoria solo quando quella clipboard non è arrivabile -- non quando è
 * arrivabile e contiene qualcos'altro.
 */
export async function pasteClipboard(): Promise<string[]> {
  if (pasting) return [];
  pasting = true;
  try {
    const fromSystem = await readSystem();
    let parsed: ClipboardParse | null = fromSystem === null ? null : parseClipboard(fromSystem);
    // Quando si può ripiegare sul buffer in memoria. NON basta che gli appunti
    // contengano roba di qualcun altro: una lettura RIUSCITA è l'ultima copia
    // che l'utente ha fatto davvero (testo selezionato nel pannello livelli e
    // Ctrl+C -- che qui cede al browser apposta -- oppure una copia in un'altra
    // applicazione), e incollarci sopra un rettangolo copiato dieci minuti
    // prima sarebbe incollare una cosa per un'altra, in silenzio: lo stesso
    // motivo per cui un payload `unsupported` non ripiega. Restano i due casi
    // in cui il buffer è l'unica copia che esiste:
    //  - gli appunti non hanno risposto (`null`: API assente fuori dai contesti
    //    sicuri, oppure lettura negata/fallita);
    //  - la nostra copia non è mai arrivata fin lì (scrittura negata o senza
    //    fuoco), quindi là fuori non c'è nulla che la rappresenti.
    const mayFallBack = fromSystem === null || !clipboardMemory.onSystem;
    if (mayFallBack && (parsed === null || (!parsed.ok && parsed.reason === "foreign"))) {
      parsed = clipboardMemory.text === null ? null : parseClipboard(clipboardMemory.text);
    }
    if (parsed === null) return [];
    if (!parsed.ok) {
      if (parsed.reason === "unsupported") {
        // Scritto direttamente nello stato: `notice` è un canale di sola lettura
        // per la UI (ui/App.tsx lo mostra e offre di chiuderlo), non ha
        // un'azione dedicata, e questo modulo non ha ragione di aggiungerne una
        // allo store.
        useScene.setState({ notice: UNSUPPORTED_NOTICE });
      }
      return [];
    }
    return pasteNodes(parsed.nodes);
  } finally {
    pasting = false;
  }
}

/**
 * Ctrl+D. Duplica la selezione con lo stesso scostamento dell'incolla e NON
 * tocca gli appunti: duplicare non è copiare, e sovrascrivere la clipboard
 * butterebbe via quello che l'utente ci aveva messo.
 *
 * Un Ctrl+D ripetuto scala: le copie restano selezionate, quindi il duplicato
 * successivo parte da loro.
 */
export function duplicateSelection(): string[] {
  return pasteNodes(selectedNodes());
}

// --- le scorciatoie ---------------------------------------------------------

interface ShortcutTarget {
  addEventListener(type: "keydown", handler: (e: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", handler: (e: KeyboardEvent) => void): void;
}

/**
 * Collega Ctrl/Cmd+C, +V, +D. Sulla FINESTRA come le scorciatoie di undo/redo
 * (ui/App.tsx) e per lo stesso motivo: il canvas non è focusabile, quindi i
 * tasti non gli arriverebbero mai.
 *
 * Ritorna la funzione di distacco.
 */
export function attachClipboardShortcuts(target: ShortcutTarget = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Dentro un campo di testo la copia è del CAMPO: rubargliela vorrebbe dire
    // copiare il rettangolo selezionato invece della parola evidenziata.
    if (isTextField(e.target)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    switch (e.key.toLowerCase()) {
      case "c": {
        // Con del testo evidenziato nella pagina (pannello livelli, avvisi) la
        // copia resta del browser: è quella che l'utente sta chiedendo.
        const sel = globalThis.getSelection?.();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        void copySelection();
        return;
      }
      case "v":
        e.preventDefault();
        void pasteClipboard();
        return;
      case "d":
        // preventDefault sempre: Ctrl+D è "aggiungi ai preferiti" nel browser.
        e.preventDefault();
        duplicateSelection();
        return;
      default:
        return;
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
