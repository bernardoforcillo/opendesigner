import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, GridList, GridListItem, ListLayout, Virtualizer } from "react-aria-components";
import { EmptyState, Icon, IconButton, cls, type IconName } from "./ds";
import type { Selection } from "react-aria-components";
import { useScene } from "../store/store";
import { orderKeyBetween } from "../store/orderKey";
import { ancestorsOf, childIndexOf, childrenOf, isAncestorOf, subtreeOf, topmostOf } from "../store/tree";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { makeDeleteOp, makeReparentOp, makeSetPropsOp } from "../tools/ops";
import type { NodeLite, SceneState } from "../store/types";

// PANNELLO LIVELLI — ALBERO della pagina corrente, con selezione, visibilità,
// eliminazione, rinomina e drag per riordinare/riparentare (Task 7/8 + traccia
// annidamento).
//
// La sincronizzazione bidirezionale con la selezione del canvas non è un
// meccanismo A PARTE: `selectedKeys` viene qui letto dallo STESSO store che
// selectTool scrive (store.selection), e `onSelectionChange` scrive lì con lo
// STESSO store.setSelection che selectTool chiama. Un solo stato, due
// scritture -- niente da tenere sincronizzato a mano fra canvas e pannello.
//
// L'albero mostra la SOLA pagina corrente (store.currentPageId, stato di vista
// come camera e selezione): è la stessa scelta del renderer, che disegna le sole
// radici di quella pagina (canvasRenderer.ts::rootsOf). Cambiare pagina cambia
// l'albero, senza nessun op sul filo.
//
// L'espansione dei container è stato di VISTA locale (come la camera), non una
// voce di undo: vive in questo componente e non viaggia sul filo. Il drag invece
// SÌ -- riordinare fra fratelli e riparentare sono modifiche del documento -- e
// segue la regola di sempre: un drop = un gesto = un op = una voce di undo.

// Un CONTAINER accoglie figli e li mostra come sottoalbero: gruppo e frame. La
// pagina è il container-radice, ma non è un NodeLite (non è una riga
// dell'albero). Solo i container sono bersaglio di riparentazione e solo loro si
// espandono/collassano: dropare "dentro" un rect vuol dire riordinare accanto ad
// esso, non entrarci.
function isContainer(n: NodeLite): boolean {
  return n.kind === "group" || n.kind === "frame";
}

// Una riga dell'albero appiattito: il nodo, la sua profondità (0 = radice di
// pagina) e lo stato di espansione. L'albero si RENDERIZZA come lista piatta di
// righe visibili -- react-aria-components GridList vuole una collezione piatta,
// e appiattire qui (invece di annidare <GridList> dentro <GridList>) tiene
// selezione, navigazione da tastiera e ancora dello shift-click tutte in una
// collezione sola.
export interface LayerRow {
  id: string;
  node: NodeLite;
  depth: number;
  container: boolean;
  hasChildren: boolean;
  expanded: boolean;
}

// L'albero della pagina in PRE-ORDINE, sceso solo nei container espansi. Ogni
// livello di fratelli è in ordine di disegno INVERSO -- primo piano in cima,
// come la vecchia lista piatta e come Figma -- quindi childrenOf (crescente,
// sfondo→primo piano) si scorre a ritroso.
//
// Un `seen` come in tree.ts::subtreeOf: un documento malformato (un nodo figlio
// di se stesso) non deve mandare la ricorsione all'infinito.
//
// `children` è l'indice figli-per-parent (la stessa lista che childrenOf darebbe,
// già ordinata): costruito UNA volta invece di scansionare l'intera scena per
// ogni riga -- con 20.000 nodi le righe erano 20.000 scansioni da 20.000, cioè
// 46 secondi per APRIRE il documento.
export function visibleRows(
  scene: SceneState,
  pageId: string,
  collapsed: ReadonlySet<string> | ((id: string) => boolean),
  children: ReadonlyMap<string, NodeLite[]> = childIndexOf(scene),
): LayerRow[] {
  const isCollapsed = typeof collapsed === "function" ? collapsed : (id: string) => collapsed.has(id);
  const out: LayerRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string, depth: number): void => {
    const siblings = children.get(parentId) ?? [];
    for (let i = siblings.length - 1; i >= 0; i--) {
      const n = siblings[i];
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const container = isContainer(n);
      const hasChildren = container && (children.get(n.id)?.length ?? 0) > 0;
      const expanded = hasChildren && !isCollapsed(n.id);
      out.push({ id: n.id, node: n, depth, container, hasChildren, expanded });
      if (expanded) walk(n.id, depth + 1);
    }
  };
  walk(pageId, 0);
  return out;
}

// L'esito di un drop, calcolato dalla riga sotto il puntatore. È il cuore del
// vedi-vs-seleziona del pannello: la stessa geometria (la riga colpita) decide
// cosa il drop FA.
//  - "reorder": stesso parent, basta cambiare la order key -- il percorso di
//    solo-riordino esiste già (SetProperties order_key) e si riusa;
//  - "reparent": il nodo cambia container (dentro un gruppo/frame, o fuori su
//    un'altra radice) -- serve un ReparentNode, che porta parent e posizione
//    insieme.
// null = niente da fare o drop non valido (su sé stessi, o dentro il proprio
// sottoalbero: sarebbe un ciclo, che il core rifiuta e che qui non si offre).
type DropPlan =
  | { kind: "reorder"; key: string }
  | { kind: "reparent"; parentId: string; key: string };

