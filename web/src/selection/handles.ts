import { type Camera, worldToScreen } from "../canvas/camera";
import { type Bounds, inflateBounds, pointInBounds, worldBoundsToScreen } from "../canvas/geometry";
import {
  centerOf, localToWorld, normalizeDegrees, rotateAround, rotateVector, type Point,
} from "../canvas/transform";

const DEG_TO_RAD = Math.PI / 180;

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// Le sole 4 maniglie che portano anche una zona di ROTAZIONE (la convenzione
// degli editor: si ruota dagli angoli, non dai lati).
export type CornerId = "nw" | "ne" | "se" | "sw";
export const CORNER_IDS: readonly CornerId[] = ["nw", "ne", "se", "sw"];

// Lato (px SCHERMO) del quadratino disegnato dall'overlay.
export const HANDLE_SIZE = 8;

// Area di presa: leggermente più generosa del quadratino disegnato (8px sono
// pochi da centrare col mouse). È px SCHERMO, quindi resta costante a ogni
// livello di zoom -- è tutto il punto di fare l'hit-test in spazio schermo
// invece che in spazio mondo.
export const HANDLE_GRAB_PADDING = 2;

// Angoli PRIMA dei lati: con un bbox piccolo le aree di presa si sovrappongono
// e l'angolo (che muove due assi) è quasi sempre quello che l'utente vuole.
export const HANDLE_IDS: readonly HandleId[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];

// Quali bordi del bbox muove ogni maniglia. Tutta la matematica del resize
// (incluso il flip) discende da qui.
const MOVES: Record<HandleId, { left: boolean; right: boolean; top: boolean; bottom: boolean }> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

const CURSORS: Record<HandleId, string> = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
};

export function cursorForHandle(h: HandleId): string {
  return CURSORS[h];
}

// Centri delle 8 maniglie attorno a un bbox già in spazio SCHERMO.
export function handlePositions(b: Bounds): Record<HandleId, { x: number; y: number }> {
  const midX = b.x + b.width / 2;
  const midY = b.y + b.height / 2;
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  return {
    nw: { x: b.x, y: b.y },
    n: { x: midX, y: b.y },
    ne: { x: right, y: b.y },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: b.x, y: bottom },
    w: { x: b.x, y: midY },
  };
}

// Quadrati delle maniglie in px SCHERMO per un bbox in coordinate MONDO: il
// bbox si scala con lo zoom, i quadrati NO (sono sempre HANDLE_SIZE).
export function handleScreenRects(b: Bounds, cam: Camera): Record<HandleId, Bounds> {
  const box = worldBoundsToScreen(b, cam);
  const half = HANDLE_SIZE / 2;
  const out = {} as Record<HandleId, Bounds>;
  for (const [id, p] of Object.entries(handlePositions(box)) as [HandleId, { x: number; y: number }][]) {
    out[id] = { x: p.x - half, y: p.y - half, width: HANDLE_SIZE, height: HANDLE_SIZE };
  }
  return out;
}

