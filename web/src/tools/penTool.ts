import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { normalizeVector } from "../store/vectorGeometry";
import type { PenPreview, PointLite } from "../store/vectorGeometry";
import { toPbFills, toPbSubPaths } from "../store/types";
import type { AnchorLite, FillLite } from "../store/types";
import { PEN_ANCHOR_GRAB_PX } from "../renderer/overlayRenderer";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext } from "./types";

// IL PEN TOOL.
//
// Ha più fasi di qualunque altro strumento di questo editor, e per questo è
// scritto come una MACCHINA A STATI ESPLICITA -- un nome più i suoi dati -- e
// non come una manciata di booleani ("sto trascinando", "ho già cliccato",
// "sto chiudendo"). La differenza non è di stile: con i booleani gli stati
// impossibili sono rappresentabili (trascinando E chiudendo E senza ancoraggi)
// e ogni handler deve ricordarsi di controllarli tutti; con il tipo qui sotto
// un caso mancante è un errore di compilazione e l'insieme delle transizioni si
// legge in un posto solo.
//
// La macchina (penReduce) è PURA: niente store, niente camera, niente DOM.
// Riceve punti già in coordinate MONDO e tolleranze già in unità mondo, e
// ritorna lo stato nuovo più l'EFFETTO che il chiamante deve produrre. Tutto
// l'I/O -- aprire il gesto, creare il nodo, pubblicare l'anteprima -- vive
// nell'adattatore (createPenTool) qui sotto. Così le regole del disegno si
// provano come una tabella di transizioni, senza doppi.

// Sotto questa soglia (px SCHERMO, quindi indipendente dallo zoom) un gesto è
// un CLICK e posa un ancoraggio d'angolo; sopra è un TRASCINAMENTO e tira le
// maniglie. Stesso valore e stessa ragione di shapeTool.ts/textTool.ts: senza,
// a zoom alto un tremolio di mezzo pixel regalerebbe a ogni click una maniglia
// microscopica che nessuno ha chiesto.
export const PEN_CLICK_SLOP_PX = 3;

// La tinta con cui nasce un path. Esplicita e non il grigio 0.6 delle forme
// (shapeTool.ts): un contorno APERTO non ha area, esiste sullo schermo solo
// come tratto da 1.5px (renderer/shapes.ts::VECTOR_STROKE_PX) e prende il
// proprio colore dal riempimento del nodo -- il grigio pensato per un'area
// piena, ridotto a un capello su fondo bianco, sarebbe quasi invisibile. Stessa
// scelta (e stessa ragione) del nero di textTool.ts.
export const PEN_FILL: FillLite = { r: 0.15, g: 0.15, b: 0.2, a: 1 };

// --- la macchina a stati -----------------------------------------------------

// Quale maniglia sta tirando il trascinamento in corso:
//  - "new"   l'ancoraggio è stato appena posato: il trascinamento tira le sue
//            DUE maniglie in modo simmetrico (l'ancoraggio morbido standard);
//  - "close" il pointerdown è caduto sul PRIMO ancoraggio: al rilascio il
//            contorno si chiude, e il trascinamento tira la sola maniglia
//            ENTRANTE -- quella del segmento di ritorno. L'uscente resta com'è:
//            disegna il PRIMO segmento, deciso all'inizio, e deformarlo
//            all'indietro sarebbe una modifica che l'utente non ha chiesto.
export type PenGrip = "new" | "close";

export type PenState =
  // Nessun ancoraggio posato: nessun gesto aperto, niente da annullare.
  | { readonly name: "idle" }
  // Pulsante PREMUTO su un ancoraggio: finché non si rilascia, il cursore ne
  // definisce le maniglie. `base` è l'ancoraggio com'era al pointerdown, ed è
  // da lui che le maniglie si ricalcolano a ogni move -- mai dall'ultimo
  // valore, che sarebbe un accumulo. È anche il punto da cui si misura il
  // trascinamento: l'ANCORAGGIO, non il pixel cliccato (un click 2px fuori
  // centro sul primo ancoraggio non deve regalare una maniglia).
  | {
      readonly name: "placing";
      readonly anchors: readonly AnchorLite[];
      readonly grip: PenGrip;
      readonly base: AnchorLite;
    }
  // Pulsante rilasciato, path in corso: il prossimo click posa un ancoraggio (o
  // chiude, se cade sul primo). `cursor` è dove cadrebbe: l'overlay ci disegna
  // il segmento che segue il puntatore.
  | {
      readonly name: "drawing";
      readonly anchors: readonly AnchorLite[];
      readonly cursor: PointLite;
    };

