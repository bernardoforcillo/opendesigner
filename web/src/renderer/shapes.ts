import type { NodeLite, SubPathLite } from "../store/types";
import { boundsOfNode, inflateBounds, strokeOutsetOfNode } from "../canvas/geometry";
import { centerOf, worldToLocal, type Point } from "../canvas/transform";
import {
  anchorPoint, inHandlePoint, outHandlePoint, subpathFills, hitVectorGeometry,
  hasAnyAnchor,
} from "../store/vectorGeometry";
import { lineHeightOf } from "./text";

// Il centro attorno a cui il nodo RUOTA: il centro del suo box NON ruotato.
// Una funzione sola, usata dal renderer (che ci applica ctx.rotate) e
// dall'hit-test (che ci applica la rotazione inversa): la convenzione di
// canvas/transform.ts vale solo se i due la leggono dallo stesso posto.
export function nodeCenter(n: NodeLite): Point {
  return centerOf(boundsOfNode(n));
}

// Costruisce il Path2D del nodo in coordinate mondo (nessuna trasformazione
// camera qui: la camera è applicata dal chiamante via ctx.setTransform).
//
// Il path è quello NON ruotato: la rotazione è una trasformazione del contesto
// (drawScene la applica attorno a nodeCenter), non una geometria diversa --
// così il path resta lo stesso oggetto per qualunque angolo e l'hit-test può
// specchiarla portando il punto nello spazio locale.
//
// Il vettoriale NON passa di qui: la sua geometria si divide in due path
// (vedi vectorPaths qui sotto) e drawScene lo dirotta prima, come già fa con il
// testo. Il ripiego sul rettangolo qui in fondo vale per le forme il cui
// inchiostro è il box -- incluse quelle "unknown" delle altre tracce, che
// questo lato può solo trattare da rettangolo.
export function nodePath(n: NodeLite): Path2D {
  const path = new Path2D();
  if (n.kind === "ellipse") {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2;
    const ry = n.height / 2;
    path.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  // Il corner radius è del RETTANGOLO: un FRAME è rettangolare per definizione
  // (è l'artboard) e si disegna a spigoli vivi anche se porta con sé un
  // cornerRadius -- scritto da chi non lo sa, o da un documento di un'altra
  // versione. La condizione sul kind lo tiene esplicito invece di affidarlo al
  // fatto che un frame di solito ha cornerRadius 0.
  } else if (n.kind === "rect" && n.cornerRadius > 0) {
    path.roundRect(n.x, n.y, n.width, n.height, n.cornerRadius);
  } else {
    path.rect(n.x, n.y, n.width, n.height);
  }
  return path;
}

// "Questo nodo lascia dei pixel?" -- indipendentemente da `visible`, che è una
// scelta dell'utente, mentre questa è una proprietà della GEOMETRIA. Una forma
// degenere (larghezza o altezza <= 0) non ha niente da riempire.
//
// Il guard NON vale per il testo: l'altezza di un nodo testo la produce il
// layout (e la width è solo la larghezza di wrap), quindi un testo appena
// creato può avere height 0 pur essendo disegnato.
//
// Vive qui, in una funzione sola, perché la stessa regola serve in tre punti
// che devono restare d'accordo: chi disegna (drawScene), chi colpisce
// (hitTestNode) e chi calcola la regione da esportare (export/region.ts). Una
// terza copia del predicato sarebbe la solita coppia destinata a divergere --
// e una divergenza qui si vede come "l'export ha ritagliato l'immagine attorno
// a un nodo invisibile".
export function isPaintable(n: NodeLite): boolean {
  return n.kind === "text" || (n.width > 0 && n.height > 0);
}

// Vero quando l'INCHIOSTRO del nodo è il suo box, cioè quando un box degenere
// significa davvero "niente da disegnare e niente da colpire". Vale per rect ed
// ellipse (e per una forma sconosciuta, che questo lato può solo trattare da
// rettangolo), NON per testo e vettoriale:
//   - il testo ha l'altezza prodotta dal layout, quindi un nodo appena creato ha
//     height 0 ed è comunque disegnato;
//   - il vettoriale ha l'inchiostro negli ancoraggi, e per l'invariante del
//     proto il box è la bbox ESATTA della geometria -- quindi un path di un solo
//     punto (il pen tool dopo il primo click) o un segmento orizzontale hanno
//     legittimamente un lato a zero. Scartarli qui li renderebbe invisibili E
//     non cliccabili: raggiungibili solo dal pannello livelli, cancellabili solo
//     da lì.
// Esportata perché drawScene (canvasRenderer.ts) deve fare la STESSA scelta: due
// elenchi di eccezioni divergerebbero al primo tipo aggiunto.
export function inkIsBox(n: NodeLite): boolean {
  return n.kind !== "text" && n.kind !== "vector";
}