// orderKeyBetween lancia se il range è vuoto (due vicini con la stessa chiave):
// dentro il gestore di un pointerup vorrebbe dire rompere l'app a metà drag,
// quindi qui si degrada a "nessun drop" (null), come fa reorderKey.
function safeBetween(a: string | null, b: string | null): string | null {
  try {
    return orderKeyBetween(a, b);
  } catch {
    return null;
  }
}

export function dropPlanFor(scene: SceneState, fromId: string, overId: string): DropPlan | null {
  if (fromId === overId) return null;
  const from = scene.nodes.at(fromId);
  const over = scene.nodes.at(overId);
  if (!from || !over) return null;
  // GUARDIA CICLI: `over` non deve stare nel sottoalbero di `from`. isAncestorOf
  // è stretta (from === over è già escluso sopra): calare un nodo dentro un
  // proprio discendente staccherebbe il sottoalbero dal documento, e il core lo
  // rifiuta (ErrCycle) -- l'UI non lo offre nemmeno.
  if (isAncestorOf(scene, fromId, overId)) return null;

  if (isContainer(over)) {
    // DENTRO il container: in cima ai suoi figli (lato primo piano, subito sotto
    // l'intestazione). Un container vuoto parte da FIRST_KEY.
    const kids = childrenOf(scene, overId);
    const topKey = kids.length > 0 ? kids[kids.length - 1].orderKey : null;
    const key = safeBetween(topKey, null);
    return key === null ? null : { kind: "reparent", parentId: overId, key };
  }

  // ACCANTO a `over` (ne diventa un fratello). La lista MOSTRATA dei fratelli del
  // bersaglio: primo piano in cima.
  const parentId = over.parentId;
  const displayed = [...childrenOf(scene, parentId)].reverse();
  if (parentId === from.parentId) {
    // Stesso parent: puro riordino, con la stessa semantica index-based della
    // vecchia lista piatta (reorderKey) -- così i test del riordino esistenti
    // valgono identici quando l'albero è una lista sola.
    const key = reorderKey(
      displayed,
      displayed.findIndex((n) => n.id === fromId),
      displayed.findIndex((n) => n.id === overId),
    );
    return key === null ? null : { kind: "reorder", key };
  }
  // Parent diverso: `from` non è fra i fratelli del bersaglio, quindi si infila
  // appena SOPRA `over` (lato primo piano), fra `over` e il vicino di sopra.
  const overIdx = displayed.findIndex((n) => n.id === overId);
  const aboveKey = displayed[overIdx - 1]?.orderKey ?? null;
  const key = safeBetween(over.orderKey, aboveKey);
  return key === null ? null : { kind: "reparent", parentId, key };
}

// Lunghezza massima del contenuto di un nodo testo usato come nome di
// ripiego (step 3): abbastanza per riconoscere la riga senza spingere il
// pannello in orizzontale. "…" segnala il taglio, non è decorativo.
const TEXT_FALLBACK_MAX = 30;