// Riferimento CONDIVISO e non un oggetto nuovo a ogni transizione: è così che
// l'adattatore riconosce "niente è cambiato" con un `!==` e non riscrive
// l'anteprima nello store a ogni pointermove a mano alzata.
export const PEN_IDLE: PenState = { name: "idle" };

// Gli eventi della macchina. `grab` e `slop` arrivano già in unità MONDO: la
// conversione dai px SCHERMO la fa l'adattatore, che è l'unico che conosce la
// camera (regola del progetto: la trasformazione non si ricalcola a mano, e chi
// non ha bisogno della camera non la vede).
export type PenEvent =
  | { readonly kind: "down"; readonly at: PointLite; readonly grab: number }
  | { readonly kind: "move"; readonly at: PointLite; readonly slop: number }
  | { readonly kind: "up"; readonly at: PointLite; readonly slop: number }
  // Enter/Escape: termina il path aperto con quello che c'è.
  | { readonly kind: "commit" }
  // Cambio tool, pointercancel, smontaggio: abbandona senza creare nulla.
  | { readonly kind: "abort" };

// Il contorno finito, pronto per diventare un nodo.
export interface PenPath {
  readonly anchors: readonly AnchorLite[];
  readonly closed: boolean;
}

// Cosa deve fare il chiamante DOPO la transizione. L'effetto è dichiarato dalla
// macchina e prodotto dall'adattatore: è ciò che tiene la macchina pura.
//  - "none"   niente;
//  - "begin"  aprire il gesto (primo ancoraggio del path);
//  - "finish" creare il nodo con `path` e CHIUDERE il gesto: un op sul filo,
//             una voce di annulla, per l'intero disegno;
//  - "cancel" abbandonare il gesto senza emettere nessun op.
export interface PenStep {
  readonly state: PenState;
  readonly effect: "none" | "begin" | "finish" | "cancel";
  readonly path?: PenPath;
}

function corner(p: PointLite): AnchorLite {
  return { x: p.x, y: p.y, inX: 0, inY: 0, outX: 0, outY: 0 };
}

// L'ancoraggio `base` con le maniglie tirate fino a `cursor`. Sotto la soglia
// torna base IDENTICO: un click resta un angolo, e un trascinamento che rientra
// nella soglia torna esattamente da dove era partito (nessuna isteresi, perché
// il calcolo riparte sempre da base e non dall'ultimo valore).
//
// Le maniglie sono OFFSET relativi all'ancoraggio (regola dei due spazi, vedi
// il proto su `Anchor`), quindi il delta cursore-ancoraggio È già la maniglia:
// nessuna sottrazione in più, e la simmetria è un semplice cambio di segno.
function pulled(base: AnchorLite, cursor: PointLite, slop: number, grip: PenGrip): AnchorLite {
  const dx = cursor.x - base.x;
  const dy = cursor.y - base.y;
  if (Math.hypot(dx, dy) < slop) return base;
  return grip === "close"
    ? { ...base, inX: dx, inY: dy }
    : { ...base, outX: dx, outY: dy, inX: -dx, inY: -dy };
}

type Placing = Extract<PenState, { name: "placing" }>;

// Gli ancoraggi con quello TRASCINATO aggiornato. Quale sia lo dice il grip:
// "close" tira il primo (è lui che si sta per chiudere), "new" l'ultimo (è
// quello appena posato).
function dragged(s: Placing, cursor: PointLite, slop: number): AnchorLite[] {
  const i = s.grip === "close" ? 0 : s.anchors.length - 1;
  const next = [...s.anchors];
  next[i] = pulled(s.base, cursor, slop, s.grip);
  return next;
}

