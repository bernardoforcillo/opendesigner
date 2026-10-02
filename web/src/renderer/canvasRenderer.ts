import type { SceneState, NodeLite, FillLite, StrokeLite, InstanceOverrideLite, EffectLite } from "../store/types";
import type { Camera } from "../canvas/camera";
import { type Bounds, boundsIntersect, boundsOfNode, inflateBounds, intersectBounds, worldVisualAabbOfNode } from "../canvas/geometry";
import {
  IDENTITY,
  applyTransform,
  compose,
  invertTransform,
  localTransformOf,
  mapBounds,
  type Transform,
} from "../canvas/transform";
import { sceneIndexOf } from "./sceneIndex";
import { contentWorldBounds } from "../store/groups";
import { instanceDescentLocal, instanceOverrideMap, resolveInstance } from "../store/instances";
import {
  nodePath, hitTestNode, inkIsBox, nodeCenter, vectorPaths, hasInk, selectionBoundsOfNode,
  VECTOR_FILL_RULE, VECTOR_STROKE_PX,
} from "./shapes";
import { drawText, strokeText } from "./text";
import { imageCache, type CachedImage } from "./imageCache";

const DEG_TO_RAD = Math.PI / 180;

// Esportata perché l'ORDINE DI DISEGNO non è solo un affare del canvas:
// l'export (export/region.ts) deve scegliere e ordinare i nodi esattamente
// come li sceglie e li ordina chi disegna, o l'immagine esportata non sarebbe
// quella che si vede.
export function sortedVisible(state: SceneState): NodeLite[] {
  return Object.values(state.nodes)
    .filter((n) => n.visible)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
}

// L'ALBERO, non più la mappa piatta.
//
// Le coordinate di un nodo sono relative al suo parent (vedi
// canvas/transform.ts), quindi il disegno non può più leggere x/y e piazzarli:
// deve SCENDERE, accumulando la trasformazione di ogni container. Da qui
// discendono, senza scelte in più, anche l'ordine e la visibilità:
//   - un container si disegna PRIMA dei suoi figli (sta dietro al proprio
//     contenuto), i fratelli in ordine di order key;
//   - un nodo irraggiungibile da una pagina non si disegna: non ha un posto
//     nel mondo (stessa regola di tree.ts::parentExists);
//   - un container invisibile porta via con sé tutto il sottoalbero -- non si
//     può disegnare il figlio di qualcosa che non c'è.
// L'hit-test fa lo stesso cammino al contrario, ed è l'unico modo perché ciò
// che si vede sia esattamente ciò che si clicca.
//
// Un indice figli-per-parent (store/tree.ts::childIndexOf) costruito una volta
// per chiamata invece di una childrenOf per nodo: quest'ultima è una scansione
// della mappa, e il renderer gira a ogni frame.
type ChildIndex = Map<string, NodeLite[]>;

// I nodi radice della PAGINA CORRENTE: i suoi figli diretti, in ordine di order
// key. Il canvas mostra UNA pagina alla volta, quindi disegno, hit-test e
// marquee scendono tutti da qui -- è l'unico punto in cui la scelta della
// pagina entra nel renderer, ed è ciò che tiene vedi-vs-seleziona in accordo (i
// tre condividono rootsOf, quindi non possono divergere sulla pagina).
//
// currentPageId è un PARAMETRO, non un campo della scena: la pagina corrente è
// stato di vista dello store (store.ts), e il renderer resta una funzione pura.
// Assente (o null) ripiega sulla PRIMA pagina -- il default dello store -- così
// le scene a pagina singola non hanno bisogno di dirlo.
function rootsOf(state: SceneState, children: ChildIndex, currentPageId?: string | null): NodeLite[] {
  const pageId = currentPageId ?? state.pages[0]?.id;
  return pageId !== undefined ? children.get(pageId) ?? [] : [];
}

// La tinta con cui un nodo viene effettivamente riempito, DEFAULT COMPRESO: un
// nodo senza tinte è grigio chiaro, e quel grigio è una decisione del renderer
// (come i default del testo in renderer/text.ts) che non sta nel modello.
// Esportata perché serve a chiunque debba riprodurre lo stesso riempimento
// altrove -- l'export SVG scrive `fill` in attributi separati e non in una
// stringa CSS, ma il default deve restare lo STESSO.
export function resolvedFill(n: NodeLite): FillLite {
  return n.fills[0] ?? { r: 0.8, g: 0.8, b: 0.8, a: 1 };
}

// Esportata perché il colore di un nodo serve anche FUORI dal canvas: il
// textarea di editing (ui/TextEditorOverlay.tsx) deve scrivere con lo stesso
// colore con cui il canvas disegnerà quel testo. Una seconda conversione
// RGBA-float -> CSS altrove sarebbe la solita coppia destinata a divergere.
export function cssColor(n: NodeLite): string {
  // resolvedFill (traccia 3, default grigio) + cssRgba (traccia 2, float->CSS):
  // il default vive in un posto solo, la conversione in un altro.
  return cssRgba(resolvedFill(n));
}

