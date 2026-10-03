import type { SceneState } from "../store/types";
import { type Camera, worldToScreen } from "../canvas/camera";
import { type Bounds, unionBounds, worldBoundsToScreen } from "../canvas/geometry";
import { contentWorldBounds, isGroup } from "../store/groups";
import { isInstance } from "../store/instances";
import { worldBoundsOfNode } from "../canvas/transform";
import type { SnapGuide } from "../selection/snap";
import {
  CORNER_IDS,
  HANDLE_SIZE,
  handlePositions,
  ROTATE_CORNER_DIRS,
  ROTATE_MARKER_RADIUS,
  rotateMarkerPositions,
  type SelectionFrame,
} from "../selection/handles";
import {
  anchorPoint,
  hasInHandle,
  hasOutHandle,
  inHandlePoint,
  outHandlePoint,
} from "../store/vectorGeometry";
import type { PenPreview, PointLite } from "../store/vectorGeometry";
import { themeColors, withAlpha } from "./themeColors";

// La geometria delle maniglie (posizioni, hit-test, resize) è UNA sola e vive
// in selection/handles.ts: qui si disegna soltanto. Ri-esportata perché il
// renderer resta il punto d'ingresso naturale per chi disegna l'overlay.
export {
  HANDLE_SIZE, handlePositions, ROTATE_MARKER_OFFSET, ROTATE_MARKER_RADIUS, rotateMarkerPositions,
  type HandleId, type SelectionFrame,
} from "../selection/handles";
export { worldBoundsToScreen } from "../canvas/geometry";

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;

// Apertura dell'arco del segno di rotazione: un quarto di giro, rivolto verso
// l'angolo. Un cerchio chiuso si leggerebbe come un'altra maniglia; un arco
// aperto è il segno con cui gli editor dicono "gira".
const ROTATE_ARC_GAP = Math.PI / 2;
const ROTATE_MARKER_WIDTH = 1.5;

// Le guide di snap sono MAGENTA e non nel blu d'accento come il resto
// dell'overlay, di proposito: il blu dice "questo è selezionato", il magenta dice
// "questa è la retta su cui stai scattando". Sono due informazioni diverse e
// compaiono insieme -- con lo stesso colore la guida si leggerebbe come un altro
// bordo del riquadro. Un magenta caldo e non il rosso di prima: il rosso è del
// sistema per "errore" (danger), e una guida non è un errore. Il colore sta in
// themeColors (uno per tema, leggibile su tela chiara e scura).
const SNAP_GUIDE_WIDTH = 1;

function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Il blu dell'interfaccia (token --accent, risolto da themeColors): bbox di
// selezione, maniglie, marquee e path in corso parlano tutti la stessa lingua.
// Una sola fonte, così non può diventarne due, e segue il tema.

// Un quadratino con gli angoli smussati (2px). Dove il contesto non ha
// roundRect (i finti ctx dei test, browser vecchi) è il quadrato di sempre: stessa
// geometria, solo spigoli vivi.
function roundedSquare(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill: string, stroke: string): void {
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, 2);
    ctx.fill();
    ctx.stroke();
    return;
  }
  ctx.fillRect(x, y, size, size);
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
}

// Lato (px SCHERMO) del quadratino di un ancoraggio del PEN TOOL. Più piccolo
// delle maniglie di resize (HANDLE_SIZE = 8) di proposito: sono due bersagli
// diversi e non devono sembrare lo stesso -- l'uno ridimensiona il box, l'altro
// è un punto della geometria.
export const PEN_ANCHOR_SIZE = 6;

// Raggio di PRESA (px SCHERMO) del primo ancoraggio: quanto vicino deve cadere
// il click che CHIUDE il contorno. Più generoso del quadratino disegnato,
// esattamente come HANDLE_GRAB_PADDING lo è per le maniglie di resize (6px sono
// pochi da centrare col mouse), e in px SCHERMO perché la presa deve restare la
// stessa a ogni livello di zoom. Lo legge tools/penTool.ts: disegno e presa
// devono venire dallo stesso posto, o il bersaglio non è più quello che si
// vede.
export const PEN_ANCHOR_GRAB_PX = 6;