// Vero quando il nodo dipinge qualcosa, cioè quando esiste un bersaglio da
// selezionare. Serve al MARQUEE (tools/selectTool.ts::nodesInMarquee), che
// lavora su bounds e da solo non se ne accorgerebbe: un vettoriale senza
// nessun ancoraggio conserva comunque il width/height che aveva, quindi un
// rettangolo di selezione lo prenderebbe pur essendo l'unico stato in cui il
// nodo non produce nessun Path2D (vectorPaths) e nessun hit (hitTestNode).
// Selezionare col marquee qualcosa che non si vede e non si può cliccare è
// esattamente la sorpresa da evitare.
//
// Discrimina il solo VETTORIALE di proposito: per le forme il cui inchiostro È
// il box il caso analogo è il box degenere, che è comportamento di M1 condiviso
// con le altre tracce e non si cambia da qui.
export function hasInk(n: NodeLite): boolean {
  if (n.kind !== "vector") return true;
  return hasAnyAnchor(n.vector?.subpaths ?? []);
}

// --- il path vettoriale ------------------------------------------------------

// Distanza di presa da un contorno APERTO, in px SCHERMO: una linea sottile
// deve essere altrettanto facile da afferrare a ogni zoom, quindi la tolleranza
// vive in px e si divide per lo zoom al momento dell'uso.
//
// 5 px sta nella stessa famiglia delle altre soglie di puntamento del progetto
// -- il quadratino di una maniglia di resize si afferra entro 6 px dal centro
// (HANDLE_SIZE/2 + HANDLE_GRAB_PADDING, selection/handles.ts) e un marquee
// diventa un click sotto i 3 px -- ed è la misura che serve: abbastanza
// generosa da prendere una linea da 1.5 px senza andare a caccia del pixel,
// abbastanza stretta che due tratti a 10 px l'uno dall'altro restino
// selezionabili separatamente.
export const VECTOR_HIT_PX = 5;

// Scarto massimo (px SCHERMO) fra la curva vera e la spezzata su cui si misura
// la distanza. Un quarto di pixel: sotto la soglia di ciò che si vede e di ciò
// che si riesce a puntare, e venti volte più fine della presa qui sopra --
// quindi l'appiattimento non può spostare in modo percepibile il confine fra
// "preso" e "mancato". Più fine di così si pagherebbero segmenti in più per una
// differenza che nessuno può osservare.
export const VECTOR_FLATTEN_PX = 0.25;

// Spessore (px SCHERMO) con cui si traccia OGNI contorno. Il modello non ha un
// paint di tratto: il colore è quello del riempimento del nodo, l'unica tinta
// che conosce, quindi su un contorno che riempie il tratto è invisibile (mezzo
// spessore in più di forma, dello stesso colore) e su uno che non riempie --
// aperto, o chiuso ma di area nulla -- è tutto ciò che esiste sullo schermo.
export const VECTOR_STROKE_PX = 1.5;

// La regola di riempimento, EVEN-ODD, e la ragione della scelta.
//
// Con nonzero un contorno interno è un buco solo se percorso nel VERSO OPPOSTO
// a quello esterno. Questo modello non ha nessun modo di controllare il verso:
// non esiste un op "inverti contorno", e il pen tool produce l'ordine in cui
// l'utente ha cliccato. Un buco che dipende da una proprietà invisibile e non
// modificabile è un buco che non si riesce a fare apposta -- e, peggio, che
// compare o sparisce a seconda di come si è girato attorno alla forma.
//
// Con even-odd decide la sola CONTENENZA: un contorno dentro un altro è sempre
// un buco, e per toglierlo basta spostarlo fuori. Prevedibile con gli strumenti
// che ci sono.
//
// Il valore è UNO e lo condividono ctx.fill (canvasRenderer) e l'hit-test
// (vectorGeometry::pointInRingsEvenOdd): due regole diverse darebbero un buco
// che si vede ma si clicca.
export const VECTOR_FILL_RULE: CanvasFillRule = "evenodd";

