import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene } from "./types";
import type { AnchorLite, SubPathLite } from "./types";
import {
  anchorPoint, inHandlePoint, outHandlePoint,
  hasInHandle, hasOutHandle, vectorBounds, normalizeVector, resizeVector,
} from "./vectorGeometry";

// La regola dei DUE SPAZI, che il proto (su `Anchor`) enuncia e questo file
// pianta: ancoraggi LOCALI al nodo, maniglie RELATIVE all'ancoraggio. Renderer,
// hit-test, overlay e pen tool leggeranno tutti da vectorGeometry.ts, quindi
// questi test sono il posto in cui la regola smette di essere un commento.

function anchor(a: Partial<AnchorLite>): AnchorLite {
  return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, ...a };
}

// Origine, ancoraggio e maniglie tutti DIVERSI e non nulli: una somma
// dimenticata (o fatta una volta di troppo) non può cadere per caso sul valore
// giusto.
const ORIGIN = { x: 100, y: 50 };
const A = anchor({ x: 7, y: 3, inX: -2, inY: 5, outX: 11, outY: -4 });

describe("vectorGeometry: i due spazi", () => {
  it("l'ancoraggio è LOCALE al nodo: il punto mondo è origine + ancoraggio", () => {
    expect(anchorPoint(ORIGIN, A)).toEqual({ x: 107, y: 53 });
  });

  it("le maniglie sono RELATIVE all'ancoraggio: il controllo è origine + ancoraggio + maniglia", () => {
    expect(inHandlePoint(ORIGIN, A)).toEqual({ x: 105, y: 58 });
    expect(outHandlePoint(ORIGIN, A)).toEqual({ x: 118, y: 49 });
  });

  // Il caso che il modello sbagliava: con maniglie ASSOLUTE, un ancoraggio
  // decodificato senza in_/out_ (gli zeri che proto3 omette dal filo) avrebbe le
  // maniglie nell'origine invece che su di sé -- una curva che va a sbattere
  // nell'angolo del nodo al posto del punto d'angolo che l'utente ha disegnato.
  // Relative, lo zero dice il vero.
  it("un ancoraggio senza maniglie (lo zero di proto3) è un ANGOLO, non una curva verso l'origine", () => {
    const corner = anchor({ x: 20, y: 30 });
    const p = anchorPoint(ORIGIN, corner);
    expect(p).toEqual({ x: 120, y: 80 });
    // I due controlli COINCIDONO con l'ancoraggio: una bezierCurveTo con i
    // controlli sugli estremi disegna esattamente la retta, quindi il renderer
    // non ha bisogno di un ramo per "nessuna maniglia".
    expect(inHandlePoint(ORIGIN, corner)).toEqual(p);
    expect(outHandlePoint(ORIGIN, corner)).toEqual(p);
    expect(hasInHandle(corner)).toBe(false);
    expect(hasOutHandle(corner)).toBe(false);
  });

  it("hasIn/hasOut guardano la maniglia giusta (le due sono indipendenti)", () => {
    expect(hasInHandle(anchor({ x: 9, y: 9, outX: 3 }))).toBe(false);
    expect(hasOutHandle(anchor({ x: 9, y: 9, outX: 3 }))).toBe(true);
    expect(hasInHandle(anchor({ inY: -1 }))).toBe(true);
  });
});

// L'altra metà della regola: che cosa lega Node.x/y alla geometria. Con
// ancoraggi locali, spostare il nodo sposta il path GRATIS -- il setProps{x,y}
// che selectTool manda già oggi per qualunque nodo. È la ragione della scelta,
// quindi è un test e non una nota.
describe("vectorGeometry: spostare il nodo sposta la geometria", () => {
  const subpaths: SubPathLite[] = [{ anchors: [A, anchor({ x: 40, y: 12 })], closed: false }];

  function sceneWithVector() {
    const node = create(NodeSchema, {
      id: "v1", parentId: "page1", orderKey: "a0", name: "Path", visible: true, opacity: 1,
      x: ORIGIN.x, y: ORIGIN.y, width: 60, height: 40,
      shape: { case: "vector", value: { subpaths } },
    });
    return applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-v1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
  }

  it("un setProps{x,y} muove i punti mondo e NON tocca gli ancoraggi", () => {
    const before = sceneWithVector();
    const moved = applyOp(before, create(OpSchema, {
      opId: "op-mv", docId: "doc1",
      kind: { case: "setProps", value: {
        id: "v1", patch: create(NodeSchema, { x: 300, y: 250 }), mask: { paths: ["x", "y"] },
      } },
    }));

    const n0 = before.nodes["v1"];
    const n1 = moved.nodes["v1"];
    // La geometria nel MODELLO è identica: nessun op la riscrive, ed è
    // esattamente il punto -- con ancoraggi in coordinate mondo, uno
    // spostamento che non riscrivesse tutti i subpath lascerebbe il path
    // indietro rispetto al suo box.
    expect(n1.vector).toEqual(n0.vector);
    // ...e i punti in coordinate mondo si sono spostati del delta, tutti.
    const d = { x: 300 - ORIGIN.x, y: 250 - ORIGIN.y };
    for (const [i, a] of n1.vector!.subpaths[0].anchors.entries()) {
      const p0 = anchorPoint(n0, n0.vector!.subpaths[0].anchors[i]);
      expect(anchorPoint(n1, a)).toEqual({ x: p0.x + d.x, y: p0.y + d.y });
      const c0 = outHandlePoint(n0, n0.vector!.subpaths[0].anchors[i]);
      expect(outHandlePoint(n1, a)).toEqual({ x: c0.x + d.x, y: c0.y + d.y });
    }
  });
});