function fallbackName(n: NodeLite): string {
  if (n.kind === "rect") return "Rectangle";
  if (n.kind === "ellipse") return "Ellipse";
  // Un'immagine di solito ha già un nome (tools/imageDrop.ts usa quello del
  // file), quindi questo ripiego si vede solo per un nodo rinominato a vuoto o
  // arrivato da un incolla senza nome.
  if (n.kind === "image") return "Image";
  if (n.kind === "vector") return "Vector";
  // Un gruppo nasce già con un nome (tools/grouping.ts::GROUP_NAME): questo è
  // il ripiego per un gruppo rinominato a stringa vuota, o arrivato da un
  // documento che non lo aveva.
  if (n.kind === "group") return "Group";
  if (n.kind === "frame") return "Frame";
  // Forma PRESENTE ma non riconosciuta da questo modello (una delle tracce
  // parallele l'ha aggiunta al oneof `shape`): nome neutro. Il ramo esiste
  // perché senza di esso il nodo cadrebbe nel ripiego del TESTO qui sotto e la
  // riga direbbe "Text" per qualcosa che testo non è.
  if (n.kind === "unknown") return "Shape";
  // n.kind === "text": a-capo e spazi ripetuti collassati, così l'etichetta
  // resta su una riga sola anche per un testo multilinea.
  const flat = (n.text?.content ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "Text";
  return flat.length > TEXT_FALLBACK_MAX ? `${flat.slice(0, TEXT_FALLBACK_MAX)}…` : flat;
}

// Il nome mostrato per una riga: `name` se valorizzato, altrimenti il
// fallback per tipo (Task 7, step 3). Esportata perché il pannello proprietà
// (Task 8) mostra lo stesso identico nome per la stessa selezione -- due
// implementazioni indipendenti potrebbero divergere silenziosamente.
export function layerDisplayName(n: NodeLite): string {
  return n.name.trim() !== "" ? n.name : fallbackName(n);
}

// Stesso insieme di id, in un ordine qualunque -- confronta un Selection di
// react-aria-components (le chiavi che GridList ci ha appena dato) contro
// l'array piatto dello store.
function sameIds(keys: Exclude<Selection, "all">, ids: readonly string[]): boolean {
  if (keys.size !== ids.length) return false;
  for (const id of ids) if (!keys.has(id)) return false;
  return true;
}

/**
 * La order key da dare alla riga `from` per portarla in posizione `to`.
 *
 * `layers` è la lista COM'È MOSTRATA -- primo piano in cima, quindi order key
 * DECRESCENTE (vedi selectors.ts::layersInDrawOrder). Il riordino è quello di
 * una lista qualunque: si toglie la riga dalla posizione di partenza e la si
 * infila in quella d'arrivo; la chiave nuova è poi una qualunque strettamente
 * compresa fra i due VICINI che la riga si ritrova lì -- e l'indice frazionario
 * (store/orderKey.ts) ne trova sempre una, anche fra due chiavi consecutive,
 * anche mille volte nello stesso punto.
 *
 * NESSUN'ALTRA riga viene toccata: un solo op per un riordino, invece di
 * rinumerare l'intera lista. È tutto il motivo per cui le order key sono un
 * indice frazionario e non degli interi.
 *
 * Gli estremi sono APERTI: in cima non c'è vicino sopra (`null` = "sopra a
 * tutte"), in fondo non c'è vicino sotto.
 *
 * null quando non c'è niente da fare (la riga non si muove, indici fuori
 * lista) o quando la chiave non esiste -- due vicini con la STESSA order key
 * non lasciano spazio in mezzo. In quel caso orderKeyBetween lancerebbe, e
 * lanciare dentro il gestore di un pointerup vorrebbe dire rompere l'app a
 * metà trascinamento: meglio un riordino che non avviene.
 */
export function reorderKey(layers: readonly NodeLite[], from: number, to: number): string | null {
  if (from === to) return null;
  if (from < 0 || from >= layers.length || to < 0 || to >= layers.length) return null;

  const moved = [...layers];
  moved.splice(to, 0, ...moved.splice(from, 1));
  // Sopra = order key PIÙ ALTA (la lista è decrescente), sotto = più bassa.
  const above = moved[to - 1]?.orderKey ?? null;
  const below = moved[to + 1]?.orderKey ?? null;
  if (above !== null && below !== null && below >= above) return null;
  return orderKeyBetween(below, above);
}

// Etichetta del campo di rinomina. Costante e non "Rinomina {nome}": ne esiste
// UNO alla volta (renamingId è un id solo), e un'etichetta che cambia con il
// contenuto del campo non è un nome stabile per chi usa uno screen reader.
const RENAME_LABEL = "Nome del livello";

// CAMPO DI RINOMINA INLINE (Task 8, step 1). Un componente a parte, e non un
// <input> inline dentro la riga, per una ragione precisa: la sessione di
// modifica ha uno STATO SUO (il testo digitato finora, e il fatto di essere già
// stata chiusa) che deve nascere e morire con il campo. Montandolo/smontandolo
// quando `renamingId` cambia, quello stato non può sopravvivere alla riga
// sbagliata.
function RenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  // Una sessione si chiude UNA volta sola: Enter/Escape chiudono, e il blur che
  // arriva subito dopo (il campo sta per essere smontato) non deve confermare
  // una seconda volta -- men che meno dopo un annullamento. Stessa guardia di
  // ui/TextEditorOverlay.tsx::done, per lo stesso motivo.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Tutto selezionato: scrivere SOSTITUISCE il nome, che è quello che ci si
    // aspetta da una rinomina (e resta possibile posizionare il cursore).
    el.select();
  }, []);

  function settle(commit: boolean) {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      aria-label={RENAME_LABEL}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      // Uscire dal campo (click altrove, Tab) conferma: è la rete di sicurezza
      // dei casi che nessuno gestisce -- perdere il fuoco non deve poter far
      // perdere quello che l'utente ha scritto.
      onBlur={() => settle(true)}
      // Un click DENTRO il campo (per posizionare il cursore) non deve
      // diventare un click sulla riga: senza, GridList cambierebbe la selezione
      // sotto le dita di chi sta rinominando. Servono ENTRAMBI gli eventi:
      // react-aria apre la pressione sul pointerdown, ma per i click
      // "virtuali" -- quelli di uno screen reader, e quelli che user-event
      // sintetizza nei test, riconosciuti da pressure/width/height (vedi il
      // commento di press() in LayersPanel.test.tsx) -- passa dal solo click.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // NIENTE tasto esce da questo campo. Le scorciatoie globali dell'app
        // ascoltano sulla FINESTRA (undo/redo in ui/App.tsx, Escape/Canc in
        // tools/toolManager.ts) e GridList ha le sue sulla lista (frecce,
        // typeahead): senza questo stop, Canc cancellerebbe il nodo che si sta
        // rinominando e scrivere "Beta" sposterebbe la selezione sulla riga che
        // comincia per B. Le due guardie isTextField esistenti coprono solo il
        // canale della finestra, non quello di GridList -- che è React e
        // arriverebbe comunque.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          settle(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      // select-text: la lista intorno è select-none (perché trascinare una
      // maniglia non deve evidenziare i nomi delle righe che si attraversano),
      // ma DENTRO un campo di testo la selezione serve.
      // Stesso campo del resto dell'app (cls.input), ma 24px: dentro una riga da
      // 28 lascia il respiro sopra e sotto. Il bordo è già acceso: si sta scrivendo.
      className={`${cls.input} h-6! flex-1 select-text border-accent bg-surface focus-visible:shadow-none!`}
    />
  );
}