// I due path di un nodo vettoriale, in coordinate MONDO. `stroke` li contiene
// TUTTI (ogni contorno si traccia); `fill` solo quelli che riempiono. Sono due
// Path2D e non uno perché il canvas chiude implicitamente ogni contorno che
// riempie: un contorno aperto messo nel path del riempimento verrebbe riempito
// come se fosse chiuso, cioè esattamente ciò che non deve succedere. `null`
// (non un Path2D vuoto) quando non c'è niente in quel secchio, così il
// chiamante non paga una fill o una stroke a vuoto.
export interface VectorPaths { fill: Path2D | null; stroke: Path2D | null }

// Traccia UN contorno su `p`: moveTo sul primo ancoraggio, poi una
// bezierCurveTo per ogni segmento DISEGNATO. Le maniglie escono da
// vectorGeometry (la regola dei due spazi ha una sola implementazione) e non
// hanno bisogno di rami: una maniglia assente vale (0,0), il controllo cade
// sull'ancoraggio e la bezier è la retta.
function traceSubpath(p: Path2D, n: NodeLite, sp: SubPathLite): void {
  const count = sp.anchors.length;
  const first = anchorPoint(n, sp.anchors[0]);
  p.moveTo(first.x, first.y);
  if (count === 1) {
    // Un ancoraggio solo (il pen tool dopo il primo click): un segmento di
    // lunghezza nulla, che con lineCap tondo il canvas disegna come un
    // pallino. Un moveTo e basta non dipingerebbe niente, e il nodo appena
    // nato sarebbe invisibile finché non arriva il secondo click.
    p.lineTo(first.x, first.y);
    return;
  }
  // Chiuso: c'è anche il segmento di ritorno ultimo -> primo, ed è una curva
  // come le altre (le sue maniglie esistono), quindi si disegna. Il closePath
  // che segue non aggiunge lunghezza: chiude il contorno.
  const segments = sp.closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const a = sp.anchors[i];
    const b = sp.anchors[(i + 1) % count];
    const c1 = outHandlePoint(n, a);
    const c2 = inHandlePoint(n, b);
    const to = anchorPoint(n, b);
    p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
  }
  if (sp.closed) p.closePath();
}

export function vectorPaths(n: NodeLite): VectorPaths {
  let fill: Path2D | null = null;
  let stroke: Path2D | null = null;
  for (const sp of n.vector?.subpaths ?? []) {
    if (sp.anchors.length === 0) continue;
    // OGNI contorno si traccia, chiuso o aperto. Per un contorno aperto è
    // l'unico modo di esistere sullo schermo; per uno chiuso è ciò che gli
    // impedisce di sparire quando il riempimento non dipinge niente -- e
    // `closed` NON implica area: due ancoraggi chiusi percorrono A->B->A e tre
    // ancoraggi allineati una spezzata schiacciata, due stati che il pen tool
    // raggiunge con tre click. Senza tratto quel path diventerebbe invisibile e
    // non cliccabile nell'istante in cui l'utente lo chiude.
    stroke ??= new Path2D();
    traceSubpath(stroke, n, sp);
    // In PIÙ, un contorno chiuso con almeno due ancoraggi va nel riempimento. Il
    // predicato sta in vectorGeometry perché lo condivide con l'hit-test:
    // riempimento e area colpibile devono essere la stessa cosa.
    if (subpathFills(sp)) {
      fill ??= new Path2D();
      traceSubpath(fill, n, sp);
    }
  }
  return { fill, stroke };
}

// Lato minimo (unità MONDO) del box su cui il MARQUEE afferra un nodo
// vettoriale. È una TOLLERANZA DI SELEZIONE, non un fatto sulla geometria: il
// modello continua a dire il vero (vectorBounds è esatta, e un segmento
// orizzontale ha davvero height 0), ma un box di area zero non interseca nulla
// e sfuggirebbe a qualunque marquee che non lo scavalchi in senso stretto.
//
// Il CLICK non passa più di qui: da quando il path si disegna davvero,
// hitTestNode colpisce l'inchiostro (vicinanza al tratto, più il riempimento di
// un contorno chiuso) e ha la sua tolleranza in px schermo, VECTOR_HIT_PX.
// Questa resta in unità mondo perché nodesInMarquee (tools/selectTool.ts)
// lavora su bounds e non conosce la camera -- ed è la ragione per cui le due
// tolleranze sono, e devono restare, due numeri diversi.
export const VECTOR_MIN_GRAB = 4;

