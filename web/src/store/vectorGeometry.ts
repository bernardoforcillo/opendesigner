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
// legittimo e non va falsato qui: chi deve poterci CLICCARE sopra allarga per
// conto suo (renderer/shapes.ts::selectionBoundsOfNode), che è una tolleranza di
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