// L'icona della riga dice di che COSA si tratta a colpo d'occhio. Sono le stesse
// icone degli strumenti: frame -> frame, gruppo -> layers, vettore -> penna,
// istanza di componente -> components. `unknown` (un tipo che questo client non
// conosce) ripiega sul rettangolo, come fallbackName ripiega su "Shape".
function kindIcon(kind: NodeLite["kind"]): IconName {
  switch (kind) {
    case "frame": return "frame";
    case "group": return "layers";
    case "ellipse": return "ellipse";
    case "text": return "text";
    case "image": return "image";
    case "vector": return "pen";
    case "instance": return "components";
    default: return "rect";
  }
}

// Passo di rientro per livello di profondità, e padding sinistro della riga di
// radice. Le guide di rientro stanno al centro del chevron del livello padre.
const INDENT = 14;
const BASE_PAD = 8;

// Quante righe servono perché il pannello si virtualizzi, e l'altezza di ognuna
// quando succede (py-1 + riga di testo ≈ 28 px, la stessa di prima).
export const VIRTUALIZE_AFTER_ROWS = 300;
const ROW_HEIGHT = 28;

// Oltre questo numero di nodi in un documento i container partono CHIUSI: elencare
// ogni nodo di un file con decine di migliaia di elementi non aiuta a orientarsi
// (e costa una collezione da decine di migliaia di righe). Si aprono a mano o, da
// soli, quando si seleziona un nodo che sta dentro.
export const AUTO_COLLAPSE_NODES = 2000;

