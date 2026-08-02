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

// La bbox della geometria in coordinate LOCALI (stesso spazio degli ancoraggi).
//
// Sull'INVILUPPO dei punti di controllo, non sulla curva vera: una cubica sta
// sempre dentro l'inviluppo dei suoi quattro punti, quindi questo box è un
// SOVRAinsieme -- può essere più largo dell'inchiostro, mai più stretto. È il
// verso giusto in cui sbagliare (un box troppo piccolo farebbe scartare dal
// renderer, o mancare dalla selezione, pezzi di path davvero disegnati), e il
// box esatto costerebbe risolvere la derivata della cubica per asse: si potrà
// stringere dopo, senza cambiare nessun chiamante.
//
// Geometria vuota => box degenere in (0,0): un path senza ancoraggi non ha
// posizione, e inventargliene una sarebbe peggio.
export function vectorBounds(subpaths: readonly SubPathLite[]): BoxLite {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of subpaths) {
    for (const a of sp.anchors) {
      // L'ancoraggio e i suoi due controlli, tutti in coordinate locali.
      for (const [px, py] of [
        [a.x, a.y],
        [a.x + a.inX, a.y + a.inY],
        [a.x + a.outX, a.y + a.outY],
      ] as const) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
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
// lo circonda, il renderer non lo scarta (width/height > 0), il resize ha un box
// su cui lavorare.
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