// Raggio (px SCHERMO) del pallino in punta a una maniglia bézier.
const PEN_HANDLE_DOT = 3;

// Il tratteggio del segmento PENDENTE (quello che segue il cursore). Tratteggio
// e non tinta piena perché quel pezzo non è ancora geometria: nessun click lo
// ha ancora posato, e disegnarlo identico al resto prometterebbe una curva che
// il documento non contiene.
const PEN_PENDING_DASH = [4, 3];

// Gli ancoraggi dell'anteprima sono già in coordinate MONDO (il nodo non esiste
// ancora, quindi non c'è nessuna origine da cui misurarli): la lettura della
// regola dei due spazi resta quella di vectorGeometry, con origine nello zero.
const PEN_ORIGIN = { x: 0, y: 0 };

// Il path che il pen tool sta disegnando, in spazio SCHERMO come tutto il resto
// dell'overlay.
//
// I quattro punti di controllo di ogni segmento si convertono UNO A UNO con
// worldToScreen e la bézier si disegna in schermo: è esatto, non
// un'approssimazione, perché la trasformazione della camera è affine (scala
// uniforme + traslazione) e le curve di Bézier sono covarianti per affinità --
// trasformare i controlli trasforma la curva. Il vantaggio è che il tratto
// resta di 1px a ogni zoom, come le maniglie di selezione.
function drawPenPreview(ctx: CanvasRenderingContext2D, cam: Camera, pen: PenPreview): void {
  const anchors = pen.anchors;
  const n = anchors.length;
  if (n === 0) return;
  const to = (p: PointLite) => worldToScreen(cam, p.x, p.y);
  const { accent: ACCENT } = themeColors();

  ctx.lineWidth = 1;
  ctx.strokeStyle = ACCENT;

  // 1. Il contorno già posato. Un ancoraggio solo non ha segmenti: si vede il
  //    suo quadratino e basta.
  //
  //    Se l'anteprima è CHIUSA c'è un segmento in più, quello di ritorno
  //    (ultimo -> primo): stesso ciclo, indice del bersaglio modulo n --
  //    identico a renderer/shapes.ts::traceSubpath, perché è la stessa
  //    geometria e deve venire dalla stessa regola. È il segmento che il
  //    trascinamento di chiusura sta modellando (tira la maniglia ENTRANTE del
  //    primo ancoraggio, cioè il secondo punto di controllo di QUESTA curva):
  //    senza disegnarlo, di quel trascinamento si vedrebbero solo il bastoncino
  //    e il pallino, e la curva comparirebbe solo a nodo creato.
  if (n > 1) {
    const segments = pen.closed ? n : n - 1;
    ctx.beginPath();
    const start = to(anchorPoint(PEN_ORIGIN, anchors[0]));
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i <= segments; i++) {
      const a = anchors[i - 1];
      const b = anchors[i % n];
      const c1 = to(outHandlePoint(PEN_ORIGIN, a));
      const c2 = to(inHandlePoint(PEN_ORIGIN, b));
      const p = to(anchorPoint(PEN_ORIGIN, b));
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
    }
    ctx.stroke();
  }

  // 2. Il segmento che seguirebbe il cursore. Il punto d'arrivo non ha
  //    maniglia, quindi il secondo controllo cade su di lui: è esattamente la
  //    curva che si otterrebbe posando lì un ancoraggio d'angolo, non
  //    un'approssimazione dritta.
  if (pen.next) {
    const last = anchors[n - 1];
    const a = to(anchorPoint(PEN_ORIGIN, last));
    const c1 = to(outHandlePoint(PEN_ORIGIN, last));
    const end = to(pen.next);
    ctx.setLineDash(PEN_PENDING_DASH);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c1.x, c1.y, end.x, end.y, end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. Le maniglie dell'ancoraggio che si sta trascinando: il bastoncino fino
  //    al punto di controllo e il suo pallino. Solo quelle ESISTENTI (offset
  //    non nullo): una maniglia a zero coincide con l'ancoraggio, e disegnarla
  //    sarebbe un pallino sopra il quadratino che non vuol dire niente.
  const active = pen.active === null ? null : anchors[pen.active];
  if (active) {
    const c = to(anchorPoint(PEN_ORIGIN, active));
    const ends: PointLite[] = [];
    if (hasInHandle(active)) ends.push(inHandlePoint(PEN_ORIGIN, active));
    if (hasOutHandle(active)) ends.push(outHandlePoint(PEN_ORIGIN, active));
    for (const end of ends) {
      const p = to(end);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, PEN_HANDLE_DOT, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }

  // 4. I quadratini degli ancoraggi, sopra a tutto il resto. Il PRIMO è pieno:
  //    è il bersaglio che CHIUDE il contorno, e deve distinguersi dagli altri
  //    prima ancora che il puntatore ci arrivi sopra.
  const half = PEN_ANCHOR_SIZE / 2;
  for (let i = 0; i < n; i++) {
    const p = to(anchorPoint(PEN_ORIGIN, anchors[i]));
    // (+0.5 dentro roundedSquare, come per le maniglie di selezione: lo stroke
    // da 1px cade su un confine di pixel netto invece di sbavare su due righe.)
    roundedSquare(ctx, p.x - half, p.y - half, PEN_ANCHOR_SIZE, i === 0 ? ACCENT : "#ffffff", ACCENT);
  }
}

// Unione (in coordinate MONDO) dei bounds dei nodi selezionati. GEOMETRIA, non
// il dipinto: il tratto NON entra qui, di proposito -- il riquadro è il frame su
// cui vivono le maniglie e il resize scrive proprio in x/y/width/height, quindi
// includere la sporgenza del tratto staccherebbe le maniglie dal bordo. null se
// la selezione è vuota o non punta più a nodi esistenti -- lo store toglie già
// gli id spariti (vedi store.ts), ma questa resta difensiva così l'overlay non
// esplode su uno stato transitorio incoerente. Testabile senza ctx/DOM.
//
// Bounds MONDO e non del modello: il box del modello è scritto nello spazio del
// PARENT, mentre tutto ciò che sta a valle di qui (la cornice, le maniglie, il
// loro hit-test) lavora in mondo e poi in schermo. Per un nodo figlio di una
// pagina le due cose coincidono, ed è ciò che tiene fermi i documenti già
// esistenti.
//
// contentWorldBounds e non worldBoundsOfNode: un GRUPPO non ha un box proprio
// (store/groups.ts), i suoi bounds sono l'unione dei figli. Leggere il suo box
// darebbe un rettangolo 0x0 all'origine del gruppo -- cornice e maniglie
// nell'angolo sbagliato dello schermo, su un gruppo che si vede benissimo.
// Un gruppo vuoto non contribuisce nulla (null), esattamente come un id sparito.
// contentWorldBounds ritaglia anche ai frame antenati con clipsContent (fix
// deliberato di T1), così le maniglie non finiscono su canvas vuoto oltre il
// bordo di un frame ritagliante. Il caso a UN nodo, dove serve la sua rotazione
// propria, lo tratta a parte selectionFrame (boundsOfNode + rotation).
export function selectionWorldBounds(state: SceneState, selection: string[]): Bounds | null {
  const boxes: Bounds[] = [];
  for (const id of selection) {
    const n = state.nodes.at(id);
    if (!n) continue;
    const b = contentWorldBounds(state, n);
    if (b) boxes.push(b);
  }
  return unionBounds(boxes);
}

// Il FRAME della selezione: il rettangolo su cui vivono le maniglie PIÙ il suo
// angolo. La convenzione, che vale ovunque (overlay, hit-test, resize):
//
//  - UN nodo solo: il frame è il suo box NON ruotato con la SUA rotazione, così
//    le maniglie stanno sui suoi lati veri e il resize lavora nel suo spazio
//    locale (trascinare la maniglia e lo allarga lungo il proprio asse).
//  - PIÙ nodi: il frame è ASSE-ALLINEATO attorno a quello che i nodi occupano
//    davvero. Non esiste un angolo comune a nodi ruotati in modo diverso, e
//    inventarne uno (quello del primo? quello della media?) renderebbe il
//    resize di gruppo imprevedibile. I singoli nodi restano ruotati; è il
//    riquadro di gruppo a non esserlo.
export function selectionFrame(state: SceneState, selection: string[]): SelectionFrame | null {
  const nodes = selection.map((id) => state.nodes.at(id)).filter((n) => n !== undefined);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) {
    const n = nodes[0];
    // Un GRUPPO non ha box proprio: la cornice è l'unione dei figli VISIBILI
    // (contentWorldBounds, clip-aware), null quando non c'è niente da
    // incorniciare (gruppo vuoto o con tutti i figli nascosti) -- così l'overlay
    // non disegna cornice né maniglie su canvas vuoto.
    // Un'ISTANZA, come un gruppo, non ha box proprio: la cornice è quella del
    // contenuto del master (contentWorldBounds), asse-allineata -- la sua
    // rotazione propria è già cotta dentro quel box (store/groups.ts::
    // instanceContentBounds), quindi rotation 0 qui, come per un gruppo.
    if (isGroup(n) || isInstance(n)) {
      const b = contentWorldBounds(state, n);
      return b ? { bounds: b, rotation: 0 } : null;
    }
    // Un nodo qualunque: il suo box in MONDO NON ruotato (worldBoundsOfNode usa
    // la trasformazione del PARENT), e la sua rotazione a parte -- l'overlay gira
    // il frame attorno al centro. Per un figlio di pagina il box mondo coincide
    // col box del modello; per un nodo annidato no.
    return { bounds: worldBoundsOfNode(state, n), rotation: n.rotation };
  }
  const bounds = selectionWorldBounds(state, selection);
  return bounds ? { bounds, rotation: 0 } : null;
}