export function LayersPanel() {
  // Il pannello si ridisegna per la STRUTTURA dell'albero (chi sta dove, i nomi,
  // la visibilità), non per ogni scena nuova: un trascinamento ne produce una a
  // ogni passo, e senza questo ogni passo rifaceva 20.000 righe di react-aria.
  // La scena la si LEGGE (senza abbonarsi) dove serve.
  const structure = useScene((s) => (s.scene ? sceneIndexOf(s.scene).structure : null));
  const scene = useScene.getState().scene;
  const selection = useScene((s) => s.selection);
  // La pagina VISUALIZZATA: l'albero ne mostra solo le radici e i loro
  // sottoalberi. Stato di vista dello store, lo stesso che legge il renderer.
  const currentPageId = useScene((s) => s.currentPageId);
  // Il nodo la cui riga sta mostrando il campo di rinomina, o null. Uno solo
  // alla volta, per costruzione.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // I container COLLASSATI (default: tutti espansi). Un Set di soli id
  // collassati, così un container appena creato nasce aperto senza doverlo
  // elencare. Stato di VISTA locale: non è un op e non è una voce di undo.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // Nei documenti grandi i container partono chiusi (AUTO_COLLAPSE_NODES): lo
  // stato è l'inverso -- `expanded` elenca quelli che l'utente ha aperto. Si
  // decide UNA volta per (documento, pagina) e resta, anche se poi i nodi
  // crescono o calano attorno alla soglia.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const autoDecided = useRef(new Map<string, boolean>());
  const autoKey = scene && currentPageId ? `${scene.id}:${currentPageId}` : null;
  if (autoKey !== null && scene && !autoDecided.current.has(autoKey)) {
    autoDecided.current.set(autoKey, scene.nodes.size > AUTO_COLLAPSE_NODES);
  }
  const autoCollapse = autoKey !== null && autoDecided.current.get(autoKey) === true;
  const isCollapsed = useCallback(
    (id: string) => collapsed.has(id) || (autoCollapse && !expanded.has(id)),
    [collapsed, expanded, autoCollapse],
  );
  // Il trascinamento in corso: quale riga si sta spostando e su quale si trova
  // adesso il puntatore (`over` parte dalla riga stessa, cioè "non si è ancora
  // mosso"). null = nessun trascinamento in corso.
  const [drag, setDrag] = useState<{ from: string; over: string } | null>(null);

  // Le righe visibili dell'albero. Identità STABILE finché scena, pagina o
  // espansione non cambiano (una selezione da sola non le tocca):
  // react-aria-components ricostruisce la propria collezione interna -- ancora
  // di selezione compresa, quella su cui si basa un range shift-click -- quando
  // l'identità di `items` cambia. Un nuovo array ad OGNI render la romperebbe
  // anche quando l'albero non è cambiato per niente, e un semplice click
  // successivo si comporterebbe da "aggiungi" invece che da "sostituisci".
  //
  // Dipende dal TOKEN di struttura dell'indice di scena, non dalla scena: un
  // trascinamento produce una scena nuova a ogni passo, ma non cambia chi sta
  // dove né i nomi, e rifare 20.000 righe a ogni passo bloccherebbe la pagina.
  const index = scene ? sceneIndexOf(scene) : null;
  // Una lista lunga si VIRTUALIZZA: si montano solo le righe visibili (e poche
  // attorno), non una per nodo. Sopra la soglia, perché il virtualizzatore decide
  // cosa mostrare dalla misura del contenitore e sotto jsdom -- dove ogni misura
  // è zero -- una lista corta sparirebbe. Le righe virtualizzate hanno altezza
  // fissa (ROW_HEIGHT): è ciò che gli permette di non misurarle una per una.
  const rows = useMemo(
    () => (scene && index && currentPageId ? visibleRows(scene, currentPageId, isCollapsed, index.children) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `structure` sostituisce scene/index
    [structure, currentPageId, isCollapsed],
  );

  const virtualized = rows.length > VIRTUALIZE_AFTER_ROWS;

  // Il sottoalbero della riga trascinata (radice compresa): i suoi id sono i
  // bersagli di drop NON validi -- calarci dentro sarebbe un ciclo. Precalcolato
  // una volta per drag invece che a ogni riga.
  const dragSubtree = useMemo(
    () => (drag && scene ? new Set(subtreeOf(scene, drag.from).map((n) => n.id)) : null),
    [drag, scene],
  );

  // L'ULTIMA Selection che GridList stesso ci ha consegnato via
  // onSelectionChange -- con l'ANCORA di uno shift-click (quale riga apre
  // l'intervallo), che store.selection non può portare: è un array piatto,
  // scritto anche da selectTool sul canvas, che di ancore non sa nulla.
  //
  // Se il prossimo render arriva con la STESSA selezione che abbiamo appena
  // emesso noi (l'utente ha cliccato una riga), la riusiamo COSÌ COM'ERA,
  // ancora compresa: ricostruire un Set nuovo da `selection` ad ogni giro
  // (identico nel contenuto, ma un oggetto NUOVO) è indistinguibile per
  // GridList da "la selezione è stata sostituita da fuori", e perderebbe
  // l'ancora dopo OGNI click -- uno shift-click dopo l'altro selezionerebbe
  // sempre e solo due righe, mai l'intervallo. Se invece la selezione arriva
  // da FUORI (il canvas, via store.setSelection), non coincide con quella
  // emessa e ricostruiamo un Set piatto: un'ancora persa in quel caso È
  // l'esito giusto, non un bug -- un nuovo punto di partenza per il prossimo
  // shift-click nel pannello.
  const lastEmitted = useRef<Selection | null>(null);
  const selectedKeys: Selection = useMemo(() => {
    const cached = lastEmitted.current;
    if (cached && cached !== "all" && sameIds(cached, selection)) return cached;
    return new Set(selection);
  }, [selection]);

  // GridList è CONTROLLATO da selection (sopra) e scrive qui: un click
  // rimpiazza la selezione (selectionBehavior="replace"), ctrl/cmd-click la
  // estende un nodo alla volta, shift-click la estende per intervallo -- la
  // stessa semantica desktop di selectTool sul canvas, gratis da
  // react-aria-components.
  function onSelectionChange(keys: Selection) {
    lastEmitted.current = keys;
    const ids = keys === "all" ? rows.map((r) => r.id) : [...keys].map(String);
    useScene.getState().setSelection(ids);
  }

  // Un op, un gesto: anche il singolo toggle passa da beginGesture/endGesture
  // (i pannelli obbediscono alla stessa regola di un tool, vedi il brief
  // M1b), così la visibilità resta annullabile con Ctrl+Z e viaggia sul filo
  // come qualunque altra modifica.
  function toggleVisible(n: NodeLite) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(n.id, { visible: !n.visible }, ["visible"])]);
  }

  // Un solo gesto per l'INTERA selezione, non un gesto per nodo: undoStack
  // guadagna UNA voce anche cancellando dieci livelli in un colpo solo --
  // stesso schema di selectTool.ts::onKeyDown per Delete/Backspace sul
  // canvas, qui applicato al pulsante del pannello.
  // Chiude la rinomina scrivendo il nuovo nome. Come il toggle di visibilità è
  // un gesto intero (una voce di undo, un op sul filo).
  //
  // Due casi non producono NIENTE: il nome invariato e -- per lo stesso motivo
  // -- il nome che differisce solo per spazi ai bordi, che vengono tolti. Un op
  // "che non cambia niente" costerebbe comunque un giro di rete e un Ctrl+Z.
  function commitRename(n: NodeLite, raw: string) {
    setRenamingId(null);
    const name = raw.trim();
    if (name === n.name) return;
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(n.id, { name }, ["name"])]);
  }

  // Apre/chiude un container. Stato di VISTA locale: nessun op, nessuna voce di
  // undo (come spostare la camera).
  function toggleCollapse(id: string) {
    const flip = (prev: ReadonlySet<string>) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    };
    // Con i container chiusi di default, "aprire" vuol dire aggiungere a
    // `expanded`; altrimenti vuol dire togliere da `collapsed`.
    if (autoCollapse) setExpanded(flip);
    else setCollapsed(flip);
  }

  // Selezionare un nodo (dal canvas, o con la tastiera) deve MOSTRARLO: si
  // aprono gli antenati chiusi. Parte solo quando cambia la selezione, così
  // chiudere a mano un container con dentro la selezione non viene riaperto.
  useEffect(() => {
    const cur = useScene.getState().scene;
    if (!cur || selection.length === 0) return;
    const toOpen = new Set<string>();
    for (const id of selection.slice(0, 20)) {
      for (const anc of ancestorsOf(cur, id)) if (isCollapsed(anc.id)) toOpen.add(anc.id);
    }
    if (toOpen.size === 0) return;
    if (autoCollapse) setExpanded((prev) => new Set([...prev, ...toOpen]));
    else setCollapsed((prev) => new Set([...prev].filter((id) => !toOpen.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cambio di selezione
  }, [selection]);

  // Riordino da TASTIERA (Alt+frecce sulla maniglia): sposta il nodo di un posto
  // FRA I SUOI FRATELLI. Stesso op e stesso gesto del drag di solo-riordino
  // (SetProperties order_key): un solo op, i vicini non si toccano. `dir` è -1
  // verso il primo piano (su), +1 verso lo sfondo (giù). Fuori dalla lista dei
  // fratelli non fa niente (reorderKey ritorna null).
  function reorderSibling(id: string, dir: -1 | 1) {
    const cur = useScene.getState().scene;
    if (!cur) return;
    const n = cur.nodes.at(id);
    if (!n) return;
    const displayed = [...childrenOf(cur, n.parentId)].reverse();
    const i = displayed.findIndex((s) => s.id === id);
    const key = reorderKey(displayed, i, i + dir);
    if (key === null) return;
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(id, { orderKey: key }, ["order_key"])]);
  }

  // Esegue il drop di `fromId` sulla riga `overId`. Un drop = UN gesto = UN op =
  // UNA voce di undo: riordino (SetProperties order_key) se resta fra i fratelli,
  // ReparentNode se cambia container. Il piano è calcolato sulla scena FRESCA
  // dello store (non su una closure che potrebbe essere invecchiata).
  function performDrop(fromId: string, overId: string) {
    const cur = useScene.getState().scene;
    if (!cur) return;
    const plan = dropPlanFor(cur, fromId, overId);
    if (!plan) return;
    const store = useScene.getState();
    store.beginGesture();
    if (plan.kind === "reorder") {
      store.endGesture([makeSetPropsOp(fromId, { orderKey: plan.key }, ["order_key"])]);
      return;
    }
    // Riparentazione: il container di destinazione va ESPANSO, così il nodo
    // appena calato dentro è subito visibile invece di sparire in un ramo
    // collassato. (Se il parent è una pagina, non è mai in `collapsed`: no-op.)
    setCollapsed((prev) => {
      if (!prev.has(plan.parentId)) return prev;
      const next = new Set(prev);
      next.delete(plan.parentId);
      return next;
    });
    store.endGesture([makeReparentOp(fromId, plan.parentId, plan.key)]);
  }

  // Il rilascio arriva sulla FINESTRA e non sulla riga: il puntatore può
  // benissimo essere lasciato andare fuori dalla lista (o fuori dalla finestra),
  // e un trascinamento che resta "attaccato" perché il pointerup è andato altrove
  // è il difetto classico di un drag fatto a mano. Registrato solo mentre un
  // trascinamento è in corso.
  useEffect(() => {
    if (!drag) return;
    const { from, over } = drag;
    const drop = () => {
      setDrag(null);
      performDrop(from, over);
    };
    // Il browser ha annullato il gesto (gesture di sistema, capture perso):
    // si abbandona senza riordinare, come fa onPointerCancel dei tool
    // (tools/toolManager.ts).
    const abort = () => setDrag(null);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", abort);
    return () => {
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", abort);
    };
    // performDrop legge la scena fresca dallo store: la closure non dipende da
    // `rows`, quindi basta rieseguire l'effetto quando cambia il drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  function deleteSelected() {
    const store = useScene.getState();
    const scene = store.scene;
    if (!scene) return;
    // Solo i nodi PIÙ IN ALTO della selezione: deleteNode cascata, quindi un
    // figlio selezionato insieme al suo gruppo produrrebbe un op rifiutato dal
    // server e lascerebbe l'intero gesto senza voce di undo (vedi topmostOf).
    const ids = topmostOf(scene, store.selection);
    if (ids.length === 0) return;
    store.beginGesture();
    store.endGesture(ids.map((id) => makeDeleteOp(id)));
  }

  const list = (
    <GridList
      aria-label="Livelli"
      items={rows}
      // La CACHE degli item di react-aria-components. Con una collezione
      // dinamica (`items` + render function) RAC ricostruisce le righe solo
      // quando cambia `items` -- non a ogni render del pannello: `renamingId`
      // e `drag` vivono nello STATO di questo componente, e senza dichiararli
      // qui il doppio click / l'evidenziazione del drop aggiornerebbero lo
      // stato senza che la riga cambi mai. (`collapsed` cambia già l'identità
      // di `rows`, quindi non serve elencarlo.)
      dependencies={[renamingId, drag]}
      selectionMode="multiple"
      selectionBehavior="replace"
      selectedKeys={selectedKeys}
      onSelectionChange={onSelectionChange}
      renderEmptyState={() => (
        <EmptyState
          icon="layers"
          title="Nessun livello"
          hint="Disegna una forma con gli strumenti in basso: comparirà qui."
        />
      )}
      className="min-h-0 flex-1 select-none overflow-auto px-1 pb-2 outline-none"
    >
      {(row) => {
        const n = row.node;
        const label = layerDisplayName(n);
        const dragging = drag?.from === n.id;
        // Bersaglio NON valido durante un drag: la riga trascinata cala nel
        // proprio sottoalbero (ciclo). Non si offre -- il core lo rifiuterebbe
        // (ErrCycle) e il pannello non deve nemmeno far finta che si possa.
        const invalidTarget = !!drag && !dragging && !!dragSubtree?.has(n.id);
        // Come il drop atterrerebbe QUI: "into" = dentro questo container,
        // "beside" = riordino/riparentazione accanto. Deciso dallo stesso
        // dropPlanFor che esegue il drop, così l'anteprima non può mentire su
        // cosa succederà.
        let dropMode: "into" | "beside" | null = null;
        if (drag && drag.over === n.id && !dragging && !invalidTarget && scene) {
          const plan = dropPlanFor(scene, drag.from, n.id);
          if (plan) dropMode = plan.kind === "reparent" && plan.parentId === n.id ? "into" : "beside";
        }
        return (
          <GridListItem
            id={n.id}
            textValue={label}
            data-depth={row.depth}
            data-drop-invalid={invalidTarget ? "true" : undefined}
            // Indentazione per profondità: lo stesso spazio che il renderer
            // esprime scendendo l'albero, qui reso come rientro a sinistra.
            style={{ paddingLeft: BASE_PAD + row.depth * INDENT }}
            // Il bersaglio del rilascio si decide dalla riga SOTTO IL
            // PUNTATORE, non da un calcolo su coordinate e altezze: il
            // pointermove arriva già sulla riga giusta, che è l'unica
            // informazione che serve. (Nessun setPointerCapture, per questo:
            // catturando, i move tornerebbero tutti alla maniglia.)
            onPointerMove={() => {
              if (drag && drag.over !== n.id) setDrag({ from: drag.from, over: n.id });
            }}
            className={[
              // h-7 = ROW_HEIGHT (28): la stessa altezza fissa che permette al
              // virtualizzatore di non misurare le righe. `relative` ancora le
              // guide di rientro, la maniglia e l'indicatore di drop.
              "group relative flex h-7 items-center gap-1.5 rounded-md pr-1.5 text-[13px] text-fg outline-none",
              "hover:bg-surface-3 data-[selected]:bg-accent-soft data-[selected]:hover:bg-accent-soft",
              "data-[focus-visible]:shadow-[inset_0_0_0_1.5px_var(--accent)]",
              dragging ? "opacity-50" : "",
              invalidTarget ? "cursor-no-drop opacity-40" : "",
              // Drop DENTRO un container: la riga si illumina tutta, in accento.
              dropMode === "into" ? "bg-accent-soft! shadow-[inset_0_0_0_1.5px_var(--accent)]" : "",
            ].join(" ")}
          >
            {/* INDICATORE DI DROP "accanto": una linea d'accento da 2px sul bordo
                superiore (assoluta, così non cambia l'altezza della riga -- che
                per la virtualizzazione è fissa) con un pallino a sinistra. */}
            {dropMode === "beside" && (
              <span aria-hidden className="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 rounded-full bg-accent">
                <span className="absolute -left-0.5 -top-[3px] h-2 w-2 rounded-full border-2 border-accent bg-surface" />
              </span>
            )}
            {/* GUIDE DI RIENTRO: una linea verticale per ogni antenato, al centro
                del suo chevron. Decorative (aria-hidden) e non intercettano
                eventi. */}
            {Array.from({ length: row.depth }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-line"
                style={{ left: BASE_PAD + i * INDENT + 8 }}
              />
            ))}
            {/* DISCLOSURE: espande/collassa un container con figli. Per le
                righe che non ne hanno uno spaziatore della stessa larghezza,
                così nomi e maniglie restano allineati fra i livelli. Un
                <button> vero (aria-expanded), raggiungibile da tastiera. */}
            {row.container && row.hasChildren ? (
              <button
                type="button"
                aria-label={row.expanded ? `Comprimi ${label}` : `Espandi ${label}`}
                aria-expanded={row.expanded}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapse(n.id);
                }}
                className="relative z-[1] flex h-5 w-4 shrink-0 items-center justify-center rounded text-fg-subtle outline-none hover:bg-surface-3 hover:text-fg focus-visible:text-accent"
              >
                <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={12} />
              </button>
            ) : (
              <span aria-hidden className="w-4 shrink-0" />
            )}
            {/* MANIGLIA di trascinamento. Il drag parte da qui e non da tutta
                la riga: un pointerdown sulla riga è già "seleziona questa riga"
                (e con shift/ctrl, "estendi la selezione"), e farlo valere anche
                come inizio di un drag vorrebbe dire decidere a posteriori --
                con una soglia in pixel -- quale delle due cose l'utente
                intendeva. Un <button> vero, non un <div> decorativo: è
                raggiungibile da tastiera e Alt+frecce lo spostano fra i
                fratelli, altrimenti il riordino sarebbe l'unica funzione del
                pannello impossibile senza mouse. */}
            <button
              type="button"
              aria-label={`Riordina ${label}`}
              title="Trascina per riordinare o riparentare (Alt+↑ / Alt+↓)"
              // Come per il campo di rinomina: pointerdown per il percorso
              // normale, click per quello "virtuale" (screen reader), così la
              // presa della maniglia non diventa anche un click sulla riga.
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag({ from: n.id, over: n.id });
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // ALT + freccia, non la freccia da sola, e non è una
                // preferenza: react-aria RISERVA ArrowUp/ArrowDown alla
                // navigazione fra le righe e le intercetta in fase di
                // CAPTURE prima che arrivino ai figli della riga
                // (useGridListItem.mjs: "Prevent this event from reaching row
                // children"), rilanciandole dal genitore. L'unica combinazione
                // che lascia passare è con altKey -- ed è la stessa che
                // react-aria usa per il proprio riordino da tastiera
                // (useDraggableItem.mjs). Una freccia liscia qui non
                // arriverebbe mai: sarebbe codice morto.
                if (!e.altKey) return;
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                e.stopPropagation();
                reorderSibling(n.id, e.key === "ArrowUp" ? -1 : 1);
              }}
              // touch-none: su schermo tattile il trascinamento della maniglia
              // non deve diventare uno scroll del pannello.
              // Assoluta sul bordo sinistro e visibile solo al passaggio (o al
              // focus da tastiera): una maniglia in ogni riga, sempre accesa, è
              // rumore. Resta un <button> vero, quindi raggiungibile con Tab.
              className="absolute left-0 top-1/2 z-[2] flex h-5 w-2.5 -translate-y-1/2 cursor-grab touch-none items-center justify-center text-fg-subtle opacity-0 outline-none hover:text-fg focus-visible:text-accent focus-visible:opacity-100 group-hover:opacity-100"
            >
              <svg aria-hidden viewBox="0 0 6 10" width="6" height="10" fill="currentColor">
                <circle cx="1.5" cy="2" r="0.9" /><circle cx="4.5" cy="2" r="0.9" />
                <circle cx="1.5" cy="5" r="0.9" /><circle cx="4.5" cy="5" r="0.9" />
                <circle cx="1.5" cy="8" r="0.9" /><circle cx="4.5" cy="8" r="0.9" />
              </svg>
            </button>
            {/* ICONA DEL TIPO: tenue; le istanze di componente in accento (come
                nel pannello Componenti). Un nodo nascosto si attenua tutto. */}
            <Icon
              name={kindIcon(n.kind)}
              size={14}
              className={`shrink-0 ${n.kind === "instance" ? "text-accent" : "text-fg-subtle"} ${n.visible ? "" : "opacity-50"}`}
            />
            {renamingId === n.id ? (
              <RenameField
                // Seminato con il nome VERO, non con quello mostrato: per un
                // nodo senza nome il campo parte vuoto e il fallback resta il
                // placeholder. Confermare senza scrivere niente non deve
                // persistere "Rectangle" come nome esplicito -- sarebbe una
                // modifica che l'utente non ha chiesto, per giunta annullabile.
                initial={n.name}
                placeholder={label}
                onCommit={(value) => commitRename(n, value)}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <span
                className={`min-w-0 flex-1 truncate ${n.visible ? "" : "text-fg-subtle"}`}
                onDoubleClick={() => setRenamingId(n.id)}
              >
                {label}
              </span>
            )}
            {/* stopPropagation: un click qui è "nascondi/mostra QUESTA
                riga", non "seleziona questa riga" -- senza, il pointerdown
                del Button raggiungerebbe comunque la riga sottostante e la
                selezione cambierebbe insieme alla visibilità. */}
            <Button
              aria-label={n.visible ? `Nascondi ${label}` : `Mostra ${label}`}
              onPress={() => toggleVisible(n)}
              onPointerDown={(e) => e.stopPropagation()}
              // Visibile: l'occhio compare solo al passaggio (o al focus). Nascosto:
              // resta SEMPRE, attenuato -- è l'unico indizio che il livello c'è
              // ma non si vede, e il modo per riaccenderlo.
              className={
                "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted outline-none hover:bg-surface-3 hover:text-fg " +
                "data-[focus-visible]:shadow-[var(--ring)] " +
                (n.visible ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "text-fg-subtle opacity-70")
              }
            >
              <Icon name={n.visible ? "eye" : "eyeOff"} size={14} />
            </Button>
          </GridListItem>
        );
      }}
    </GridList>
  );

  return (
    <div className="flex h-full flex-col text-[13px] text-fg">
      {/* L'intestazione compare SOLO con una selezione: il titolo è già nella
          scheda, e a riposo quei 36px sono spazio per i livelli. */}
      {selection.length > 0 && (
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <h3 className={cls.sectionTitle}>{selection.length === 1 ? "1 selezionato" : `${selection.length} selezionati`}</h3>
        <div className="ml-auto flex items-center">
          <IconButton
            icon="trash"
            label="Elimina i livelli selezionati"
            size={24}
            isDisabled={selection.length === 0}
            onPress={deleteSelected}
          />
        </div>
      </div>
      )}
      {virtualized ? (
        <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: ROW_HEIGHT }}>
          {list}
        </Virtualizer>
      ) : (
        list
      )}
    </div>
  );
}