// (sx, sy) sono px SCHERMO nello spazio del canvas, come i rettangoli qui
// sopra: nessuna conversione a mano, la camera entra solo via
// handleScreenRects.
export function hitTestHandle(b: Bounds, cam: Camera, sx: number, sy: number): HandleId | null {
  const rects = handleScreenRects(b, cam);
  for (const id of HANDLE_IDS) {
    if (pointInBounds(inflateBounds(rects[id], HANDLE_GRAB_PADDING), sx, sy)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// FRAME: il bbox della selezione PIÙ la sua rotazione
// ---------------------------------------------------------------------------
//
// Tutto ciò che sta sopra ragiona su un rettangolo asse-allineato, ed è giusto
// così: il resize (flip e keepAspect compresi) è definito in quello spazio, ed
// è già testato lì. La rotazione non lo riscrive, lo AVVOLGE -- il frame è
// quello stesso rettangolo più un angolo, e ogni funzione qui sotto si limita a
// portare punti e delta dentro o fuori dallo spazio locale del frame passando
// SEMPRE da canvas/transform.ts (gradi, orari, attorno al centro del bbox).
//
// Un frame con rotation 0 attraversa esattamente il codice di prima, numero per
// numero: rotateVector/rotateAround riconoscono l'angolo nullo e restituiscono
// le coordinate identiche, e l'offset qui sotto vale 0.

export interface SelectionFrame {
  bounds: Bounds;
  // Gradi, orari, attorno al CENTRO di `bounds`.
  rotation: number;
}

export type FrameHit =
  | { kind: "resize"; handle: HandleId }
  | { kind: "rotate"; corner: CornerId };

// Lato (px SCHERMO) del quadrato di presa della rotazione, centrato sull'angolo.
// Più grande dell'area di presa del resize apposta: la parte che avanza è
// l'anello ESTERNO all'angolo, che è tutto ciò che la rotazione occupa (vedi
// hitTestFrame). 22 lascia ~5px di anello per lato oltre i 12 del resize.
export const ROTATE_GRAB_SIZE = 22;

// Il CSS non ha un cursore "ruota": "grab"/"grabbing" è la coppia più vicina al
// gesto (afferrare l'angolo e girarlo) e non finge un'operazione diversa, come
// farebbe "crosshair".
export const ROTATE_CURSOR = "grab";
export const ROTATING_CURSOR = "grabbing";

export function cursorForFrameHit(hit: FrameHit): string {
  return hit.kind === "rotate" ? ROTATE_CURSOR : cursorForHandle(hit.handle);
}

export function frameCenter(f: SelectionFrame): Point {
  return centerOf(f.bounds);
}

// Centri delle 8 maniglie in coordinate MONDO, rotazione inclusa.
export function handleWorldPoints(f: SelectionFrame): Record<HandleId, Point> {
  const c = centerOf(f.bounds);
  const flat = handlePositions(f.bounds);
  const out = {} as Record<HandleId, Point>;
  for (const id of HANDLE_IDS) out[id] = localToWorld(flat[id], c, f.rotation);
  return out;
}

// Gli stessi centri in px SCHERMO: è dove l'overlay disegna i quadratini (che
// restano di HANDLE_SIZE px a ogni zoom, vedi handleScreenRects).
export function handleScreenPoints(f: SelectionFrame, cam: Camera): Record<HandleId, Point> {
  const world = handleWorldPoints(f);
  const out = {} as Record<HandleId, Point>;
  for (const id of HANDLE_IDS) out[id] = worldToScreen(cam, world[id].x, world[id].y);
  return out;
}

// Il punto schermo riportato nello spazio schermo NON ruotato del frame: da lì
// in poi valgono tutte le funzioni asse-allineate qui sopra. La camera è una
// similitudine (scala uniforme + traslazione), quindi la rotazione del mondo è
// la STESSA rotazione sullo schermo -- basta girare attorno al centro del frame
// convertito in px schermo.
function unrotateScreenPoint(f: SelectionFrame, cam: Camera, sx: number, sy: number): Point {
  if (f.rotation % 360 === 0) return { x: sx, y: sy };
  const c = centerOf(f.bounds);
  const screenCenter = worldToScreen(cam, c.x, c.y);
  return rotateAround({ x: sx, y: sy }, screenCenter, -f.rotation);
}

// L'hit-test COMPLETO dell'overlay: prima le 8 maniglie di resize, poi le 4
// zone di rotazione. In quest'ordine perché la zona di rotazione contiene
// l'angolo, e sull'angolo l'utente vuole ridimensionare.
//
// La zona di rotazione è quel che resta di un quadrato ROTATE_GRAB_SIZE
// centrato sull'angolo una volta tolto tutto ciò che sta DENTRO il riquadro di
// selezione: si ruota afferrando appena FUORI dall'angolo, e un click dentro la
// forma resta un click sulla forma (spostamento) come è sempre stato.
export function hitTestFrame(f: SelectionFrame, cam: Camera, sx: number, sy: number): FrameHit | null {
  const p = unrotateScreenPoint(f, cam, sx, sy);
  const handle = hitTestHandle(f.bounds, cam, p.x, p.y);
  if (handle) return { kind: "resize", handle };
  if (pointInBounds(worldBoundsToScreen(f.bounds, cam), p.x, p.y)) return null;
  const rects = handleScreenRects(f.bounds, cam);
  const pad = (ROTATE_GRAB_SIZE - HANDLE_SIZE) / 2;
  for (const id of CORNER_IDS) {
    if (pointInBounds(inflateBounds(rects[id], pad), p.x, p.y)) return { kind: "rotate", corner: id };
  }
  return null;
}

// LA MANIGLIA DI ROTAZIONE DISEGNATA. La zona di presa qui sopra è un'AREA
// (l'anello a L attorno all'angolo); questo è il punto in cui l'overlay ne
// disegna il segno. Un segno che si vede è il punto: senza, l'unica affordance
// era il cursore, e una maniglia che non si disegna è una maniglia che non si
// trova.
//
// Il segno sta TUTTO dentro la propria zona di presa, e la geometria è una
// sola (queste costanti) invece di due copie destinate a scollarsi. I due
// vincoli, con un disco di raggio R centrato a distanza D dall'angolo sulla
// diagonale uscente:
//
//   1. DENTRO la zona di rotazione: D + R <= 11 (il semilato di
//      ROTATE_GRAB_SIZE attorno all'angolo). 8 + 2.5 = 10.5, sta.
//   2. FUORI dal quadrato di presa del RESIZE, che vince sull'angolo
//      (semilato HANDLE_SIZE/2 + HANDLE_GRAB_PADDING = 6): il punto del
//      quadrato più vicino al centro del disco è il suo angolo (6, 6), a
//      distanza sqrt((8−6)² + (8−6)²) = 2.83 > 2.5. Non si toccano.
//
// Ne segue anche che ogni pixel disegnato cade FUORI dal riquadro di selezione,
// dove il click è una rotazione e non uno spostamento. Il test
// "draws only where it grabs" campiona il disco e lo verifica.

// Direzione USCENTE della diagonale di ogni angolo, in spazio schermo del
// frame NON ruotato (y in giù, come il canvas).
export const ROTATE_CORNER_DIRS: Record<CornerId, Point> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
};

// Quanto il segno sta FUORI dall'angolo, e quanto è grande (px SCHERMO, come
// HANDLE_SIZE: costante a ogni zoom).
export const ROTATE_MARKER_OFFSET = 8;
export const ROTATE_MARKER_RADIUS = 2.5;

// Centri dei 4 segni, per un bbox già in spazio SCHERMO (come handlePositions).
export function rotateMarkerPositions(b: Bounds): Record<CornerId, Point> {
  const corners = handlePositions(b);
  const out = {} as Record<CornerId, Point>;
  for (const id of CORNER_IDS) {
    const d = ROTATE_CORNER_DIRS[id];
    out[id] = {
      x: corners[id].x + d.x * ROTATE_MARKER_OFFSET,
      y: corners[id].y + d.y * ROTATE_MARKER_OFFSET,
    };
  }
  return out;
}

// Trasformazione affine (solo scala + ancora) prodotta da un drag di resize.
// Tenerla separata da resizeBounds serve al resize di una selezione MULTIPLA:
// ogni nodo viene mappato con la stessa trasformazione del bbox di gruppo, e
// il ribaltamento specchia i figli invece di limitarsi a normalizzare.
//
// Il fattore di scala su X è signedW/startW, ma NON lo precalcoliamo: lo
// teniamo come frazione così mapAxis può moltiplicare PRIMA e dividere DOPO.
// Con la divisione anticipata anche un caso esatto sbanda ((100*(110/100)) dà
// 110.00000000000001), e il resize di un rettangolo a coordinate intere deve
// restituire coordinate intere.
export interface ResizeTransform {
  anchorX: number;
  anchorY: number;
  startW: number;
  startH: number;
  // Estensioni FIRMATE dopo il drag, misurate dall'ancora: negative = flip.
  signedW: number;
  signedH: number;
}

function signOf(v: number): number {
  return v < 0 ? -1 : 1;
}

// v mappato attorno all'ancora con il rapporto signed/start. start === 0 (bbox
// degenere) non ha un fattore di scala definito: lasciamo l'asse invariato
// invece di produrre Infinity/NaN.
function mapAxis(v: number, anchor: number, signed: number, start: number): number {
  return start === 0 ? v : anchor + ((v - anchor) * signed) / start;
}

export function resizeTransform(
  start: Bounds,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): ResizeTransform {
  const m = MOVES[h];
  const movesH = m.left || m.right;
  const movesV = m.top || m.bottom;

  // L'ancora è il bordo OPPOSTO alla maniglia: è l'unico punto che il resize
  // non muove mai. Sugli assi che la maniglia non tocca l'ancora è il bordo
  // iniziale (min), così quell'asse resta identico (scala 1).
  const anchorX = m.left ? start.x + start.width : start.x;
  const anchorY = m.top ? start.y + start.height : start.y;

  // Larghezza/altezza FIRMATE dopo il drag, misurate dall'ancora: positive
  // finché il bordo mobile resta dalla parte iniziale dell'ancora, negative
  // quando la supera (= flip).
  let signedW = m.left ? start.width - dxWorld : m.right ? start.width + dxWorld : start.width;
  let signedH = m.top ? start.height - dyWorld : m.bottom ? start.height + dyWorld : start.height;

  if (opts?.keepAspect && start.width !== 0 && start.height !== 0) {
    // Rapporto preservato <=> |scaleX| === |scaleY| (scala uniforme). Il segno
    // resta indipendente, così il flip continua a funzionare con shift premuto.
    const scaleX = signedW / start.width;
    const scaleY = signedH / start.height;
    if (movesH && movesV) {
      // Angolo: comanda l'asse trascinato di più, in proporzione. "Di più" NON
      // è il |fattore| più grande: max(|scaleX|, |scaleY|) premia l'asse mosso
      // MENO ogni volta che il drag rimpicciolisce -- se con dx=-50, dy=0 dava
      // max(0.75, 1) = 1, cioè il neutro dell'asse fermo, e il resize non
      // faceva nulla. È lo stesso errore che i lati qui sotto evitano già.
      //
      // La misura giusta è quanto il bordo mobile ha VIAGGIATO in proporzione
      // al lato: |signedW - startW| / startW === |scaleX - 1|. Vale 0 per un
      // asse fermo, cresce sia allargando sia stringendo, e supera 1 quando il
      // drag ha oltrepassato l'ancora (flip). Vinto l'asse, il fattore comune è
      // il suo |scale|; i SEGNI restano per-asse, così shift + flip continua a
      // specchiare solo l'asse davvero trascinato oltre l'ancora.
      const travelX = Math.abs(scaleX - 1);
      const travelY = Math.abs(scaleY - 1);
      const s = travelX >= travelY ? Math.abs(scaleX) : Math.abs(scaleY);
      signedW = signOf(scaleX) * s * start.width;
      signedH = signOf(scaleY) * s * start.height;
    } else if (movesH) {
      // Lato verticale (e/w): l'asse orizzontale è l'unico trascinato, quindi
      // comanda sempre -- anche quando rimpicciolisce (|scaleX| < 1).
      signedH = Math.abs(scaleX) * start.height;
    } else if (movesV) {
      signedW = Math.abs(scaleY) * start.width;
    }
  }

  return { anchorX, anchorY, startW: start.width, startH: start.height, signedW, signedH };
}

// Applica la trasformazione e NORMALIZZA: width/height restano >= 0 anche dopo
// un flip (il rettangolo si ribalta, x/y passano dall'altra parte dell'ancora).
export function transformBounds(b: Bounds, t: ResizeTransform): Bounds {
  const x0 = mapAxis(b.x, t.anchorX, t.signedW, t.startW);
  const x1 = mapAxis(b.x + b.width, t.anchorX, t.signedW, t.startW);
  const y0 = mapAxis(b.y, t.anchorY, t.signedH, t.startH);
  const y1 = mapAxis(b.y + b.height, t.anchorY, t.signedH, t.startH);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

// dxWorld/dyWorld sono lo spostamento del puntatore in coordinate MONDO
// dall'inizio del gesto (non l'ultimo delta incrementale): il resize si calcola
// sempre dai bounds INIZIALI, così gli errori non si accumulano move dopo move.
export function resizeBounds(
  start: Bounds,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): Bounds {
  return transformBounds(start, resizeTransform(start, h, dxWorld, dyWorld, opts));
}

// Il resize di un frame RUOTATO. Due sole aggiunte a resizeTransform, che resta
// intatta (flip e keepAspect sono già suoi, e già testati):
//
//  1. il delta del puntatore entra nello spazio LOCALE del frame, così la
//     maniglia e allarga il nodo lungo il SUO asse x -- che sullo schermo può
//     puntare in qualunque direzione -- e ignora la componente trasversale;
//  2. un OFFSET che rimette a posto l'ancora. resizeTransform tiene fermo il
//     bordo opposto alla maniglia in coordinate LOCALI, ma il nodo ruota
//     attorno al proprio CENTRO, e il resize sposta quel centro: senza
//     correzione il nodo scivolerebbe via mentre lo si ridimensiona.
//
//     Detti c e c' il centro prima e dopo, il punto d'ancora A finisce da
//     c + R(A − c) a c' + R(A − c'), quindi la correzione è
//         (c + R(A − c)) − (c' + R(A − c')) = (c − c') − R(c − c')
//     che non dipende da A: una sola traslazione per TUTTI i nodi del frame.
export interface FrameResize {
  transform: ResizeTransform;
  offsetX: number;
  offsetY: number;
  // La rotazione del FRAME (gradi). Serve a chi mappa un nodo il cui angolo è
  // diverso da quello del frame: la scala vale lungo gli assi del frame, quindi
  // conta solo la differenza fra i due angoli (vedi applyFrameResizeToNode).
  rotation: number;
}

export function resizeFrame(
  f: SelectionFrame,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): FrameResize {
  const d = rotateVector({ x: dxWorld, y: dyWorld }, -f.rotation);
  const transform = resizeTransform(f.bounds, h, d.x, d.y, opts);
  const c = centerOf(f.bounds);
  const after = centerOf(transformBounds(f.bounds, transform));
  const dc = { x: c.x - after.x, y: c.y - after.y };
  const rdc = rotateVector(dc, f.rotation);
  return { transform, offsetX: dc.x - rdc.x, offsetY: dc.y - rdc.y, rotation: f.rotation };
}

// Applica al bbox di UN nodo la trasformazione di frame calcolata sopra. Il
// ramo senza offset non è un'ottimizzazione: è la garanzia che un frame non
// ruotato restituisca gli stessi identici numeri di transformBounds (un +0 su
// un -0 non è un no-op, e i test sul resize confrontano numeri esatti).
export function applyFrameResize(b: Bounds, r: FrameResize): Bounds {
  const out = transformBounds(b, r.transform);
  if (r.offsetX === 0 && r.offsetY === 0) return out;
  return { x: out.x + r.offsetX, y: out.y + r.offsetY, width: out.width, height: out.height };
}

// Lo stesso, per un nodo il cui angolo NON è quello del frame -- il caso di una
// selezione MULTIPLA (il riquadro di gruppo è asse-allineato, vedi
// overlayRenderer::selectionFrame) che contiene un nodo ruotato.
//
// applyFrameResize da sola sbaglia, e sbaglia in modo visibile: scala il box
// LOCALE del nodo, cioè lo allunga lungo i suoi assi invece che lungo quelli
// dello schermo su cui l'utente sta trascinando. Un nodo a 90° dentro un gruppo
// tirato in ORIZZONTALE cresceva in VERTICALE e usciva dal riquadro.
//
// Quello che la scala di gruppo fa davvero è mappare gli ASSI del nodo: l'asse
// x locale (cos θ, sin θ) diventa (kx·cos θ, ky·sin θ) e l'asse y (−sin θ,
// cos θ) diventa (−kx·sin θ, ky·cos θ), dove θ è l'angolo del nodo RELATIVO al
// frame. Da lì si leggono le tre cose che servono: la nuova larghezza (la
// lunghezza del primo asse), la nuova altezza (quella del secondo) e il nuovo
// angolo (la direzione del primo).
//
// È ESATTO per una scala uniforme, per θ multiplo di 90° (gli assi si
// scambiano) e per un ribaltamento (kx·ky < 0: l'angolo si specchia da sé,
// perché atan2 legge la direzione vera dell'asse). Per un angolo qualunque con
// scala non uniforme il risultato esatto sarebbe un PARALLELOGRAMMA, che il
// modello (x/y/w/h + un angolo) non sa rappresentare: si tiene il rettangolo
// con gli stessi assi e le stesse lunghezze, che è l'approssimazione standard
// -- e comunque dentro il riquadro di gruppo, non fuori.
export interface RotatedBounds {
  bounds: Bounds;
  rotation: number;
}

export function applyFrameResizeToNode(b: Bounds, rotation: number, r: FrameResize): RotatedBounds {
  const theta = rotation - r.rotation;
  // Nodo ALLINEATO al frame (selezione singola, o gruppo di nodi non ruotati):
  // i suoi assi sono quelli del frame e la mappa di sempre è già esatta. Ramo
  // separato per garantire gli stessi identici numeri, non per velocità.
  if (theta % 360 === 0) return { bounds: applyFrameResize(b, r), rotation };

  const t = r.transform;
  const kx = t.startW === 0 ? 1 : t.signedW / t.startW;
  const ky = t.startH === 0 ? 1 : t.signedH / t.startH;
  const rad = theta * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Il CENTRO segue la trasformazione di gruppo come qualunque altro punto: è
  // lui a tenere il nodo dentro il riquadro.
  const c = centerOf(b);
  const cx = mapAxis(c.x, t.anchorX, t.signedW, t.startW) + r.offsetX;
  const cy = mapAxis(c.y, t.anchorY, t.signedH, t.startH) + r.offsetY;

  // Scala UNIFORME e positiva: la forma ruotata resta simile a sé stessa,
  // l'angolo non si tocca e i numeri restano esatti (niente giro per atan2).
  if (kx === ky && kx > 0) {
    const width = b.width * kx;
    const height = b.height * kx;
    return { bounds: { x: cx - width / 2, y: cy - height / 2, width, height }, rotation };
  }

  const ux = kx * cos;
  const uy = ky * sin;
  const vx = -kx * sin;
  const vy = ky * cos;
  const width = b.width * Math.hypot(ux, uy);
  const height = b.height * Math.hypot(vx, vy);
  return {
    bounds: { x: cx - width / 2, y: cy - height / 2, width, height },
    rotation: normalizeDegrees(r.rotation + Math.atan2(uy, ux) / DEG_TO_RAD),
  };
}

// Il caso "un nodo solo", per intero: comodo ai test e ai chiamanti che non
// hanno una selezione multipla da mappare.
export function resizeRotatedBounds(
  start: Bounds,
  rotation: number,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): Bounds {
  const f: SelectionFrame = { bounds: start, rotation };
  return applyFrameResize(start, resizeFrame(f, h, dxWorld, dyWorld, opts));
}