// Il box su cui il MARQUEE afferra un nodo, che non è sempre il box del
// modello. NON è (più) il bersaglio del click: da quando il path si disegna
// davvero, hitTestNode colpisce l'inchiostro -- riempimento even-odd e
// vicinanza al tratto -- e non passa di qui.
//
// Le due porte NON possono essere la stessa funzione: la presa del click è in
// px SCHERMO (VECTOR_HIT_PX) perché una linea deve afferrarsi allo stesso modo a
// ogni zoom, mentre il marquee confronta bounds in coordinate MONDO e non
// conosce la camera. Restano però d'accordo dove conta -- che è "un nodo che non
// si vede e non si clicca non deve nemmeno essere preso dal marquee": lo
// garantisce il filtro `hasInk` in tools/selectTool.ts::nodesInMarquee, non
// questo box. Qui sotto c'è solo la tolleranza per l'asse degenere, che è un
// caso in cui il nodo l'inchiostro ce l'ha eccome.
export function selectionBoundsOfNode(n: NodeLite): Box {
  if (n.kind !== "vector") return { x: n.x, y: n.y, width: n.width, height: n.height };
  // Solo l'asse DEGENERE si allarga, e centrato sull'inchiostro: un path normale
  // resta com'è (e non ruba click alle forme sotto), un segmento orizzontale
  // diventa afferrabile da sopra come da sotto.
  const dw = Math.max(0, VECTOR_MIN_GRAB - n.width);
  const dh = Math.max(0, VECTOR_MIN_GRAB - n.height);
  return { x: n.x - dw / 2, y: n.y - dh / 2, width: n.width + dw, height: n.height + dh };
}

// Hit-test geometrico puro (nessun ctx / DOM), così resta testabile in Node.
//
// (wx, wy) è il punto nello STESSO spazio delle coordinate del nodo, cioè
// quello del suo PARENT: per un nodo figlio di una pagina è il mondo, per un
// nodo annidato no. È chi chiama (renderer/canvasRenderer.ts::hitTest) a
// portarcelo scendendo l'albero -- qui dentro non c'è nessuna trasformazione,
// esattamente come nodePath disegna nello spazio corrente del ctx.
//
// rect: AABB inclusivo dei bordi. ellisse: equazione normalizzata
// ((wx-cx)/rx)^2 + ((wy-cy)/ry)^2 <= 1, che è il test corretto (l'AABB
// dell'ellisse include gli angoli, che sono fuori dall'ellisse stessa).
// Il punto arriva in coordinate MONDO e viene portato nello spazio LOCALE del
// nodo (rotazione inversa attorno a nodeCenter) PRIMA di testare la forma: è
// l'unico modo perché un'ellisse ruotata resti colpita da ellisse invece che
// dal suo rettangolo contenitore -- lo stesso errore che il test normalizzato
// qui sotto esiste per evitare, ma introdotto dalla rotazione.
//
// `zoom` serve al solo vettoriale, e serve davvero: la presa attorno a un
// contorno aperto è in px SCHERMO (VECTOR_HIT_PX), quindi va convertita in
// unità mondo, e questa è l'unica funzione che sa quale nodo la richiede.
// Parametro OBBLIGATORIO e non con un default a 1: un default renderebbe
// silenzioso il caso in cui un chiamante nuovo si dimentica della camera, e il
// sintomo (una linea che si afferra male solo fuori da zoom 1) è di quelli che
// nessuno collega alla causa.
export function hitTestNode(n: NodeLite, wx: number, wy: number, zoom: number): boolean {
  // Un GRUPPO non si colpisce mai direttamente: non ha geometria propria (i
  // suoi bounds sono l'unione dei figli, vedi store/groups.ts) e non disegna
  // niente, quindi non c'è nessun pixel suo sotto il puntatore. A selezionarlo
  // ci pensa la POLITICA di selezione, che risale l'albero dal figlio colpito
  // (groups.ts::selectionTargetOf) -- e deve poterlo fare da un figlio, non da
  // un rettangolo invisibile che ruberebbe i click a ciò che gli sta sotto.
  if (n.kind === "group") return false;
  // Un'ISTANZA non si colpisce mai sul proprio box: come un gruppo non ha
  // geometria propria (il suo contenuto è il master, store/instances.ts). A
  // colpirla ci pensa la discesa virtuale in canvasRenderer.ts::hitInstance, che
  // prova il sottoalbero del master e risponde con l'id dell'istanza. Senza
  // questo ramo, un'istanza col box di default (o ereditato) ruberebbe i click.
  if (n.kind === "instance") return false;
  // Il guard sulla dimensione vale solo per le forme il cui inchiostro È il box
  // (vedi inkIsBox): testo e vettoriale lo attraversano anche con un lato a
  // zero, esattamente come in drawScene (canvasRenderer.ts).
  if (inkIsBox(n) && (n.width <= 0 || n.height <= 0)) return false;
  // Rotazione (traccia 2): il punto arriva in coordinate MONDO e va portato
  // nello spazio LOCALE del nodo (rotazione inversa attorno al centro) prima di
  // testare la forma, o un'ellisse ruotata verrebbe colpita dal suo rettangolo.
  const local = worldToLocal({ x: wx, y: wy }, nodeCenter(n), n.rotation);
  return hitTestLocal(n, local.x, local.y, zoom);
}