// LA TABELLA DELLE TRANSIZIONI. Ogni stato risponde a ogni evento; quelli che
// non hanno senso in quello stato (un `up` spaiato, un secondo pointer premuto
// mentre il primo trascina) tornano lo stato IDENTICO, che è anche il modo in
// cui l'adattatore sa di non dover riscrivere niente.
export function penReduce(state: PenState, ev: PenEvent): PenStep {
  switch (state.name) {
    case "idle": {
      if (ev.kind === "down") {
        const a = corner(ev.at);
        return { state: { name: "placing", anchors: [a], grip: "new", base: a }, effect: "begin" };
      }
      // Escape a mano alzata: non c'è nessun path da terminare e nessun nodo da
      // creare -- ed è precisamente ciò che deve succedere. Idem per move/up
      // (il puntatore che passa) e per abort (niente da abbandonare).
      return { state, effect: "none" };
    }

    case "placing": {
      switch (ev.kind) {
        case "move":
          return { state: { ...state, anchors: dragged(state, ev.at, ev.slop) }, effect: "none" };
        case "up": {
          const anchors = dragged(state, ev.at, ev.slop);
          // Rilascio su una chiusura: il path è finito. `closed` solo con
          // almeno due ancoraggi -- con uno solo non esiste nessun segmento di
          // ritorno da disegnare, e dirlo chiuso sarebbe una bugia nel
          // documento (vedi vectorGeometry::subpathFills).
          return state.grip === "close"
            ? { state: PEN_IDLE, effect: "finish", path: { anchors, closed: anchors.length >= 2 } }
            : { state: { name: "drawing", anchors, cursor: ev.at }, effect: "none" };
        }
        case "commit":
          // Il tasto è arrivato prima del rilascio: termina il path APERTO con
          // gli ancoraggi come stanno adesso. La chiusura avviene al RILASCIO
          // sul primo ancoraggio, e qui quel rilascio non c'è stato.
          return { state: PEN_IDLE, effect: "finish", path: { anchors: state.anchors, closed: false } };
        case "abort":
          return { state: PEN_IDLE, effect: "cancel" };
        case "down":
          // Un SECONDO pointer premuto mentre il primo trascina: il path è già
          // impegnato, quel punto non è un ancoraggio.
          return { state, effect: "none" };
      }
    }

    case "drawing": {
      switch (ev.kind) {
        case "move":
          return { state: { ...state, cursor: ev.at }, effect: "none" };
        case "down": {
          const first = state.anchors[0];
          // Entro la presa dal PRIMO ancoraggio: è una chiusura. Non aggiunge
          // nessun ancoraggio -- il contorno torna su quello che c'è già -- e
          // non finisce qui: il rilascio può ancora tirarne la maniglia
          // entrante, che è la curva del segmento di ritorno.
          if (Math.hypot(ev.at.x - first.x, ev.at.y - first.y) <= ev.grab) {
            return {
              state: { name: "placing", anchors: state.anchors, grip: "close", base: first },
              effect: "none",
            };
          }
          const a = corner(ev.at);
          return {
            state: { name: "placing", anchors: [...state.anchors, a], grip: "new", base: a },
            effect: "none",
          };
        }
        case "commit":
          return { state: PEN_IDLE, effect: "finish", path: { anchors: state.anchors, closed: false } };
        case "abort":
          return { state: PEN_IDLE, effect: "cancel" };
        case "up":
          // Rilascio spaiato (il commit da tastiera è arrivato col pulsante
          // ancora premuto): niente da fare.
          return { state, effect: "none" };
      }
    }
  }
}

// Ciò che l'OVERLAY deve disegnare per questo stato. Derivata, non uno stato
// parallelo: l'anteprima non può divergere dalla macchina perché non esiste
// separatamente da lei.
function penPreviewOf(state: PenState): PenPreview | null {
  switch (state.name) {
    case "idle":
      return null;
    case "drawing":
      return { anchors: state.anchors, next: state.cursor, active: null };
    case "placing":
      return {
        anchors: state.anchors,
        // Niente segmento pendente: il cursore sta tirando una maniglia.
        next: null,
        active: state.grip === "close" ? 0 : state.anchors.length - 1,
      };
  }
}

// --- l'adattatore: la macchina attaccata allo store --------------------------