// Disegna il bbox della selezione, le sue 8 maniglie, il rettangolo del marquee
// e il path che il pen tool sta disegnando -- TUTTO in spazio SCHERMO (px CSS).
// A differenza di drawScene,
// qui NON si applica cam.zoom alla trasformazione del canvas: i bounds
// mondo vengono convertiti a mano via worldToScreen prima di disegnare, così
// bordi (1px) e maniglie (8px) restano di dimensione costante a ogni livello
// di zoom. L'unica trasformazione applicata è lo scale per devicePixelRatio,
// necessario perché il backing store del canvas è in pixel fisici.
//
// La ROTAZIONE del frame è l'eccezione, ed è applicata come in drawScene: al
// CONTESTO, attorno al centro del riquadro in px schermo. Il riquadro e i
// quadratini restano disegnati con la stessa identica geometria di prima --
// solo, girati con il nodo. La camera è una similitudine, quindi l'angolo
// mondo e l'angolo schermo coincidono e le maniglie NON si deformano con lo
// zoom. Il marquee resta fuori dalla trasformazione: è sempre asse-allineato.
// Le GUIDE di snap (in coordinate mondo, vedi selection/snap.ts) si disegnano
// per ultime e FUORI da qualunque rotazione del frame: una guida è per
// definizione una retta dello schermo -- è la retta su cui i bordi combaciano
// -- e girarla con il nodo la renderebbe una retta qualunque.
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  selection: string[],
  marquee: Bounds | null,
  guides: readonly SnapGuide[] = [],
  // Il path in corso del pen tool (store::penPreview). Opzionale perché è
  // ANTEPRIMA e non documento: chi non disegna non ne ha uno, e i chiamanti che
  // non conoscono il pen tool restano validi.
  pen: PenPreview | null = null,
): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { accent: ACCENT, guide: SNAP_GUIDE_COLOR } = themeColors();

  const frame = selectionFrame(state, selection);
  if (frame) {
    const box = worldBoundsToScreen(frame.bounds, cam);
    const rotated = frame.rotation % 360 !== 0;
    if (rotated) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(frame.rotation * DEG_TO_RAD);
      ctx.translate(-cx, -cy);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    // +0.5 così lo stroke da 1px cade su un confine di pixel netto invece di
    // sbavare su due righe (il classico trucco del canvas 2D).
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);

    const half = HANDLE_SIZE / 2;
    for (const p of Object.values(handlePositions(box))) {
      // Quadrato BIANCO con bordo d'accento e spigoli a 2px, su entrambi i temi:
      // le maniglie stanno sopra il design (che è chiaro anche in scuro), non
      // sopra l'interfaccia.
      roundedSquare(ctx, p.x - half, p.y - half, HANDLE_SIZE, "#ffffff", ACCENT);
    }
    // La MANIGLIA DI ROTAZIONE: un arco aperto appena FUORI da ogni angolo,
    // dentro la zona di presa che selection/handles.ts::hitTestFrame già
    // riconosce (stessa geometria, un'unica fonte -- vedi
    // rotateMarkerPositions). Non un quadratino: quello vuol dire "trascina per
    // ridimensionare", e qui non si ridimensiona niente. L'apertura guarda
    // verso il riquadro, così il segno "abbraccia" l'angolo che gira.
    const markers = rotateMarkerPositions(box);
    ctx.lineWidth = ROTATE_MARKER_WIDTH;
    ctx.strokeStyle = ACCENT;
    for (const id of CORNER_IDS) {
      const p = markers[id];
      const d = ROTATE_CORNER_DIRS[id];
      // Verso l'INTERNO: la direzione opposta alla diagonale uscente.
      const inward = Math.atan2(-d.y, -d.x);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ROTATE_MARKER_RADIUS, inward + ROTATE_ARC_GAP / 2, inward - ROTATE_ARC_GAP / 2 + TAU);
      ctx.stroke();
    }
    if (rotated) ctx.restore();
  }

  if (marquee) {
    const m = worldBoundsToScreen(marquee, cam);
    ctx.fillStyle = withAlpha(ACCENT, 0.08);
    ctx.fillRect(m.x, m.y, m.width, m.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.width, m.height);
  }

  if (guides.length > 0) {
    ctx.lineWidth = SNAP_GUIDE_WIDTH;
    ctx.strokeStyle = SNAP_GUIDE_COLOR;
    for (const g of guides) {
      // Gli estremi passano dalla camera come ogni altra coordinata: la retta
      // vive nel MONDO, il segmento sullo schermo. Il +0.5 sulla sola coordinata
      // costante è lo stesso trucco del riquadro (un tratto da 1px su un confine
      // di pixel netto invece che sbavato su due righe).
      const a = worldToScreen(cam, g.axis === "x" ? g.pos : g.from, g.axis === "x" ? g.from : g.pos);
      const b = worldToScreen(cam, g.axis === "x" ? g.pos : g.to, g.axis === "x" ? g.to : g.pos);
      ctx.beginPath();
      if (g.axis === "x") {
        ctx.moveTo(a.x + 0.5, a.y);
        ctx.lineTo(b.x + 0.5, b.y);
      } else {
        ctx.moveTo(a.x, a.y + 0.5);
        ctx.lineTo(b.x, b.y + 0.5);
      }
      ctx.stroke();
    }
  }

  // Per ultimo: il path in corso sta SOPRA la selezione (di solito non
  // coesistono -- il pen tool non seleziona finché non ha finito -- ma quando
  // succede è il disegno in corso a dover restare leggibile).
  if (pen) drawPenPreview(ctx, cam, pen);
}
