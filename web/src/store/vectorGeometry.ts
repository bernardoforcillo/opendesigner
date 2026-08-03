import type { AnchorLite, NodeLite, SubPathLite } from "./types";

// L'UNICA lettura della geometria vettoriale. Renderer, hit-test, overlay e pen
// tool passano tutti da qui: la regola dei due spazi (ancoraggi LOCALI al nodo,
// maniglie RELATIVE all'ancoraggio) è scritta per esteso nel proto su `Anchor`,
// e una seconda implementazione a mano da qualche parte è esattamente il modo in
// cui due lati dello stesso editor finiscono a disegnare due path diversi.
//
// Il modulo è puro e non tocca né la camera né il ctx: parla solo di coordinate
// MONDO, come il resto del modello. La camera resta affare di canvas/camera.ts.

export interface PointLite { x: number; y: number }
export interface BoxLite { x: number; y: number; width: number; height: number }

// L'origine del nodo: lo zero delle coordinate locali degli ancoraggi.
type Origin = Pick<NodeLite, "x" | "y">;

// L'ancoraggio in coordinate mondo.
export function anchorPoint(o: Origin, a: AnchorLite): PointLite {
  return { x: o.x + a.x, y: o.y + a.y };
}

// I due punti di controllo in coordinate mondo. Le maniglie sono OFFSET
// relativi all'ancoraggio, quindi si sommano due volte: origine del nodo +
// ancoraggio + maniglia.
//
// Nessun ramo per "maniglia assente": (0,0) dà il punto di controllo
// COINCIDENTE con l'ancoraggio, e una bezierCurveTo con i controlli sugli
// estremi disegna la retta. È il motivo per cui le maniglie sono relative --
// il caso più comune (un punto d'angolo) è il default di proto3 e non richiede
// né un flag né un caso speciale nel renderer.
export function inHandlePoint(o: Origin, a: AnchorLite): PointLite {
  return { x: o.x + a.x + a.inX, y: o.y + a.y + a.inY };
}

export function outHandlePoint(o: Origin, a: AnchorLite): PointLite {
  return { x: o.x + a.x + a.outX, y: o.y + a.y + a.outY };
}

// Il path che il PEN TOOL sta disegnando, in coordinate MONDO -- il nodo non
// esiste ancora (l'intera creazione è UN gesto e produce UN solo op alla fine),
// quindi non c'è nessuna origine a cui gli ancoraggi possano essere locali.
//
// È il canale con cui il tool parla all'OVERLAY: lo scrive tools/penTool.ts, lo
// tiene lo store accanto al marquee (stessa forma: stato di anteprima in
// coordinate mondo che l'overlay disegna) e lo legge
// renderer/overlayRenderer.ts. La geometria vive qui e non nel tool perché la
// leggono in due, e questo modulo è già l'unico posto in cui si legge un path.
export interface PenPreview {
  // Gli ancoraggi già posati.
  readonly anchors: readonly AnchorLite[];
  // Il segmento di RITORNO (ultimo -> primo) fa parte dell'anteprima: il
  // puntatore è premuto sul primo ancoraggio e il rilascio chiuderà il
  // contorno. Non è un dettaglio cosmetico -- quel segmento è disegnato dalla
  // maniglia ENTRANTE del primo ancoraggio, che è esattamente ciò che il
  // trascinamento di chiusura sta tirando (e che può essere stata decisa
  // parecchi click prima, posando il primo ancoraggio con un trascinamento):
  // senza, l'utente modella una curva che non vede finché il nodo non esiste.
  readonly closed: boolean;
  // Dove cadrebbe il prossimo ancoraggio: l'overlay ci disegna il segmento che
  // segue il cursore. null durante un trascinamento (il cursore sta definendo
  // una MANIGLIA, non un punto nuovo: disegnare il segmento pendente direbbe
  // una cosa falsa).
  readonly next: PointLite | null;
  // L'indice dell'ancoraggio le cui maniglie si stanno trascinando, o null
  // fuori dal trascinamento. Solo le SUE maniglie si disegnano: quelle degli
  // ancoraggi già posati sono geometria decisa, e mostrarle tutte
  // trasformerebbe l'anteprima in una ragnatela.
  readonly active: number | null;
}

// "Ha una maniglia" = l'offset non è nullo. Serve all'overlay (una maniglia
// inesistente non si disegna e non si può afferrare) e al pen tool, non al
// renderer del path -- vedi sopra: disegnare non ha bisogno di distinguere.
export function hasInHandle(a: AnchorLite): boolean {
  return a.inX !== 0 || a.inY !== 0;
}