// RGBA float 0..1 -> stringa CSS. Una funzione sola per riempimenti e tratti:
// sono lo stesso Color nel proto, e due conversioni indipendenti divergerebbero
// al primo arrotondamento diverso.
export function cssRgba(c: FillLite): string {
  const to255 = (v: number) => Math.round(v * 255);
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${c.a})`;
}

// Lo stile canvas (colore CSS o CanvasGradient) di un riempimento sul box di
// `n`. Le coordinate normalizzate del gradiente si denormalizzano sul box NON
// ruotato: la rotazione del nodo è già nel contesto, quindi il gradiente ruota
// con la forma. Un gradiente degenere (asse o raggio nulli, meno di due stop)
// ripiega sul colore piatto, che è sempre valido.
export function paintStyle(ctx: CanvasRenderingContext2D, f: FillLite, n: NodeLite): string | CanvasGradient {
  const g = f.gradient;
  if (!g || g.stops.length < 2) return cssRgba(f);
  const x1 = n.x + g.x1 * n.width, y1 = n.y + g.y1 * n.height;
  const x2 = n.x + g.x2 * n.width, y2 = n.y + g.y2 * n.height;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0)) return cssRgba(f);
  const grad = g.kind === "linear"
    ? ctx.createLinearGradient(x1, y1, x2, y2)
    : ctx.createRadialGradient(x1, y1, 0, x1, y1, len);
  for (const st of g.stops) grad.addColorStop(Math.min(1, Math.max(0, st.position)), cssRgba(st.color));
  return grad;
}

// --- GLI EFFETTI ---------------------------------------------------------------
//
// Il canvas 2D ha UN solo stato di ombra e UN solo filtro, quindi il renderer
// disegna la PRIMA ombra e la PRIMA sfocatura di un nodo (il modello tiene
// l'intera lista). Offset e sfocatura sono in coordinate MONDO, ma shadow* e
// filter NON passano per la trasformazione del contesto: vanno scalati a mano
// per zoom * dpr, altrimenti l'ombra resterebbe di una taglia fissa mentre il
// nodo si ingrandisce.
type DropShadowLite = Extract<EffectLite, { kind: "dropShadow" }>;
type LayerBlurLite = Extract<EffectLite, { kind: "layerBlur" }>;

export function firstShadow(n: NodeLite): DropShadowLite | undefined {
  return n.effects?.find((e): e is DropShadowLite => e.kind === "dropShadow");
}
export function firstBlur(n: NodeLite): LayerBlurLite | undefined {
  return n.effects?.find((e): e is LayerBlurLite => e.kind === "layerBlur" && e.radius > 0);
}

// Pixel del backing store per unità mondo: zoom * dpr, letto dalla
// trasformazione che drawScene ha già messo sul contesto (la rotazione non la
// cambia). Leggerla da lì e non da window.devicePixelRatio è ciò che rende
// giusto anche l'export PNG, che disegna con dpr 1 su un canvas fuori schermo.
// Un contesto senza getTransform (i doppi dei test) ricade sullo zoom.
function deviceScale(ctx: CanvasRenderingContext2D, cam: Camera): number {
  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  return m ? Math.hypot(m.a, m.b) : cam.zoom;
}

// Imposta ombra e sfocatura sul contesto per il disegno del nodo. Ritorna true
// se ha fatto save(): chi chiama deve fare il restore corrispondente. Nessun
// effetto = nessun save, nessun costo.
function applyEffects(ctx: CanvasRenderingContext2D, n: NodeLite, scale: number): boolean {
  const shadow = firstShadow(n);
  const blur = firstBlur(n);
  if (!shadow && !blur) return false;
  ctx.save();
  if (shadow) {
    ctx.shadowColor = cssRgba(shadow.color);
    ctx.shadowOffsetX = shadow.offsetX * scale;
    ctx.shadowOffsetY = shadow.offsetY * scale;
    ctx.shadowBlur = Math.max(0, shadow.blur) * scale;
  }
  // `radius` è la deviazione standard della gaussiana, come in CSS blur().
  if (blur) ctx.filter = `blur(${blur.radius * scale}px)`;
  return true;
}

// La camera resta sempre in pixel CSS: il devicePixelRatio non deve mai
// entrare nel modello né nei tool, solo qui nel disegno effettivo sul canvas.
function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Allinea la risoluzione del backing store del canvas alla sua dimensione CSS
// * devicePixelRatio, per evitare il blur su schermi HiDPI. Ritorna true se la
// dimensione è cambiata (utile per evitare resize/clear superflui ogni frame).
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = devicePixelRatio();
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

// Opzioni di disegno. `dpr` esiste per un solo motivo: un canvas FUORI SCHERMO
// non ha un dispositivo. Quando si disegna per esportare (export/png.ts) la
// scala la sceglie l'utente (1x/2x/3x) e il devicePixelRatio della macchina non
// deve entrarci -- lo stesso documento esportato a 2x deve dare la stessa
// immagine su un portatile HiDPI e su un monitor esterno.
export interface DrawOptions {
  dpr?: number;
  // Da dove arrivano le immagini già decodificate. Il default è la cache
  // condivisa (renderer/imageCache.ts); si inietta nei test, dove non esiste
  // nessun caricamento vero.
  images?: ImageSource;
  // La pagina da disegnare (stato di vista dello store). Assente/null ripiega
  // sulla prima pagina -- vedi rootsOf. Sta qui insieme a dpr/images perché
  // drawScene ha un solo parametro d'opzioni: chi passa solo la pagina può
  // anche passarla come stringa nuda (vedi la firma di drawScene).
  currentPageId?: string | null;
}

/** Il minimo che il disegno chiede alla cache delle immagini. */
export interface ImageSource {
  get(docId: string, hash: string): CachedImage;
}

// I colori del SEGNAPOSTO -- un'immagine che non c'è (o non è ancora arrivata).
// Un nodo il cui asset manca deve VEDERSI: sparire vorrebbe dire un buco nel
// documento senza spiegazione, e lanciare vorrebbe dire spegnere il render loop
// per l'intera scena.
const PLACEHOLDER_FILL = "rgba(0, 0, 0, 0.06)";
const PLACEHOLDER_LINE = "rgba(0, 0, 0, 0.35)";

// Il segnaposto. Disegnato con fillRect/strokeRect/moveTo e NON con un Path2D:
// così resta l'unico ramo di drawScene interamente verificabile in questa suite
// (jsdom non ha Path2D), che è esattamente il ramo di cui conta di più sapere
// che non lancia.
//
// `px` è quanto vale UN pixel schermo in coordinate mondo: il ctx qui è già
// trasformato dalla camera, quindi una lineWidth costante sparirebbe a zoom
// basso e ingrasserebbe a zoom alto.
function drawImagePlaceholder(
  ctx: CanvasRenderingContext2D,
  n: NodeLite,
  px: number,
  missing: boolean,
): void {
  ctx.fillStyle = PLACEHOLDER_FILL;
  ctx.fillRect(n.x, n.y, n.width, n.height);
  ctx.strokeStyle = PLACEHOLDER_LINE;
  ctx.lineWidth = px;
  // Il bordo rientra di mezzo pixel per stare DENTRO il box: uno strokeRect sul
  // bordo esatto disegna metà tratto fuori, e l'immagine risulterebbe più grande
  // delle sue maniglie di selezione.
  ctx.strokeRect(n.x + px / 2, n.y + px / 2, n.width - px, n.height - px);
  // La croce distingue "l'asset non c'è" da "sta arrivando": senza, i due stati
  // sarebbero lo stesso rettangolo grigio e un'immagine persa sembrerebbe in
  // caricamento per sempre.
  if (!missing) return;
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(n.x + n.width, n.y + n.height);
  ctx.moveTo(n.x + n.width, n.y);
  ctx.lineTo(n.x, n.y + n.height);
  ctx.stroke();
}

// Un nodo immagine: i pixel se ci sono, il segnaposto altrimenti.
//
// L'immagine è tirata sul box del nodo (`drawImage` a quattro coordinate), non
// ritagliata né lettera-boxata: il box nasce dall'aspetto naturale del file
// (tools/imageDrop.ts) e da lì in poi ridimensionarlo è una scelta dell'utente,
// che deve vedere l'effetto che chiede. Le modalità "riempi/adatta" sono una
// funzione a parte, non un default da indovinare.
function drawImageNode(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  n: NodeLite,
  px: number,
  images: ImageSource,
): void {
  const entry = images.get(state.id, n.image?.assetHash ?? "");
  if (entry.status === "ready" && entry.image) {
    ctx.drawImage(entry.image, n.x, n.y, n.width, n.height);
    return;
  }
  drawImagePlaceholder(ctx, n, px, entry.status === "missing");
}

// Il quarto argomento è POLIMORFO: una DrawOptions (export/png.ts, i test delle
// immagini) OPPURE direttamente l'id della pagina corrente (ui/App.tsx, i test
// dell'annidamento). Sono la stessa informazione a due comodità diverse -- chi
// deve solo scegliere la pagina non vuole costruire un oggetto -- e drawScene le
// normalizza subito. null/assente = default dello store (prima pagina, cache
// condivisa, dpr del dispositivo).
export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  optsOrPageId?: DrawOptions | string | null,
): void {
  const opts: DrawOptions =
    typeof optsOrPageId === "string" ? { currentPageId: optsOrPageId } : optsOrPageId ?? {};
  const { canvas } = ctx;
  const dpr = opts.dpr ?? devicePixelRatio();
  const images = opts.images ?? imageCache;
  const currentPageId = opts.currentPageId ?? null;
  // Un pixel schermo in unità mondo, per i tratti che devono restare della
  // stessa grossezza a ogni zoom (oggi: il bordo del segnaposto).
  const px = 1 / (cam.zoom || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);
  const index = sceneIndexOf(state);
  const children = index.children;
  // La VISTA nel mondo, per saltare ciò che non si vede. Senza una misura valida
  // del canvas (i doppi dei test, un canvas non ancora dimensionato) non si
  // scarta niente: si disegna tutto, come prima.
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const cull: Cull | null =
    cssW > 0 && cssH > 0 && cam.zoom > 0
      ? {
          extent: index.extent,
          // Allargata di 2 px schermo: un tracciato di area nulla (il punto del pen
          // tool, un segmento orizzontale) ha un extent di misura zero e il
          // confronto fra rettangoli è rigoroso; lo stesso margine copre
          // l'antialiasing e i tratti a spessore costante sullo schermo.
          view: inflateBounds(
            { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: cssW / cam.zoom, height: cssH / cam.zoom },
            2 * px,
          ),
          px,
        }
      : null;
  drawSiblings(ctx, state, children, rootsOf(state, children, currentPageId), cam, px, images, new Set(), null, new Set(), cull);
  ctx.globalAlpha = 1;
}

// Cosa serve a drawSiblings per scartare i sottoalberi che non compaiono:
// l'extent MONDO di ogni nodo (renderer/sceneIndex.ts), la vista nel mondo e la
// dimensione di un pixel schermo in unità mondo.
interface Cull {
  extent: ReadonlyMap<string, Bounds>;
  view: Bounds;
  px: number;
}

// Sotto questa misura (px schermo) un intero sottoalbero non dipinge niente di
// visibile: lo si salta. Sotto LOD_FLAT_PX un SINGOLO nodo non vale più il suo
// disegno completo (percorso, tratto, gradiente, testo): diventa un rettangolo
// piatto del suo colore, che a quella taglia è indistinguibile.
const SKIP_SUBTREE_PX = 0.3;
const LOD_FLAT_PX = 4;
// Un frame ritagliante più piccolo di così (px schermo) non ritaglia: ciò che
// sporge di qualche pixel non si distingue, e creare un Path2D + clip per ogni
// frame costa più del resto del frame.
const CLIP_MIN_PX = 12;

// La mappa degli override che scende insieme al sottoalbero di un'istanza
// (masterNodeId -> override), oppure `null` fuori da ogni istanza (la pagina, il
// contenuto di un gruppo o di un frame normale). Vedi store/instances.ts.
type OverrideMap = ReadonlyMap<string, InstanceOverrideLite> | null;

// Il nodo del master COL SUO override applicato, se ce n'è uno: `fills`
// dell'override al posto dei suoi se presente, e -- per un testo -- il `text`
// dell'override al posto del suo contenuto se presente. Ritorna il nodo INTATTO
// quando non c'è override (nessuna copia inutile). Non tocca mai la geometria
// (x/y/width/height/rotation): un override cambia solo ciò che il nodo dipinge,
// non dove sta -- la stessa scelta dei bounds in store/groups.ts.
function withOverride(n: NodeLite, ov: InstanceOverrideLite | undefined): NodeLite {
  if (!ov) return n;
  let eff = n;
  if (ov.fills !== undefined) eff = { ...eff, fills: ov.fills };
  if (ov.text !== undefined && eff.text) eff = { ...eff, text: { ...eff.text, content: ov.text } };
  return eff;
}

// Disegna una lista di fratelli (già ordinata) nello spazio CORRENTE del ctx,
// scendendo in ognuno.
//
// Ricorsione e non pila esplicita come tree.ts::subtreeOf: qui la discesa è
// ACCOPPIATA a save/restore del ctx, e una pila esplicita dovrebbe ricostruire a
// mano proprio quell'accoppiamento. `seen` rende comunque la profondità limitata
// dal NUMERO di nodi -- un ciclo in un documento malformato non può far scendere
// all'infinito.
function drawSiblings(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  children: ChildIndex,
  siblings: NodeLite[],
  cam: Camera,
  px: number,
  images: ImageSource,
  seen: Set<string>,
  overrides: OverrideMap,
  visited: ReadonlySet<string>,
  cull: Cull | null,
): void {
  for (const n of siblings) {
    if (!n.visible || seen.has(n.id)) continue;
    // Fuori vista, o troppo piccolo per vedersi: salta l'INTERO sottoalbero.
    // `cull` è null dentro un'istanza -- i nodi del master hanno l'extent nel
    // loro posto d'origine, non dove l'istanza li disegna.
    if (cull) {
      const e = cull.extent.get(n.id);
      if (!e || !boundsIntersect(e, cull.view)) continue;
      // Un vettoriale non si scarta per misura: ha tratto a spessore costante sullo
      // schermo e può avere box nullo (un punto), ma si vede comunque.
      if (n.kind !== "vector" && e.width / cull.px < SKIP_SUBTREE_PX && e.height / cull.px < SKIP_SUBTREE_PX) continue;
    }
    seen.add(n.id);
    drawNode(ctx, state, n, cam, px, images, overrides);
    // Un'ISTANZA non ha figli in `children` (il suo sottoalbero è virtuale):
    // disegna il master sotto la trasformazione di discesa, con i PROPRI
    // override, e senza scendere oltre qui. drawNode ha già saltato il suo box.
    if (n.kind === "instance") {
      drawInstance(ctx, state, children, n, cam, px, images, visited);
      continue;
    }
    const kids = children.get(n.id);
    if (!kids || kids.length === 0) continue;
    // Il container entra nella trasformazione SOLO per i figli: le sue
    // coordinate proprie (e la sua rotazione) sono già state usate qui sopra,
    // nello spazio del suo parent. save/restore invece di applicare l'inversa a
    // mano: il ctx sa già annullare esattamente ciò che gli è stato composto.
    // localTransformOf include ORA anche la rotazione del nodo (transform.ts),
    // quindi i figli di un container ruotato ruotano con lui.
    ctx.save();
    const t = localTransformOf(n);
    ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
    // Un FRAME con clipsContent ritaglia i figli al PROPRIO box. Il clip sta
    // qui, DENTRO il save/restore e DOPO la trasformazione: è quindi nello
    // spazio locale dei figli, dove il box del frame è (0,0,width,height) --
    // l'origine del frame è l'origine dei figli. È lo STESSO ritaglio che pickIn
    // applica al punto e collectIn alla banda (via intersectBounds): vedi-vs-
    // seleziona, ciò che il clip nasconde al disegno non si clicca e il marquee
    // non lo prende. Un frame senza clipsContent lascia sporgere i figli.
    if (n.kind === "frame" && n.clipsContent && Math.max(n.width, n.height) / px >= CLIP_MIN_PX) {
      const clip = new Path2D();
      clip.rect(0, 0, n.width, n.height);
      ctx.clip(clip);
    }
    drawSiblings(ctx, state, children, kids, cam, px, images, seen, overrides, visited, cull);
    ctx.restore();
  }
}

// Il sottoalbero VIRTUALE di un'istanza. Come per un container normale il
// contenuto entra nella trasformazione dentro un save/restore, ma la matrice è
// quella di DISCESA (instanceDescentLocal: posizione dell'istanza più lo
// scostamento che porta l'origine del master all'origine dell'istanza), e i
// "fratelli" sono la sola radice del master -- da lì la ricorsione di
// drawSiblings scende il resto come per qualunque albero.
//
// `visited` sono i componentId già in corso di rendering su questo ramo: se il
// componente dell'istanza è già dentro, ci si ferma (un componente il cui master
// contiene un'istanza di sé stesso ricorrerebbe all'infinito). Un `seen` FRESCO
// per il master, non quello della pagina: lo stesso componente reso da due
// istanze deve disegnarsi due volte, e col `seen` condiviso la seconda lo
// salterebbe come "già visto".
function drawInstance(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  children: ChildIndex,
  n: NodeLite,
  cam: Camera,
  px: number,
  images: ImageSource,
  visited: ReadonlySet<string>,
): void {
  if (!n.instance || visited.has(n.instance.componentId)) return;
  const resolved = resolveInstance(state, n);
  if (!resolved) return;
  const nextVisited = new Set(visited).add(n.instance.componentId);
  const overrides = instanceOverrideMap(n);
  ctx.save();
  const t = instanceDescentLocal(n, resolved.masterRoot);
  ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
  drawSiblings(ctx, state, children, [resolved.masterRoot], cam, px, images, new Set(), overrides, nextVisited, null);
  ctx.restore();
}

// Il nodo e basta, nello spazio del suo parent (che è quello corrente del ctx).
// Il corpo PER NODO delle quattro tracce: guard sulla dimensione (shapes.ts::
// inkIsBox), rotazione del CONTESTO attorno al centro (traccia 2), e l'if-chain
// testo/immagine/vettoriale/forma con i rispettivi tratti (tracce 2/3/4).
function drawNode(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  n: NodeLite,
  cam: Camera,
  px: number,
  images: ImageSource,
  overrides: OverrideMap,
): void {
  // Un GRUPPO non si disegna: contenitore senza geometria propria (i suoi
  // bounds sono l'unione dei figli, store/groups.ts) e ciò che si vede sono i
  // figli. Esplicito e non affidato al guard sulla dimensione: un gruppo con
  // width/height != 0 -- scritti da chi non lo sa, o da un documento di un'altra
  // versione -- comparirebbe come un rettangolo pieno mai disegnato dall'utente.
  // Un'ISTANZA non si disegna qui per la stessa ragione: non ha un box proprio,
  // il suo contenuto è il master (drawInstance lo disegna dopo questa chiamata).
  if (n.kind === "group" || n.kind === "instance") return;
  // Il nodo COL SUO override, se sta scendendo dentro un'istanza che lo
  // sovrascrive: da qui in poi si disegna `eff`, non `n`. L'override tocca solo
  // fills/text -- la geometria (box, rotazione) resta quella del master, quindi
  // i guard e i centri di rotazione qui sotto sono identici con o senza.
  const eff = withOverride(n, overrides?.get(n.id));
  // Il guard sulla dimensione vale solo per le forme il cui inchiostro È il box
  // (rect, ellisse, immagine, frame): per testo e vettoriale un lato a zero è
  // uno stato legittimo e disegnabile. L'elenco delle eccezioni sta in UN posto
  // solo (shapes.ts::inkIsBox), condiviso con l'hit-test: un nodo che si disegna
  // ma non si clicca -- o il contrario -- è il modo in cui i due divergono.
  if (inkIsBox(eff) && (eff.width <= 0 || eff.height <= 0)) return;
  // LIVELLO DI DETTAGLIO: a pochi pixel un nodo non ha più forma, tratto o
  // testo da distinguere. Un rettangolo piatto del suo colore costa una frazione
  // del disegno completo, ed è ciò che permette di inquadrare un documento
  // intero senza pagare ogni nodo come se fosse a grandezza naturale. Il
  // vettoriale resta fuori (un path di un ancoraggio ha misura zero e si vede
  // comunque), e il testo conta in corpo del carattere, non in box.
  const flatSize = eff.kind === "text" ? (eff.text?.style.fontSize || 16) : Math.max(eff.width, eff.height);
  if (eff.kind !== "vector" && flatSize / px < LOD_FLAT_PX) {
    if (eff.kind === "frame" && eff.fills.length === 0) return;
    ctx.globalAlpha = eff.kind === "text" ? eff.opacity * 0.5 : eff.opacity;
    ctx.fillStyle = cssColor(eff);
    ctx.fillRect(eff.x, eff.y, eff.width, eff.height);
    return;
  }
  // ROTAZIONE (traccia 2): è il CONTESTO a ruotare attorno al centro del box
  // (nodeCenter, la stessa funzione che l'hit-test usa nel verso opposto), non
  // la geometria -- nodePath e drawText restano asse-allineati. Il nodo si
  // disegna nello spazio del proprio parent (quello corrente del ctx); questa
  // rotazione è la SUA, distinta da quella che drawSiblings applica scendendo
  // nei suoi figli. save/restore SOLO quando serve.
  const rotated = eff.rotation % 360 !== 0;
  if (rotated) {
    const c = nodeCenter(eff);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(eff.rotation * DEG_TO_RAD);
    ctx.translate(-c.x, -c.y);
  }
  ctx.globalAlpha = eff.opacity;
  const color = cssColor(eff);
  ctx.fillStyle = paintStyle(ctx, resolvedFill(eff), eff);
  // Gli effetti valgono per tutto ciò che il nodo disegna sotto: forma, testo,
  // immagine, vettoriale.
  const fx = applyEffects(ctx, eff, deviceScale(ctx, cam));
  if (eff.kind === "text") {
    drawText(ctx, eff);
    drawStrokes(ctx, eff, null);
  } else if (eff.kind === "image") {
    // Un'immagine disegna sé stessa sul proprio box (traccia 3): niente
    // riempimento sotto, e il tratto non fa parte del suo design.
    drawImageNode(ctx, state, eff, px, images);
  } else if (eff.kind === "vector") {
    // Il vettoriale ha la sua doppia passata (riempimento even-odd + tratto di
    // ogni contorno): NON è il box del modello, quindi non passa dal ramo
    // rettangolo qui sotto. Il tratto vettoriale è quello di drawVector, non
    // drawStrokes (che è per il perimetro di un box).
    drawVector(ctx, eff, color, cam.zoom);
  } else {
    // rect / ellisse / FRAME. Un frame si disegna come un rettangolo coi suoi
    // fills (nodePath lo tiene a spigoli vivi anche con un cornerRadius), dietro
    // al proprio contenuto -- drawNode gira PRIMA della discesa nei figli. UN
    // SOLO Path2D per nodo: quello del riempimento è anche quello del tratto.
    const path = nodePath(eff);
    // Un FRAME senza riempimento è trasparente: è un contenitore, e il grigio di
    // default (resolvedFill) è per le forme. Senza questa eccezione un frame
    // appena avvolto attorno a una selezione la nasconderebbe sotto un
    // rettangolo grigio.
    if (!(eff.kind === "frame" && eff.fills.length === 0)) ctx.fill(path);
    // Con un riempimento visibile l'ombra l'ha già data lui: ridarla dal tratto
    // sovrapporrebbe due ombre sul bordo e lo scurirebbe.
    if (fx && eff.fills.length > 0) ctx.shadowColor = "transparent";
    drawStrokes(ctx, eff, path);
  }
  if (fx) ctx.restore();
  if (rotated) ctx.restore();
}

// --- IL TRATTO ----------------------------------------------------------------
//
// Il canvas 2D traccia SOLO centrato sul path: `lineWidth` si spartisce metà
// dentro e metà fuori, e non esiste nessuna proprietà di allineamento. Le altre
// due ricette si ottengono raddoppiando la larghezza -- così la metà che
// sopravvive è ESATTAMENTE il peso chiesto -- e ritagliando il lato di troppo:
//
//   INSIDE   clip(path)                  -> resta la metà interna
//   OUTSIDE  clip(complemento, evenodd)  -> resta la metà esterna
//
// È la tecnica standard, ed è esatta (non un'approssimazione) per le forme
// SEMPLICI che il progetto disegna: rettangolo, rettangolo stondato, ellisse.
//
// Il TESTO fa storia a sé: un glifo un Path2D non ce l'ha (il canvas 2D non
// espone il contorno del testo), quindi il suo tratto è sempre centrato --
// l'approssimazione è dichiarata in renderer/text.ts::strokeText, e
// canvas/geometry.ts::strokeOutsetOfNode conta la sporgenza con la stessa
// regola, così misura e disegno restano la stessa cosa.
function drawStrokes(ctx: CanvasRenderingContext2D, n: NodeLite, path: Path2D | null): void {
  for (const s of n.strokes) {
    // Un peso non positivo NON è un tratto sottilissimo: non è un tratto. Il
    // canvas con lineWidth 0 non disegna nulla, e i bounds non contano nessuna
    // sporgenza (canvas/geometry.ts::strokeOutset) -- le due cose devono
    // saltare lo stesso tratto.
    if (!(s.weight > 0)) continue;
    ctx.strokeStyle = paintStyle(ctx, s.color, n);
    if (path === null) {
      ctx.lineWidth = s.weight;
      strokeText(ctx, n);
      continue;
    }
    strokeShape(ctx, n, path, s);
  }
}

function strokeShape(ctx: CanvasRenderingContext2D, n: NodeLite, path: Path2D, s: StrokeLite): void {
  if (s.align === "center") {
    ctx.lineWidth = s.weight;
    ctx.stroke(path);
    return;
  }
  ctx.save();
  if (s.align === "inside") ctx.clip(path);
  else ctx.clip(outsideClip(n, path, s.weight), "evenodd");
  ctx.lineWidth = s.weight * 2;
  ctx.stroke(path);
  ctx.restore();
}

// Il COMPLEMENTO della forma, come regione di ritaglio: un rettangolo che
// copre tutta la fascia esterna PIÙ il path della forma, valutati con evenodd.
// Un punto dentro la forma attraversa due bordi (pari) e resta quindi FUORI
// dalla regione; uno nella fascia ne attraversa uno solo (dispari) e ci resta
// dentro. Nessun path da invertire, e la forma è la stessa del riempimento.
const OUTSIDE_CLIP_MARGIN = 1;

function outsideClip(n: NodeLite, path: Path2D, weight: number): Path2D {
  const b = inflateBounds(boundsOfNode(n), weight + OUTSIDE_CLIP_MARGIN);
  const clip = new Path2D();
  clip.rect(b.x, b.y, b.width, b.height);
  clip.addPath(path);
  return clip;
}

// Un nodo vettoriale in DUE passate: OGNI contorno si traccia, e in più quelli
// che hanno area si riempiono. Il tratto non è decorazione -- è ciò che tiene
// visibile un contorno aperto e un contorno chiuso di area nulla (due
// ancoraggi, o tre allineati: due stati che il pen tool raggiunge in tre click,
// e che il solo riempimento non dipingerebbe affatto).
//
// I due Path2D sono separati perché un contorno aperto messo in quello del
// riempimento verrebbe chiuso implicitamente dal canvas e riempito -- ed è per
// questo che vectorPaths ne restituisce due.
function drawVector(ctx: CanvasRenderingContext2D, n: NodeLite, color: string, zoom: number): void {
  const { fill, stroke } = vectorPaths(n);
  // La regola even-odd è una SCELTA (motivata su shapes.ts::VECTOR_FILL_RULE)
  // e non il default del canvas, quindi va passata a ogni fill. È la stessa
  // che usa l'hit-test: un buco che si vede ma si clicca sarebbe la firma di
  // due regole diverse.
  if (fill) ctx.fill(fill, VECTOR_FILL_RULE);
  if (stroke) {
    ctx.strokeStyle = color;
    // Il ctx è in trasformazione MONDO (drawScene applica zoom * dpr), quindi
    // uno spessore costante sullo schermo si ottiene dividendo per lo zoom --
    // il dpr si cura da sé, essendo nella stessa matrice. Senza, la linea di un
    // path si ingrasserebbe insieme al disegno e a zoom 64 sarebbe una banda.
    ctx.lineWidth = VECTOR_STROKE_PX / zoom;
    // Giunti e capi tondi: sono anche ciò che rende visibile un contorno di UN
    // solo ancoraggio, che shapes.ts traccia come un segmento di lunghezza
    // nulla (il pallino del pen tool dopo il primo click).
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(stroke);
  }
}

// hitTest in coordinate MONDO. Ritorna il nodo più in alto -- il PIÙ INTERNO
// dove i sottoalberi si sovrappongono, perché un figlio si disegna sopra il
// proprio container. Chi selezionerà il GRUPPO invece del figlio (il click
// seleziona il gruppo, il doppio click entra) risale da qui con l'albero: è
// una politica di selezione, non di hit-test, e non va nascosta qui dentro.
//
// Porta ENTRAMBE le informazioni delle tracce parallele: `zoom` (traccia 4)
// arriva fino a hitTestNode perché la presa attorno a un contorno vettoriale
// APERTO è in px SCHERMO (shapes.ts::VECTOR_HIT_PX); `currentPageId` (traccia 1)
// sceglie la pagina da cui scendere -- lo stesso scoping di drawScene, così ciò
// che si vede è ciò che si clicca.
export function hitTest(
  state: SceneState,
  wx: number,
  wy: number,
  zoom: number,
  currentPageId?: string | null,
): string | null {
  const index = sceneIndexOf(state);
  const children = index.children;
  // Il punto MONDO e la tolleranza (la presa attorno a un tracciato aperto è in
  // px schermo, vedi shapes.ts::VECTOR_HIT_PX): servono a saltare i sottoalberi
  // il cui extent non può contenerlo.
  const prune: Prune = { extent: index.extent, x: wx, y: wy, pad: HIT_PRUNE_PX / (zoom || 1) };
  return pickIn(state, children, rootsOf(state, children, currentPageId), wx, wy, zoom, new Set(), new Set(), prune);
}

// Lo STESSO cammino di drawSiblings, al contrario: fratelli dall'ultimo al
// primo (l'ultimo è il più in alto) e, dentro ognuno, prima il sottoalbero e
// poi il nodo stesso.
//
// (px, py) è il punto nello spazio LOCALE di questi fratelli, cioè quello in
// cui sono scritte le loro coordinate: è lì che hitTestNode li confronta. Per
// scendere in un container si applica al punto l'INVERSA della trasformazione
// che il renderer applica al ctx -- la stessa localTransformOf (rotazione
// inclusa), letta nell'altro verso.
// Come Cull, per l'hit-test: il punto nel MONDO (px/py di pickIn sono nello spazio
// LOCALE dei fratelli e cambiano a ogni discesa) e la tolleranza in unità mondo.
// `null` dentro un'istanza, per la stessa ragione di drawSiblings.
interface Prune {
  extent: ReadonlyMap<string, Bounds>;
  x: number;
  y: number;
  pad: number;
}
// Margine con cui si prova un sottoalbero prima di scartarlo (px schermo): copre
// la presa attorno ai tracciati aperti e ciò che un extent stimato può mancare.
const HIT_PRUNE_PX = 12;

function pickIn(
  state: SceneState,
  children: ChildIndex,
  siblings: NodeLite[],
  px: number,
  py: number,
  zoom: number,
  seen: Set<string>,
  visited: ReadonlySet<string>,
  prune: Prune | null,
): string | null {
  for (let i = siblings.length - 1; i >= 0; i--) {
    const n = siblings[i];
    if (!n.visible || seen.has(n.id)) continue;
    if (prune && n.kind !== "instance") {
      const e = prune.extent.get(n.id);
      if (!e || prune.x < e.x - prune.pad || prune.x > e.x + e.width + prune.pad ||
          prune.y < e.y - prune.pad || prune.y > e.y + e.height + prune.pad) continue;
    }
    seen.add(n.id);
    // Un'ISTANZA è OPACA alla selezione dall'esterno: si scende nel master (col
    // punto portato nello spazio del master dall'inversa della discesa) e, se
    // qualcosa lì viene colpito, la risposta è l'ISTANZA -- mai un nodo del
    // master, che dall'esterno non è selezionabile per conto suo. Se non colpisce
    // niente, `continue`: un'istanza non ha un box proprio da colpire (come un
    // gruppo), quindi non ruba il click a ciò che le sta sotto.
    if (n.kind === "instance") {
      if (hitInstance(state, children, n, px, py, zoom, visited)) return n.id;
      continue;
    }
    const kids = children.get(n.id);
    if (kids && kids.length > 0) {
      const inner = applyTransform(invertTransform(localTransformOf(n)), px, py);
      // Un FRAME con clipsContent nasconde i figli fuori dal proprio box: se il
      // punto (già nello spazio locale del frame, dove il box è
      // (0,0,width,height)) cade fuori, quei figli sono ritagliati via -- non si
      // disegnano lì (drawSiblings) e non si devono cliccare. Stessa geometria,
      // stesso risultato: vedi-vs-seleziona. Il frame stesso resta colpibile sul
      // suo box (hitTestNode qui sotto). Senza clip la discesa è come sempre.
      const clipsAway =
        n.kind === "frame" && n.clipsContent &&
        !(inner.x >= 0 && inner.x <= n.width && inner.y >= 0 && inner.y <= n.height);
      if (!clipsAway) {
        const hit = pickIn(state, children, kids, inner.x, inner.y, zoom, seen, visited, prune);
        if (hit) return hit;
      }
    }
    if (hitTestNode(n, px, py, zoom)) return n.id;
  }
  return null;
}

// L'hit-test del sottoalbero VIRTUALE di un'istanza: porta il punto nello spazio
// del master (inversa della trasformazione di discesa) e lo prova sul master;
// `true` se COLPISCE qualcosa lì dentro -- il chiamante ritorna allora l'id
// DELL'ISTANZA, non del nodo del master colpito. `visited` e il `seen` fresco
// come in drawInstance: il ciclo di un componente auto-referenziale si ferma, e
// lo stesso master colpito da due istanze non si "auto-esclude".
function hitInstance(
  state: SceneState,
  children: ChildIndex,
  n: NodeLite,
  px: number,
  py: number,
  zoom: number,
  visited: ReadonlySet<string>,
): boolean {
  if (!n.instance || visited.has(n.instance.componentId)) return false;
  const resolved = resolveInstance(state, n);
  if (!resolved) return false;
  const inner = applyTransform(invertTransform(instanceDescentLocal(n, resolved.masterRoot)), px, py);
  const nextVisited = new Set(visited).add(n.instance.componentId);
  return pickIn(state, children, [resolved.masterRoot], inner.x, inner.y, zoom, new Set(), nextVisited, null) !== null;
}

// I nodi il cui box MONDO interseca `bounds`, in ordine di DISEGNO. È la
// domanda del marquee ("cosa c'è dentro questo rettangolo"), e sta qui insieme
// a drawScene/hitTest perché deve rispondere con gli STESSI nodi: un marquee
// che seleziona ciò che il renderer non disegna è la stessa divergenza
// vedi-vs-clicca che l'hit-test evita, solo presa dall'altro lato.
// Quindi la stessa discesa: si parte dai figli delle pagine (chi non è
// raggiungibile non ha un posto nel mondo) e un container invisibile porta via
// con sé tutto il sottoalbero.
//
// A differenza di pickIn qui si accumula la trasformazione ANDANDO (locale ->
// mondo) invece di invertirla: il rettangolo del marquee è uno solo e sta nel
// mondo, mentre i box da confrontare sono uno per nodo.
//
// Come hitTest, non risponde MAI con un gruppo (vedi collectIn): risponde con
// ciò che si vede, e a risalire ai gruppi è la politica di selezione.
export function nodesIntersecting(state: SceneState, bounds: Bounds, currentPageId?: string | null): string[] {
  const index = sceneIndexOf(state);
  const children = index.children;
  const out: string[] = [];
  // Il marquee afferra anche ciò che sta vicino (la banda si allarga sui tracciati
  // degeneri, selectionBoundsOfNode): si prova con un margine prima di scartare.
  const probe = inflateBounds(bounds, MARQUEE_PRUNE_PAD);
  collectIn(state, children, rootsOf(state, children, currentPageId), IDENTITY, bounds, out, new Set(), { extent: index.extent, probe });
  return out;
}

// `toWorld` porta al mondo lo spazio in cui sono scritte le coordinate di
// QUESTI fratelli, cioè quello del loro parent (identità per i figli di una
// pagina): la stessa direzione dell'avvertenza su worldTransformOf.
//
// La discesa non si pota quando il box di un container manca il marquee: un
// gruppo non contiene per forza i propri figli (il suo box è il suo, non
// l'unione), quindi un figlio dentro il marquee resterebbe fuori dalla
// selezione. Si salta solo ciò che non si vede.
const MARQUEE_PRUNE_PAD = 16;

function collectIn(
  state: SceneState,
  children: ChildIndex,
  siblings: NodeLite[],
  toWorld: Transform,
  bounds: Bounds,
  out: string[],
  seen: Set<string>,
  prune: { extent: ReadonlyMap<string, Bounds>; probe: Bounds } | null,
): void {
  for (const n of siblings) {
    if (!n.visible || seen.has(n.id)) continue;
    // Il sottoalbero il cui extent non tocca nemmeno la banda allargata non ha
    // niente da offrire. Non dentro un'istanza (extent al posto d'origine) e non
    // per un'istanza stessa, che ha i suoi bounds derivati qui sotto. `probe` è
    // la banda ORIGINALE dentro un frame ritagliante? No: l'extent di un frame
    // ritagliante è già ristretto al suo box, quindi il confronto resta valido.
    if (prune && n.kind !== "instance") {
      const e = prune.extent.get(n.id);
      if (!e || !boundsIntersect(e, prune.probe)) continue;
    }
    seen.add(n.id);
    // Un'ISTANZA entra nel marquee sui suoi bounds DERIVATI (il sottoalbero del
    // master mappato dalla discesa, store/groups.ts::contentWorldBounds -- la
    // stessa cornice che l'overlay disegna): niente discesa nel master (i suoi
    // figli non sono selezionabili dall'esterno), si aggiunge l'istanza e basta.
    // Un master mancante non ha bounds e non entra, come non si disegna e non si
    // colpisce. La guardia ai cicli è dentro contentWorldBounds.
    if (n.kind === "instance") {
      const b = contentWorldBounds(state, n);
      if (b && boundsIntersect(b, bounds)) out.push(n.id);
      continue;
    }
    // Il box su cui il MARQUEE afferra il nodo è quello VISUALE, non il box
    // grezzo del modello (traccia 2/4): worldVisualAabbOfNode per le forme il cui
    // inchiostro È il box -- rotazione inclusa e sporgenza del tratto compresa --
    // e selectionBoundsOfNode per il vettoriale, che allarga il solo asse
    // degenere (un segmento orizzontale, un path di un ancoraggio) così un
    // marquee che ci passa accanto lo prende comunque. `hasInk` tiene fuori un
    // vettoriale senza NESSUN ancoraggio: non si vede e non si clicca, quindi non
    // deve nemmeno finire in un marquee. Un GRUPPO non entra MAI per conto suo,
    // come non si disegna (drawNode) e non si colpisce (hitTestNode): a
    // selezionarlo ci pensa la POLITICA (store/groups.ts), che risale ai gruppi
    // dai FIGLI presi qui sotto.
    if (n.kind !== "group" && hasInk(n)) {
      const visual = n.kind === "vector" ? selectionBoundsOfNode(n) : worldVisualAabbOfNode(n);
      if (boundsIntersect(mapBounds(toWorld, visual), bounds)) out.push(n.id);
    }
    const kids = children.get(n.id);
    if (!kids || kids.length === 0) continue;
    // Il clip di un FRAME con clipsContent usa il box del MODELLO (non il
    // visuale): è il box a cui ritaglia, e restringe la banda al proprio box
    // MONDO prima di scendere -- i figli contano solo per la parte che si VEDE
    // dentro il frame, come il disegno li ritaglia (drawSiblings) e l'hit-test li
    // nasconde (pickIn). intersectBounds torna null quando la banda non tocca
    // affatto il box del frame.
    const frameBox = mapBounds(toWorld, boundsOfNode(n));
    let childBounds: Bounds | null = bounds;
    if (n.kind === "frame" && n.clipsContent) {
      childBounds = intersectBounds(bounds, frameBox);
      if (!childBounds) continue;
    }
    collectIn(state, children, kids, compose(toWorld, localTransformOf(n)), childBounds, out, seen, prune);
  }
}