describe("vectorGeometry: bounds e normalizzazione", () => {
  // La cubica del rapporto: A=(0,0) out=(100,0) -> B=(0,100) in=(100,0). I due
  // ancoraggi stanno entrambi su x=0, i controlli spingono fino a x=100, e la
  // curva arriva a 75 (l'estremo è a t=0.5).
  const CURVY: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
    closed: false,
  }];

  it("la bbox è quella VERA della curva, non l'inviluppo dei punti di controllo", () => {
    // Il box degli ancoraggi (width 0) sarebbe più STRETTO dell'inchiostro,
    // l'inviluppo dei controlli (width 100) più largo di un terzo. Nessuno dei
    // due è "il verso giusto in cui sbagliare": il proto dichiara questo box la
    // bbox locale della geometria, e sono le 8 maniglie di resize
    // (overlayRenderer) e il marquee (selectTool::nodesInMarquee) a leggerlo --
    // sbagliare in grande significa maniglie che non toccano il path e una
    // selezione che afferra senza sfiorare l'inchiostro.
    expect(vectorBounds(CURVY)).toEqual({ x: 0, y: 0, width: 75, height: 100 });
  });

  it("le maniglie che NESSUN segmento usa non gonfiano il box (contorno aperto)", () => {
    // In un contorno APERTO la maniglia entrante del primo ancoraggio e quella
    // uscente dell'ultimo non appartengono a nessuna curva. Un pen tool che
    // tiene le maniglie speculari le ha comunque valorizzate: prenderle per
    // buone gonfierebbe il box per geometria che non esiste.
    const sp: SubPathLite[] = [{
      anchors: [
        anchor({ x: 0, y: 0, inX: -1000, inY: -1000 }),
        anchor({ x: 10, y: 10, outX: 1000, outY: 1000 }),
      ],
      closed: false,
    }];
    expect(vectorBounds(sp)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("chiudendo il contorno quelle stesse maniglie contano: il segmento di ritorno le usa", () => {
    // Il complemento del test precedente: non è "le maniglie degli estremi si
    // ignorano", è "contano solo i segmenti disegnati". Chiuso, il segmento
    // ultimo -> primo esiste e usa entrambe.
    const sp: SubPathLite[] = [{
      anchors: [
        anchor({ x: 0, y: 0, inX: -1000, inY: -1000 }),
        anchor({ x: 10, y: 10, outX: 1000, outY: 1000 }),
      ],
      closed: true,
    }];
    const b = vectorBounds(sp);
    expect(b.x).toBeLessThan(0);
    expect(b.x + b.width).toBeGreaterThan(10);
    // ...e comunque MOLTO dentro l'inviluppo dei controlli (-1000..1010): la
    // curva non arriva dove arrivano i suoi punti di controllo.
    expect(b.x).toBeGreaterThan(-1000);
    expect(b.x + b.width).toBeLessThan(1010);
  });

  it("un contorno di UN SOLO ancoraggio è il suo punto: non c'è curva che usi le maniglie", () => {
    const sp: SubPathLite[] = [
      { anchors: [anchor({ x: 5, y: 7, inX: -50, inY: -50, outX: 50, outY: 50 })], closed: true },
    ];
    expect(vectorBounds(sp)).toEqual({ x: 5, y: 7, width: 0, height: 0 });
  });

  it("una geometria vuota dà un box degenere in (0,0)", () => {
    expect(vectorBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(vectorBounds([{ anchors: [], closed: true }])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("normalizeVector porta la bbox locale a (0,0)-(width,height)", () => {
    const sp: SubPathLite[] = [{ anchors: [anchor({ x: -20, y: 5 }), anchor({ x: 30, y: 45 })], closed: true }];
    const { subpaths, box } = normalizeVector(ORIGIN, sp);

    expect(vectorBounds(subpaths)).toEqual({ x: 0, y: 0, width: 50, height: 40 });
    // Il box è in coordinate MONDO ed è quello che il gesto scrive nel nodo.
    expect(box).toEqual({ x: 80, y: 55, width: 50, height: 40 });
  });

  it("normalizzare non muove NIENTE: i punti mondo restano gli stessi", () => {
    // La proprietà su cui è appesa la correttezza dell'invariante: gli
    // ancoraggi perdono in locale esattamente ciò che l'origine guadagna in
    // mondo. Se una delle due somme sbagliasse verso, il path salterebbe di un
    // box a ogni modifica.
    const sp: SubPathLite[] = [
      { anchors: [A, anchor({ x: -13, y: 27, inX: 4, inY: -6 })], closed: false },
      { anchors: [anchor({ x: 55, y: -9, outX: -3, outY: 2 })], closed: true },
    ];
    const { subpaths, box } = normalizeVector(ORIGIN, sp);

    for (const [i, before] of sp.entries()) {
      for (const [j, a0] of before.anchors.entries()) {
        const a1 = subpaths[i].anchors[j];
        expect(anchorPoint(box, a1)).toEqual(anchorPoint(ORIGIN, a0));
        expect(inHandlePoint(box, a1)).toEqual(inHandlePoint(ORIGIN, a0));
        expect(outHandlePoint(box, a1)).toEqual(outHandlePoint(ORIGIN, a0));
      }
      // `closed` non è geometria da traslare, ma si perde con la stessa
      // facilità: una copia campo per campo che lo dimenticasse aprirebbe ogni
      // contorno chiuso a ogni modifica.
      expect(subpaths[i].closed).toBe(before.closed);
    }
  });
});

// L'invariante del box nel verso che costa: il BOX non può cambiare da solo. Le
// 8 maniglie di resize sono già spedite da M1 e mandano un
// setProps{x,y,width,height} per ogni nodo selezionato, kind-agnostico; senza
// questa riscrittura un nodo vettoriale finirebbe con il path della misura di
// prima dentro un box cresciuto -- l'invariante violata da un gesto ordinario e
// senza nessun SetVectorPath in vista.
describe("vectorGeometry: il resize riscrive la geometria", () => {
  // bbox = (0,0)-(75,100), vedi il test della cubica qui sopra.
  const CURVY: SubPathLite[] = [{
    anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
    closed: false,
  }];
  const FROM = { width: 75, height: 100 };

  it("scalare il box scala l'inchiostro: la bbox locale resta (0,0)-(w',h')", () => {
    const out = resizeVector(CURVY, FROM, { signed: 150, start: 75 }, { signed: 50, start: 100 });
    expect(vectorBounds(out)).toEqual({ x: 0, y: 0, width: 150, height: 50 });
    // Le maniglie sono OFFSET: si scalano con la sola parte lineare. Se non lo
    // facessero, la curvatura resterebbe della misura di prima dentro un path
    // scalato -- e la bbox qui sopra non tornerebbe.
    expect(out[0].anchors[0].outX).toBe(200);
    expect(out[0].anchors[1].inX).toBe(200);
  });

  it("un FLIP specchia l'inchiostro dentro il box invece di mandarlo in negativo", () => {
    const out = resizeVector(CURVY, FROM, { signed: -75, start: 75 }, { signed: 100, start: 100 });
    // Stesso box (transformBounds normalizza width/height a >= 0)...
    expect(vectorBounds(out)).toEqual({ x: 0, y: 0, width: 75, height: 100 });
    // ...ma la curva è specchiata: gli ancoraggi erano sul bordo SINISTRO del
    // box (x locale 0) e ora sono su quello destro, con le maniglie girate.
    expect(out[0].anchors[0].x).toBe(75);
    expect(out[0].anchors[0].outX).toBe(-100);
  });

  it("un asse senza fattore di scala definito (lato di partenza 0) resta invariato", () => {
    // Stessa regola di selection/handles.ts::mapAxis: un lato degenere non ha
    // un rapporto, e produrre Infinity/NaN sarebbe peggio che non scalare.
    const flat: SubPathLite[] = [{ anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 })], closed: false }];
    const out = resizeVector(flat, { width: 10, height: 0 }, { signed: 20, start: 10 }, { signed: 0, start: 0 });
    expect(out[0].anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [20, 0]]);
  });

  it("non tocca `closed` né inventa ancoraggi", () => {
    const sp: SubPathLite[] = [
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 10 })], closed: true },
      { anchors: [anchor({ x: 2, y: 2 })], closed: false },
    ];
    const out = resizeVector(sp, { width: 10, height: 10 }, { signed: 20, start: 10 }, { signed: 10, start: 10 });
    expect(out.map((s) => s.closed)).toEqual([true, false]);
    expect(out.map((s) => s.anchors.length)).toEqual([2, 1]);
  });
});