export function hasOutHandle(a: AnchorLite): boolean {
  return a.outX !== 0 || a.outY !== 0;
}

// Il valore di una cubica di Bézier su UN asse, al parametro t.
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Gli estremi VERI di una cubica su un asse: i due capi, più i punti in cui la
// derivata si annulla DENTRO il segmento.
//
// B'(t)/3 = a·t² + b·t + c con a = -p0+3p1-3p2+p3, b = 2(p0-2p1+p2), c = p1-p0.
// a === 0 non è un caso limite da tollerare ma il caso COMUNE (una maniglia
// speculare all'altra rende la derivata lineare), quindi ha il suo ramo invece
// di dividere per zero. Solo le radici in (0,1) contano: fuori dall'intervallo
// la cubica non è disegnata, ed è esattamente l'errore dell'inviluppo dei punti
// di controllo -- prendere per buono un estremo che la curva non raggiunge.
function addCubicExtrema(
  p0: number, p1: number, p2: number, p3: number,
  push: (v: number) => void,
): void {
  push(p0);
  push(p3);
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (a === 0) {
    if (b !== 0) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  for (const t of roots) if (t > 0 && t < 1) push(cubicAt(p0, p1, p2, p3, t));
}

// La bbox della geometria in coordinate LOCALI (stesso spazio degli ancoraggi).
//
// È la bbox VERA dell'inchiostro, non l'inviluppo dei punti di controllo. La
// differenza non è cosmetica: per A=(0,0) out=(100,0) -> B=(0,100) in=(100,0)
// l'inviluppo dà maxX=100 mentre la curva arriva a 75, un 33% di box vuoto. E il
// box del nodo è ciò su cui l'overlay disegna le 8 maniglie e su cui il marquee
// seleziona (tools/selectTool.ts::nodesInMarquee), quindi sbagliare per eccesso
// NON è il verso innocuo: sono maniglie che non toccano il path e un marquee che
// afferra un nodo senza mai sfiorarne l'inchiostro. Il proto dichiara questo box
// "la bbox locale della geometria" e adesso lo è davvero.
//
// Contano solo i segmenti DISEGNATI: in un contorno aperto la maniglia entrante
// del primo ancoraggio e quella uscente dell'ultimo non appartengono a nessun
// segmento (un pen tool che tiene maniglie speculari agli estremi le ha comunque
// valorizzate), quindi non entrano nel box. In un contorno chiuso invece esiste
// il segmento di ritorno ultimo->primo, e allora entrambe contano.
//
// Un contorno di UN SOLO ancoraggio non ha segmenti: contribuisce il solo punto,
// non le sue maniglie -- non c'è curva che le usi.
//
// Geometria vuota => box degenere in (0,0): un path senza ancoraggi non ha
// posizione, e inventargliene una sarebbe peggio. Il box degenere è un valore
// legittimo e non va falsato qui: il CLICK non passa da questo box (colpisce
// l'inchiostro, renderer/shapes.ts::hitTestNode), e chi ci deve far passare
// sopra un MARQUEE allarga per conto suo
// (renderer/shapes.ts::selectionBoundsOfNode), che è una tolleranza di
// selezione e non un fatto sulla geometria.
export function vectorBounds(subpaths: readonly SubPathLite[]): BoxLite {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pushX = (v: number) => { if (v < minX) minX = v; if (v > maxX) maxX = v; };
  const pushY = (v: number) => { if (v < minY) minY = v; if (v > maxY) maxY = v; };
  for (const sp of subpaths) {
    const n = sp.anchors.length;
    if (n === 0) continue;
    if (n === 1) {
      pushX(sp.anchors[0].x);
      pushY(sp.anchors[0].y);
      continue;
    }
    // Chiuso: c'è anche il segmento di ritorno ultimo -> primo.
    const segments = sp.closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const a = sp.anchors[i];
      const b = sp.anchors[(i + 1) % n];
      addCubicExtrema(a.x, a.x + a.outX, b.x + b.inX, b.x, pushX);
      addCubicExtrema(a.y, a.y + a.outY, b.y + b.inY, b.y, pushY);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// --- appiattimento e hit-test ------------------------------------------------

// I punti di controllo del segmento che va dall'ancoraggio i al successivo, in
// coordinate LOCALI. È la stessa lettura che fa vectorBounds (e che shapes.ts
// traduce in una bezierCurveTo): l'ordine dei quattro punti è quello del canvas
// -- ancoraggio, maniglia USCENTE del primo, maniglia ENTRANTE del secondo,
// ancoraggio.
function segmentControls(a: AnchorLite, b: AnchorLite): [PointLite, PointLite, PointLite, PointLite] {
  return [
    { x: a.x, y: a.y },
    { x: a.x + a.outX, y: a.y + a.outY },
    { x: b.x + b.inX, y: b.y + b.inY },
    { x: b.x, y: b.y },
  ];
}

// Quanti segmenti DISEGNATI ha un contorno. Chiuso: c'è anche il ritorno
// ultimo -> primo. Stessa regola di vectorBounds, e non è un caso -- il box
// deve contenere esattamente ciò che si disegna e ciò che si colpisce.
function segmentCount(sp: SubPathLite): number {
  const n = sp.anchors.length;
  if (n < 2) return 0;
  return sp.closed ? n : n - 1;
}

// Un contorno finisce ANCHE nel secchio del riempimento se e solo se è chiuso e
// ha almeno due ancoraggi: un punto solo non ha area, e `closed` non gliela
// regala (il canvas che lo riempie non dipinge niente).
//
// "ANCHE" è la parola importante: questo predicato NON decide se il contorno si
// disegna: OGNI contorno si traccia (shapes.ts::vectorPaths), chiuso o aperto, e
// OGNI contorno si prende per vicinanza (hitVectorGeometry). Il riempimento è un
// bersaglio in PIÙ, non alternativo -- vedi hitVectorGeometry qui sotto per la
// ragione: `closed` non implica area, e un contorno chiuso di area nulla (due
// ancoraggi, o tre allineati) è un caso RAGGIUNGIBILE con il pen tool. Se il
// riempimento fosse l'unico bersaglio, quel path sparirebbe dal canvas e
// diventerebbe non cliccabile nello stesso istante in cui l'utente lo chiude.
//
// Predicato UNICO perché disegno e hit-test devono classificare allo stesso
// modo: due elenchi separati darebbero un path che si vede riempito e si
// colpisce solo per vicinanza, o viceversa.
export function subpathFills(sp: SubPathLite): boolean {
  return sp.closed && sp.anchors.length >= 2;
}

// Vero se c'è ALMENO un ancoraggio in tutta la geometria, cioè se il nodo
// dipinge qualcosa. È l'unico stato in cui un vettoriale non produce nessun
// Path2D (shapes.ts::vectorPaths) e nessun hit (hitVectorGeometry), e chi
// seleziona deve saperlo distinguere da un path degenere -- che invece si vede
// e si clicca eccome.
export function hasAnyAnchor(subpaths: readonly SubPathLite[]): boolean {
  return subpaths.some((sp) => sp.anchors.length > 0);
}

// Distanza di (px,py) dal SEGMENTO ab -- non dalla retta che lo contiene: con
// la retta un path corto sarebbe afferrabile su tutto il suo prolungamento.
function distanceToSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // Segmento di lunghezza nulla (due ancoraggi coincidenti): è un punto.
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToPolyline(pts: readonly PointLite[], px: number, py: number): number {
  if (pts.length === 0) return Infinity;
  // Un punto solo (un contorno di un ancoraggio) è la distanza dal punto: il
  // ciclo non gira e questo è il valore giusto, non un ripiego.
  let best = Math.hypot(px - pts[0].x, py - pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const d = distanceToSegment(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, px, py);
    if (d < best) best = d;
  }
  return best;
}

// Profondità massima della suddivisione. Ogni livello DIMEZZA la corda e
// divide per ~4 lo scarto, quindi 10 livelli sono 1024 segmenti e una
// riduzione dello scarto di 4^10 ≈ 10^6: una curva larga un milione di unità
// mondo rientrerebbe comunque sotto un quarto di pixel. Il tetto esiste solo
// perché una ricorsione senza fondo su coordinate NaN/Infinite (uno stato che
// il filo può sempre consegnare) appenderebbe il thread dell'interfaccia.
const MAX_FLATTEN_DEPTH = 10;

// "Piatta" = entrambi i punti di controllo distano meno di `tol` dalla CORDA
// p0-p3. La cubica sta dentro l'inviluppo convesso dei suoi quattro punti di
// controllo, quindi se p1 e p2 stanno in una fascia di semilarghezza tol
// attorno alla corda ci sta anche tutta la curva: il criterio è un limite
// SUPERIORE vero sullo scarto, non una stima.
//
// La distanza è dal SEGMENTO e non dalla retta apposta: due controlli allineati
// alla corda ma lontanissimi lungo di essa (p1 a mille unità oltre p3) fanno una
// curva che esce dagli estremi e torna, e sostituirla con la corda perderebbe
// tutta quell'andata e ritorno. Dalla retta disterebbero zero, e il criterio
// direbbe "piatta" a una curva che non lo è.
//
// Il caso comune -- nessuna maniglia, quindi p1 = p0 e p2 = p3 -- dà distanza
// zero al primo colpo: una spezzata da pen tool si appiattisce in se stessa,
// senza un punto in più. Un criterio basato sulla derivata seconda (che è
// grande anche quando la curva è una retta percorsa non uniformemente) la
// spezzerebbe in una ventina di pezzi per niente.
function isFlat(p0: PointLite, p1: PointLite, p2: PointLite, p3: PointLite, tol: number): boolean {
  return distanceToSegment(p0.x, p0.y, p3.x, p3.y, p1.x, p1.y) <= tol
    && distanceToSegment(p0.x, p0.y, p3.x, p3.y, p2.x, p2.y) <= tol;
}

function mid(a: PointLite, b: PointLite): PointLite {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// de Casteljau a t = 0.5, ricorsivo finché il pezzo non è piatto. Spinge SOLO
// i punti successivi al primo (che il chiamante ha già messo), e spinge p3
// esatto invece di ricalcolarlo: gli estremi di ogni segmento restano i punti
// del modello, senza deriva in virgola mobile.
function flattenCubic(
  p0: PointLite, p1: PointLite, p2: PointLite, p3: PointLite,
  tol: number, depth: number, out: PointLite[],
): void {
  if (depth >= MAX_FLATTEN_DEPTH || isFlat(p0, p1, p2, p3, tol)) {
    out.push(p3);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, depth + 1, out);
  flattenCubic(m, p123, p23, p3, tol, depth + 1, out);
}

// Il contorno ridotto a spezzata, in coordinate LOCALI, con scarto dalla curva
// vera minore di `tol`. Un contorno CHIUSO include il segmento di ritorno,
// quindi l'ultimo punto coincide con il primo: il poligono è già chiuso e chi
// lo usa non deve ricordarsi di chiuderlo.
//
// La tolleranza è in unità MONDO. Chi chiama la ricava dai px SCHERMO
// dividendo per lo zoom (renderer/shapes.ts): appiattire in unità mondo
// significherebbe una spezzata visibilmente spigolosa a zoom alto e migliaia
// di punti inutili a zoom basso.
export function flattenSubpath(sp: SubPathLite, tol: number): PointLite[] {
  const n = sp.anchors.length;
  if (n === 0) return [];
  const out: PointLite[] = [{ x: sp.anchors[0].x, y: sp.anchors[0].y }];
  const segments = segmentCount(sp);
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = segmentControls(sp.anchors[i], sp.anchors[(i + 1) % n]);
    flattenCubic(p0, p1, p2, p3, tol, 0, out);
  }
  return out;
}

// Il punto è dentro il riempimento di questi anelli secondo la regola EVEN-ODD:
// conteggio delle intersezioni di una semiretta con TUTTI gli anelli insieme,
// dentro se il totale è dispari.
//
// La scelta di even-odd invece di nonzero è deliberata e vive anche in
// renderer/shapes.ts (VECTOR_FILL_RULE), che la passa a ctx.fill: disegno e
// hit-test devono usare la STESSA regola, o si finisce con un buco che si vede
// ma si clicca. La ragione: con nonzero un contorno interno è un buco solo se
// è percorso nel VERSO OPPOSTO a quello esterno, e questo modello non ha
// nessun modo di controllare il verso -- niente "inverti contorno" fra gli op,
// e il pen tool produce il verso in cui l'utente ha cliccato. Un buco che
// dipende da una proprietà invisibile e non modificabile è un buco che non si
// riesce a fare apposta. Con even-odd decide la sola CONTENENZA: un contorno
// dentro un altro è sempre un buco, e per toglierlo basta spostarlo fuori.
//
// Un punto esattamente SUL bordo è indeterminato (dipende da come cade il
// confronto in virgola mobile). Non è un problema pratico: quel caso richiede
// coordinate esatte al bit, e il bordo di un contorno chiuso è comunque
// circondato dal suo riempimento su un lato.
export function pointInRingsEvenOdd(
  rings: readonly (readonly PointLite[])[], px: number, py: number,
): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].y, yj = ring[j].y;
      // Il lato attraversa la quota py (uno dei due estremi sopra, l'altro no):
      // il confronto asimmetrico > / <= conta ogni vertice UNA volta sola, che
      // è ciò che evita il doppio conteggio quando py cade esattamente su un
      // vertice.
      if ((yi > py) === (yj > py)) continue;
      const xi = ring[i].x, xj = ring[j].x;
      // Ascissa dell'intersezione con la semiretta orizzontale verso destra.
      if (px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}

// L'hit-test della geometria, in coordinate LOCALI (il chiamante sottrae
// l'origine del nodo una volta sola).
//
// La regola è il riflesso esatto di ciò che si DIPINGE (shapes.ts::vectorPaths,
// canvasRenderer.ts::drawVector):
//   - OGNI contorno si traccia, quindi ogni contorno si prende per VICINANZA
//     alla curva, entro `grab`;
//   - in più, un contorno che riempie si prende su tutta la sua AREA, con la
//     stessa regola even-odd con cui è dipinta (un buco è un buco anche per il
//     click).
//
// Il tratto anche sui contorni CHIUSI non è cosmesi. `closed` non implica area:
// un contorno chiuso di due ancoraggi percorre A->B->A e un contorno di tre
// ancoraggi allineati percorre una spezzata schiacciata -- in entrambi i casi
// even-odd non dipinge nulla e non contiene nessun punto. Sono stati
// RAGGIUNGIBILI con il pen tool (click, click, click sul primo per chiudere), e
// con il solo riempimento il nodo sparirebbe dal canvas e diventerebbe non
// cliccabile nello stesso istante in cui l'utente lo chiude, restando
// raggiungibile solo dal pannello livelli. Tracciarlo lo tiene visibile, e la
// vicinanza lo tiene afferrabile: disegno e hit-test restano la stessa cosa.
//
// Il prezzo è una presa di `grab` attorno al perimetro di un contorno chiuso.
// È la stessa che vale già per un contorno aperto e la stessa che si aspetta chi
// ha usato un editor vettoriale (il bordo si afferra), e il tratto ESCE
// davvero dal riempimento di mezzo spessore: senza la presa il bersaglio non
// coinciderebbe più con l'inchiostro.
//
// La tolleranza la misura il chiamante in px SCHERMO -- una linea deve essere
// altrettanto facile da afferrare a ogni zoom, e in unità mondo diventerebbe
// impossibile da centrare a zoom 0.1 e larga mezzo schermo a zoom 64.
//
// `grab` e `flatten` sono già in unità MONDO: la conversione dai px sta in un
// posto solo (renderer/shapes.ts), che è anche l'unico che conosce lo zoom.
export function hitVectorGeometry(
  subpaths: readonly SubPathLite[],
  lx: number, ly: number,
  grab: number, flatten: number,
): boolean {
  const rings: PointLite[][] = [];
  for (const sp of subpaths) {
    const pts = flattenSubpath(sp, flatten);
    if (pts.length === 0) continue;
    if (subpathFills(sp)) rings.push(pts);
    if (distanceToPolyline(pts, lx, ly) <= grab) return true;
  }
  return pointInRingsEvenOdd(rings, lx, ly);
}

export interface NormalizedVector {
  // La geometria traslata perché la sua bbox locale parta da (0,0).
  subpaths: SubPathLite[];
  // Il box del nodo, in coordinate MONDO, che corrisponde a quella geometria.
  box: BoxLite;
}

// L'invariante del box (proto, su VectorNode) reso eseguibile: dopo un
// SetVectorPath la bbox locale della geometria è (0,0)-(width,height).
//
// Chi riscrive i subpath chiama questa funzione con l'origine ATTUALE del nodo
// e manda, nello STESSO gesto, il setVectorPath con `subpaths` e il setProps
// {x,y,width,height} con `box`. Il risultato è un nodo vettoriale
// indistinguibile da un rettangolo per tutto il resto dell'editor: la selezione
// lo circonda e il resize ha un box su cui lavorare.
//
// L'invariante vale nei DUE VERSI, ed è il secondo a costare qualcosa: se il box
// può cambiare senza che la geometria lo segua, un banale drag di una maniglia
// di resize (che manda solo setProps{x,y,width,height}) lo violerebbe subito --
// path della stessa dimensione dentro un box cresciuto. È per questo che esiste
// resizeVector qui sotto, e che selectTool lo emette NELLO STESSO gesto.
//
// La traslazione non muove NIENTE sullo schermo: gli ancoraggi perdono in
// locale esattamente quello che l'origine guadagna in mondo. È la proprietà su
// cui è appesa la correttezza, ed è testata come tale.
//
// Non lo fa applyOp/core.Apply perché la bbox di una cubica non è una copia di
// due righe: due implementazioni "identiche" di quella matematica divergerebbero
// al primo caso limite, cioè sull'invariante che questa traccia difende.
export function normalizeVector(o: Origin, subpaths: readonly SubPathLite[]): NormalizedVector {
  const b = vectorBounds(subpaths);
  return {
    subpaths: subpaths.map((sp) => ({
      anchors: sp.anchors.map((a) => ({
        x: a.x - b.x, y: a.y - b.y,
        // Le maniglie sono RELATIVE all'ancoraggio: una traslazione non le
        // tocca. Toccarle sarebbe il baco silenzioso di questa funzione.
        inX: a.inX, inY: a.inY, outX: a.outX, outY: a.outY,
      })),
      closed: sp.closed,
    })),
    box: { x: o.x + b.x, y: o.y + b.y, width: b.width, height: b.height },
  };
}

// La scala di UN asse come FRAZIONE, non come fattore già diviso: `signed` è
// l'estensione firmata dopo il drag (negativa = flip) e `start` quella di
// partenza. Stessa forma di selection/handles.ts::ResizeTransform, e per la
// stessa ragione numerica -- moltiplicare prima e dividere dopo, altrimenti un
// path a coordinate intere non torna intero dopo un resize esatto.
export interface AxisScale { signed: number; start: number }

// v (coordinata LOCALE, quindi in 0..extent per l'invariante del box) mappato
// nel box nuovo. `extent` è il lato del box PRIMA del resize: serve solo al
// flip, dove l'inchiostro va specchiato dentro il box invece che finire in
// negativo. start === 0 non ha fattore di scala definito: asse invariato, come
// fa mapAxis in selection/handles.ts.
function scaleLocal(v: number, s: AxisScale, extent: number): number {
  if (s.start === 0) return v;
  return s.signed < 0 ? ((v - extent) * s.signed) / s.start : (v * s.signed) / s.start;
}

// Le maniglie sono OFFSET: si scalano con la sola parte LINEARE (nessuna
// traslazione), e un flip ne inverte il verso -- che è ciò che specchia la
// curvatura insieme al path.
function scaleDelta(v: number, s: AxisScale): number {
  return s.start === 0 ? v : (v * s.signed) / s.start;
}

// La geometria riscritta perché continui a riempire il box mentre il resize lo
// cambia. `from` è il box del nodo a INIZIO gesto (non quello di gruppo: in una
// selezione multipla il fattore di scala è comune, il box no).
//
// Serve perché gli ancoraggi sono lunghezze in coordinate locali e NON frazioni
// del box: senza questa riscrittura le 8 maniglie di M1 (tools/selectTool.ts,
// makeSetPropsOp con ["x","y","width","height"] per ogni nodo selezionato)
// cambierebbero il box e lascerebbero l'inchiostro della sua misura, violando
// l'invariante del proto con un gesto ordinario e senza nessun SetVectorPath in
// vista. L'alternativa -- ancoraggi normalizzati a 0..1 del box -- rende
// indefinito ogni path con un asse degenere (divisione per zero) e costringe a
// rinormalizzare tutta la geometria a ogni punto aggiunto dal pen tool.
//
// Una trasformazione affine su ogni punto di controllo trasforma la cubica
// esattamente allo stesso modo (le Bézier sono covarianti per affinità), quindi
// se prima valeva bbox = (0,0)-(w,h) dopo vale bbox = (0,0)-(w',h'): la
// riscrittura MANTIENE l'invariante, non la ricalcola.
export function resizeVector(
  subpaths: readonly SubPathLite[],
  from: { width: number; height: number },
  sx: AxisScale,
  sy: AxisScale,
): SubPathLite[] {
  return subpaths.map((sp) => ({
    anchors: sp.anchors.map((a) => ({
      x: scaleLocal(a.x, sx, from.width),
      y: scaleLocal(a.y, sy, from.height),
      inX: scaleDelta(a.inX, sx), inY: scaleDelta(a.inY, sy),
      outX: scaleDelta(a.outX, sx), outY: scaleDelta(a.outY, sy),
    })),
    closed: sp.closed,
  }));
}