export function createPenTool(): Tool {
  let state: PenState = PEN_IDLE;

  // px SCHERMO -> unità MONDO. È l'unico punto del tool che tocca la camera, e
  // la legge da ToolContext invece di ricalcolare la trasformazione a mano.
  const slopOf = (ctx: ToolContext) => PEN_CLICK_SLOP_PX / ctx.getCamera().zoom;
  const grabOf = (ctx: ToolContext) => PEN_ANCHOR_GRAB_PX / ctx.getCamera().zoom;

  // Il path finito diventa UN nodo con UN op. Il box del nodo è la bbox della
  // sua geometria e gli ancoraggi diventano LOCALI: è l'invariante che il proto
  // dichiara su VectorNode, e chi scrive i subpath è responsabile di
  // mantenerlo (vedi vectorGeometry::normalizeVector, che è anche l'unica
  // implementazione di quella bbox -- una seconda copia della matematica delle
  // cubiche divergerebbe al primo caso limite).
  //
  // L'origine passata è (0,0) perché gli ancoraggi dell'anteprima sono già in
  // coordinate MONDO: il nodo non esisteva, quindi non c'era nessuna origine da
  // cui misurarli.
  function finish(path: PenPath, ctx: ToolContext): void {
    const { subpaths, box } = normalizeVector({ x: 0, y: 0 }, [
      { anchors: [...path.anchors], closed: path.closed },
    ]);
    const id = uuid();
    const node = create(NodeSchema, {
      id,
      parentId: "page1",
      orderKey: nextOrderKey(ctx.getScene()),
      name: "Path",
      visible: true,
      opacity: 1,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      fills: toPbFills([PEN_FILL]),
      shape: { case: "vector", value: { subpaths: toPbSubPaths(subpaths) } },
    });
    const store = useScene.getState();
    // Il nodo si seleziona a gesto ancora APERTO: endGesture riconcilia la
    // selezione contro la scena FINALE, quindi può riferirsi a un id che
    // esisterà solo dopo l'op (stesso meccanismo di textTool.ts). Selezionarlo
    // è anche ciò che rende immediatamente visibili i suoi punti quando
    // l'editing degli ancoraggi arriverà.
    store.setSelection([id]);
    // UN solo op finale per l'INTERO disegno: una voce di annulla, un invio sul
    // filo. Il gesto era aperto dal primo ancoraggio, non da qui.
    store.endGesture([makeCreateNodeOp(node)]);
  }

  // Una transizione: calcola, applica l'effetto, pubblica l'anteprima. È
  // l'UNICO punto in cui `state` viene riassegnato.
  function step(ev: PenEvent, ctx: ToolContext): void {
    const before = state;
    const out = penReduce(state, ev);
    state = out.state;
    // Solo se qualcosa è cambiato: un pointermove a mano alzata torna lo stato
    // identico, e riscrivere `null` sopra `null` sveglierebbe i sottoscrittori
    // dello store a ogni pixel di puntatore.
    if (state !== before) useScene.getState().setPenPreview(penPreviewOf(state));
    switch (out.effect) {
      case "begin":
        useScene.getState().beginGesture();
        break;
      case "finish":
        // `path` c'è sempre con "finish" (lo produce solo penReduce, che li
        // costruisce insieme); la guardia è per il tipo, non per un caso reale.
        if (out.path) finish(out.path, ctx);
        break;
      case "cancel":
        useScene.getState().cancelGesture();
        break;
      case "none":
        break;
    }
  }

  return {
    id: "pen",
    cursor: "crosshair",

    onPointerDown(e, ctx) {
      step({ kind: "down", at: ctx.toWorld(e), grab: grabOf(ctx) }, ctx);
    },

    onPointerMove(e, ctx) {
      step({ kind: "move", at: ctx.toWorld(e), slop: slopOf(ctx) }, ctx);
    },

    onPointerUp(e, ctx) {
      step({ kind: "up", at: ctx.toWorld(e), slop: slopOf(ctx) }, ctx);
    },

    onKeyDown(e, ctx) {
      // Enter ed Escape terminano il path APERTO (brief e spec: sono la stessa
      // uscita). Con nessun ancoraggio posato non creano niente -- la macchina
      // lo dice da sola, senza un caso speciale qui.
      if (e.key === "Enter" || e.key === "Escape") step({ kind: "commit" }, ctx);
    },

    // Gesto abbandonato: cambio tool, pointercancel, smontaggio. Nessun op.
    //
    // Anche il pan TEMPORANEO (spazio premuto o tasto centrale) passa di qui:
    // toolManager sostituisce il tool attivo con la mano, e sostituire un tool
    // significa disattivare il precedente. Un path a metà si perde. È il
    // contratto di onDeactivate ("abbandonare un gesto a metà senza emettere
    // op") applicato a un gesto che dura più click invece di un drag solo, e
    // non c'è modo di distinguere qui un pan momentaneo da un cambio di
    // strumento: il tool riceve lo stesso identico richiamo.
    onDeactivate(ctx) {
      step({ kind: "abort" }, ctx);
    },
  };
}

export const penTool = createPenTool();