function hitTestLocal(n: NodeLite, wx: number, wy: number, zoom: number): boolean {
  // La sporgenza del tratto ALLARGA il bersaglio: quello che si vede si deve
  // poter cliccare, e un tratto esterno da 20 è una fascia larga 20 tutt'attorno
  // alla forma -- esattamente la parte che si mira per afferrare una forma dal
  // bordo. La misura è quella di canvas/geometry.ts, la stessa che usano
  // marquee ed export: due nozioni diverse di "quanto sporge" darebbero un
  // bersaglio che non coincide con ciò che è dipinto. Il vettoriale non la usa
  // (ha la sua presa in VECTOR_HIT_PX), ma le altre forme sì.
  const outset = strokeOutsetOfNode(n);
  // Il testo si colpisce sul suo BOUNDING BOX, mai sui glifi: è il
  // comportamento atteso in un editor (cliccare fra due lettere, o nello spazio
  // vuoto a destra di una riga corta, seleziona comunque il nodo) ed è anche
  // l'unico test possibile senza misurare il font. Ramo esplicito e non
  // implicito nel fallback: se un giorno il ramo "rect" imparasse i corner
  // radius, il testo non deve seguirlo.
  if (n.kind === "text") return insideBox(inflateBounds(textHitBox(n), outset), wx, wy);
  // Il vettoriale si colpisce sull'INCHIOSTRO, mai sul box: ogni contorno per
  // vicinanza al tratto entro VECTOR_HIT_PX px schermo (perché ogni contorno si
  // traccia), e in più un contorno chiuso su tutto il suo riempimento -- con la
  // stessa regola even-odd con cui è dipinto, quindi un buco è un buco anche per
  // il click. Il box sarebbe il bersaglio sbagliato in entrambi i versi: una "C"
  // larga mezzo schermo si prenderebbe cliccando nel suo vuoto -- rubando il
  // click a tutto ciò che ci sta dentro -- e un path degenere non si
  // prenderebbe affatto.
  //
  // Il punto passa in coordinate LOCALI (una sottrazione sola, qui): gli
  // ancoraggi lo sono, e portarli in mondo uno a uno costerebbe una somma per
  // ogni punto della spezzata.
  if (n.kind === "vector") {
    return hitVectorGeometry(
      n.vector?.subpaths ?? [],
      wx - n.x, wy - n.y,
      VECTOR_HIT_PX / zoom,
      VECTOR_FLATTEN_PX / zoom,
    );
  }
  if (n.kind === "ellipse") {
    // La sporgenza si somma ai RAGGI, non all'AABB: il tratto di un'ellisse è
    // un anello, non una cornice quadrata, quindi l'angolo del rettangolo
    // contenitore allargato deve restare un miss come lo era quello del box.
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2 + outset;
    const ry = n.height / 2 + outset;
    const nx = (wx - cx) / rx;
    const ny = (wy - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return insideBox(inflateBounds(boundsOfNode(n), outset), wx, wy);
}

export interface Box { x: number; y: number; width: number; height: number }

// Il box su cui si colpisce un nodo testo, che NON coincide sempre con il box
// del modello: l'altezza la produce il layout e la width è solo la larghezza di
// wrap, quindi un nodo appena creato può averle a 0 pur essendo disegnato. Un
// box degenere non è colpibile da nessun click (servirebbe wy esattamente
// uguale a n.y), quindi il testo riceve il minimo che si può calcolare senza un
// ctx: una riga alta lineHeight e altrettanto larga -- il target del caret di un
// testo ancora vuoto.
//
// È di proposito una SOTTOstima quando il testo trabocca il suo box: senza
// misurare il font l'hit-test può sbagliare per difetto (il nodo resta
// raggiungibile dal pannello livelli) ma non per eccesso, o ruberebbe i click
// alle forme che gli stanno sotto.
function textHitBox(n: NodeLite): Box {
  const min = lineHeightOf(n.text?.style);
  return { x: n.x, y: n.y, width: Math.max(n.width, min), height: Math.max(n.height, min) };
}

function insideBox(b: Box, wx: number, wy: number): boolean {
  return wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height;
}
