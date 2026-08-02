import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene } from "./types";
import type { AnchorLite, SubPathLite } from "./types";
import {
  anchorPoint, inHandlePoint, outHandlePoint,
  hasInHandle, hasOutHandle, vectorBounds, normalizeVector, resizeVector,
  flattenSubpath, distanceToPolyline, pointInRingsEvenOdd, subpathFills, hitVectorGeometry,
  hasAnyAnchor,
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

// --- appiattimento, distanza, riempimento ------------------------------------
// La matematica su cui poggiano il disegno del path (renderer/shapes.ts) e il
// suo hit-test. Sta qui, con le altre letture della geometria, e si prova con
// curve NOTE e risposte NOTE: shapes.ts si limita a tradurre il punto in
// coordinate locali e a scegliere le tolleranze in px SCHERMO.

describe("vectorGeometry: appiattimento", () => {
  // La solita cubica del rapporto: due ancoraggi su x=0, controlli fino a
  // x=100, curva che arriva a 75.
  const CURVY: SubPathLite = {
    anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
    closed: false,
  };

  it("un segmento SENZA maniglie non viene suddiviso: i suoi due estremi e basta", () => {
    // Il caso più comune di un pen tool (una spezzata) non deve pagare niente:
    // i controlli coincidono con gli ancoraggi, quindi la corda È la curva.
    const line: SubPathLite = { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: false };
    expect(flattenSubpath(line, 0.25)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("una cubica degenere in una RETTA resta due punti (i controlli sono sulla corda)", () => {
    // P1 e P2 stanno sulla corda: la curva ci sta sopra tutta, per quanto la
    // sua parametrizzazione non sia lineare. Il criterio "quanto distano i
    // controlli dalla corda" lo vede; uno basato sulla derivata seconda no, e
    // spezzerebbe in una ventina di pezzi una linea dritta.
    const straight: SubPathLite = {
      anchors: [anchor({ x: 0, y: 0, outX: 30, outY: 0 }), anchor({ x: 100, y: 0, inX: -30, inY: 0 })],
      closed: false,
    };
    expect(flattenSubpath(straight, 0.25)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("gli ESTREMI sono esatti, e la spezzata arriva dove arriva la curva vera", () => {
    const pts = flattenSubpath(CURVY, 0.01);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 100 });
    // 75 è l'estremo VERO (vedi vectorBounds qui sopra). Se qualcuno
    // appiattisse sui punti di controllo, questo numero sarebbe 100.
    const maxX = Math.max(...pts.map((p) => p.x));
    expect(maxX).toBeLessThanOrEqual(75);
    expect(maxX).toBeGreaterThan(75 - 0.01);
  });

  it("la tolleranza è RISPETTATA: ogni punto della curva vera dista meno di tol dalla spezzata", () => {
    // Il contratto vero e proprio dell'appiattimento, campionato sulla cubica
    // esatta. Vale a ogni tolleranza, che è ciò che rende sicuro scalare la
    // tolleranza con lo zoom.
    for (const tol of [1, 0.1, 0.01]) {
      const pts = flattenSubpath(CURVY, tol);
      let worst = 0;
      for (let i = 0; i <= 200; i++) {
        const t = i / 200;
        const u = 1 - t;
        // B(t) per P0=(0,0) P1=(100,0) P2=(100,100) P3=(0,100).
        const bx = 3 * u * u * t * 100 + 3 * u * t * t * 100;
        const by = 3 * u * t * t * 100 + t * t * t * 100;
        worst = Math.max(worst, distanceToPolyline(pts, bx, by));
      }
      expect(worst).toBeLessThanOrEqual(tol);
    }
  });

  it("una tolleranza più stretta produce più segmenti, non di meno", () => {
    expect(flattenSubpath(CURVY, 0.01).length).toBeGreaterThan(flattenSubpath(CURVY, 1).length);
  });

  it("un contorno CHIUSO include il segmento di ritorno ultimo -> primo", () => {
    const tri: SubPathLite = {
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }), anchor({ x: 10, y: 10 })],
      closed: true,
    };
    expect(flattenSubpath(tri, 0.25)).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 },
    ]);
  });

  it("un contorno di UN ancoraggio è un punto, uno vuoto è niente", () => {
    expect(flattenSubpath({ anchors: [anchor({ x: 3, y: 4 })], closed: false }, 0.25)).toEqual([{ x: 3, y: 4 }]);
    // `closed` non cambia niente: un punto non ha segmenti da chiudere.
    expect(flattenSubpath({ anchors: [anchor({ x: 3, y: 4 })], closed: true }, 0.25)).toEqual([{ x: 3, y: 4 }]);
    expect(flattenSubpath({ anchors: [], closed: false }, 0.25)).toEqual([]);
  });
});

describe("vectorGeometry: distanza da una spezzata", () => {
  const SEG = [{ x: 0, y: 0 }, { x: 10, y: 0 }];

  it("è la perpendicolare quando il piede cade DENTRO il segmento", () => {
    expect(distanceToPolyline(SEG, 5, 3)).toBe(3);
    expect(distanceToPolyline(SEG, 5, -3)).toBe(3);
    expect(distanceToPolyline(SEG, 5, 0)).toBe(0);
  });

  it("è la distanza dall'ESTREMO quando il piede cade fuori (segmento, non retta)", () => {
    // Con la distanza dalla RETTA questo sarebbe 0: il path sarebbe afferrabile
    // su tutto il suo prolungamento, all'infinito.
    expect(distanceToPolyline(SEG, -4, 0)).toBe(4);
    expect(distanceToPolyline(SEG, 14, 0)).toBe(4);
    expect(distanceToPolyline(SEG, -3, 4)).toBe(5);
  });

  it("prende il MINIMO su tutti i segmenti", () => {
    const l = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(distanceToPolyline(l, 12, 5)).toBe(2);
  });

  it("un solo punto è la distanza dal punto; nessun punto è distanza infinita", () => {
    expect(distanceToPolyline([{ x: 2, y: 2 }], 5, 6)).toBe(5);
    expect(distanceToPolyline([], 0, 0)).toBe(Infinity);
  });
});

describe("vectorGeometry: even-odd", () => {
  // Quadrato esterno e quadrato interno percorsi nello STESSO verso: con la
  // regola NONZERO il buco non sarebbe un buco (avvolgimento 2), con even-odd
  // sì. È il test che pianta la scelta della regola.
  const OUTER = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const HOLE = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }];

  it("un anello solo: dentro è dentro, fuori è fuori", () => {
    expect(pointInRingsEvenOdd([OUTER], 5, 5)).toBe(true);
    expect(pointInRingsEvenOdd([OUTER], 20, 5)).toBe(false);
    expect(pointInRingsEvenOdd([OUTER], 5, 20)).toBe(false);
    expect(pointInRingsEvenOdd([OUTER], -5, 5)).toBe(false);
  });

  it("due anelli concentrici NELLO STESSO VERSO fanno un buco", () => {
    expect(pointInRingsEvenOdd([OUTER, HOLE], 5, 5)).toBe(false);  // nel buco
    expect(pointInRingsEvenOdd([OUTER, HOLE], 1, 1)).toBe(true);   // nella corona
    expect(pointInRingsEvenOdd([OUTER, HOLE], 20, 20)).toBe(false);
  });

  it("il verso di percorrenza non conta: è tutto il punto di even-odd", () => {
    const reversed = [...HOLE].reverse();
    expect(pointInRingsEvenOdd([OUTER, reversed], 5, 5)).toBe(false);
    expect(pointInRingsEvenOdd([OUTER, reversed], 1, 1)).toBe(true);
  });

  it("nessun anello: nessun punto è dentro", () => {
    expect(pointInRingsEvenOdd([], 0, 0)).toBe(false);
  });
});

describe("vectorGeometry: subpathFills", () => {
  it("va ANCHE nel riempimento se e solo se è chiuso e ha almeno due ancoraggi", () => {
    const two = [anchor({ x: 0, y: 0 }), anchor({ x: 1, y: 1 })];
    expect(subpathFills({ anchors: two, closed: true })).toBe(true);
    expect(subpathFills({ anchors: two, closed: false })).toBe(false);
    // Un punto non ha area: `closed` non gliela regala, e il canvas che lo
    // riempie non disegna niente. Disegno e hit-test devono dire la stessa cosa.
    expect(subpathFills({ anchors: [anchor({ x: 0, y: 0 })], closed: true })).toBe(false);
    expect(subpathFills({ anchors: [], closed: true })).toBe(false);
  });

  it("`true` NON vuol dire 'si vede solo se riempie': il tratto c'è comunque", () => {
    // Questo predicato dice "va anche nel secchio del riempimento", non "è
    // visibile". Il caso qui sopra -- due ancoraggi chiusi -- ne è la prova: il
    // predicato è vero ma il riempimento non dipinge niente (il contorno
    // percorre A->B->A e even-odd non contiene nessun punto), quindi ciò che si
    // vede e ciò che si colpisce è il TRATTO. Provato qui sotto in
    // hitVectorGeometry e in renderer/shapes.test.ts su vectorPaths.
    const two: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: true,
    }];
    expect(subpathFills(two[0])).toBe(true);
    expect(pointInRingsEvenOdd([flattenSubpath(two[0], 0.25)], 50, 0)).toBe(false);
    expect(hitVectorGeometry(two, 50, 0, 5, 0.25)).toBe(true);
  });
});

describe("vectorGeometry: hasAnyAnchor", () => {
  it("distingue 'niente geometria' da 'geometria degenere'", () => {
    // È la distinzione che serve al marquee (tools/selectTool.ts): un path
    // schiacciato si vede e si clicca, uno senza ancoraggi no.
    expect(hasAnyAnchor([])).toBe(false);
    expect(hasAnyAnchor([{ anchors: [], closed: true }])).toBe(false);
    expect(hasAnyAnchor([{ anchors: [], closed: false }, { anchors: [], closed: true }])).toBe(false);
    expect(hasAnyAnchor([{ anchors: [anchor({ x: 0, y: 0 })], closed: false }])).toBe(true);
    // Basta UN ancoraggio in UN contorno qualsiasi.
    expect(hasAnyAnchor([
      { anchors: [], closed: false },
      { anchors: [anchor({ x: 5, y: 5 })], closed: true },
    ])).toBe(true);
  });
});

describe("vectorGeometry: hitVectorGeometry", () => {
  const GRAB = 5;
  const FLAT = 0.25;
  const open = (anchors: AnchorLite[]): SubPathLite[] => [{ anchors, closed: false }];

  it("un contorno APERTO si colpisce per VICINANZA alla curva", () => {
    const seg = open([anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })]);
    expect(hitVectorGeometry(seg, 50, 0, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(seg, 50, 4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(seg, 50, -4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(seg, 50, 5.1, GRAB, FLAT)).toBe(false);
    // Oltre l'estremo: la presa è attorno al segmento, non alla sua retta.
    expect(hitVectorGeometry(seg, 110, 0, GRAB, FLAT)).toBe(false);
  });

  it("un contorno aperto NON si riempie: il suo interno non è colpibile", () => {
    // Tre lati di un quadrato, non chiusi: il centro non è inchiostro, e il
    // canvas non lo dipinge. Se l'hit-test lo colpisse, un path a U ruberebbe
    // i click a tutto ciò che ci sta dentro.
    const u = open([
      anchor({ x: 0, y: 0 }), anchor({ x: 0, y: 100 }),
      anchor({ x: 100, y: 100 }), anchor({ x: 100, y: 0 }),
    ]);
    expect(hitVectorGeometry(u, 50, 50, GRAB, FLAT)).toBe(false);
    expect(hitVectorGeometry(u, 50, 98, GRAB, FLAT)).toBe(true); // vicino al lato basso
  });

  it("un contorno CHIUSO si colpisce sul RIEMPIMENTO e sul suo TRATTO", () => {
    const square: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }),
        anchor({ x: 100, y: 100 }), anchor({ x: 0, y: 100 })],
      closed: true,
    }];
    expect(hitVectorGeometry(square, 50, 50, GRAB, FLAT)).toBe(true);
    // Anche il contorno chiuso si TRACCIA (shapes.ts::vectorPaths), quindi si
    // prende per vicinanza come uno aperto: il bersaglio è l'inchiostro, e il
    // tratto esce dal riempimento. La presa è la stessa `grab` di sempre.
    expect(hitVectorGeometry(square, 103, 50, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(square, 104.9, 50, GRAB, FLAT)).toBe(true);
    // Oltre la presa è fuori: la tolleranza è una presa, non un alone infinito.
    expect(hitVectorGeometry(square, 105.1, 50, GRAB, FLAT)).toBe(false);
    expect(hitVectorGeometry(square, 50, 110, GRAB, FLAT)).toBe(false);
  });

  it("un contorno CHIUSO di AREA NULLA resta colpibile: è il tratto a tenerlo vivo", () => {
    // Il caso che il pen tool raggiunge in tre click (A, B, di nuovo A per
    // chiudere): `closed` è vero e subpathFills dice `true`, ma il contorno
    // percorre A->B->A e even-odd non contiene NESSUN punto. Se il riempimento
    // fosse l'unico bersaglio il nodo diventerebbe non cliccabile nell'istante
    // in cui l'utente lo chiude -- e invisibile, visto che disegno e hit-test
    // seguono la stessa regola.
    const twoPoint: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 })], closed: true,
    }];
    expect(hitVectorGeometry(twoPoint, 50, 0, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(twoPoint, 50, 4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(twoPoint, 50, 5.1, GRAB, FLAT)).toBe(false);
    // Stessa storia per un contorno chiuso di ancoraggi ALLINEATI: sono tre
    // punti, ma l'area è comunque zero.
    const collinear: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 50, y: 0 }), anchor({ x: 100, y: 0 })],
      closed: true,
    }];
    expect(hitVectorGeometry(collinear, 75, 0, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(collinear, 75, 4.9, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(collinear, 75, 5.1, GRAB, FLAT)).toBe(false);
  });

  it("due contorni chiusi COMPONGONO: quello interno è un buco", () => {
    const ring: SubPathLite[] = [
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 100, y: 0 }),
        anchor({ x: 100, y: 100 }), anchor({ x: 0, y: 100 })], closed: true },
      { anchors: [anchor({ x: 30, y: 30 }), anchor({ x: 70, y: 30 }),
        anchor({ x: 70, y: 70 }), anchor({ x: 30, y: 70 })], closed: true },
    ];
    expect(hitVectorGeometry(ring, 10, 10, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(ring, 50, 50, GRAB, FLAT)).toBe(false);
    // Il bordo del buco è comunque INCHIOSTRO (si traccia), quindi lì si
    // colpisce: il buco è il vuoto, non il suo contorno.
    expect(hitVectorGeometry(ring, 50, 32, GRAB, FLAT)).toBe(true);
  });

  it("il riempimento segue la CURVA vera, non il poligono degli ancoraggi", () => {
    // Due ancoraggi su x=0 con le maniglie che spingono a destra: la curva,
    // chiusa dal segmento di ritorno, racchiude un'area che arriva a x=75. Il
    // poligono dei soli ancoraggi sarebbe degenere e non conterrebbe niente.
    const lens: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0, outX: 100, outY: 0 }), anchor({ x: 0, y: 100, inX: 100, inY: 0 })],
      closed: true,
    }];
    expect(hitVectorGeometry(lens, 40, 50, GRAB, FLAT)).toBe(true);
    // 85 e non 80: la curva arriva a x=75 e il TRATTO si prende entro GRAB=5,
    // quindi 80 sarebbe sul filo della presa e non direbbe niente sul
    // riempimento, che è ciò che questo test misura.
    expect(hitVectorGeometry(lens, 85, 50, GRAB, FLAT)).toBe(false);
  });

  it("un contorno di UN ancoraggio si colpisce come un punto", () => {
    // Il pen tool dopo il primo click: senza questo il nodo appena nato sarebbe
    // raggiungibile solo dal pannello livelli.
    const dot = open([anchor({ x: 10, y: 20 })]);
    expect(hitVectorGeometry(dot, 10, 20, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(dot, 13, 20, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(dot, 20, 20, GRAB, FLAT)).toBe(false);
  });

  it("un contorno CHIUSO di un solo ancoraggio non riempie niente", () => {
    const dot: SubPathLite[] = [{ anchors: [anchor({ x: 10, y: 20 })], closed: true }];
    expect(hitVectorGeometry(dot, 12, 20, GRAB, FLAT)).toBe(true);
    expect(hitVectorGeometry(dot, 40, 20, GRAB, FLAT)).toBe(false);
  });

  it("geometria VUOTA: niente inchiostro, niente da colpire", () => {
    // Il nodo non disegna niente (riempire un Path2D vuoto non dipinge nulla),
    // quindi non deve nemmeno rubare click alle forme sotto. Resta
    // raggiungibile dal pannello livelli, che è l'unico posto in cui esiste
    // ancora qualcosa da toccare.
    expect(hitVectorGeometry([], 0, 0, GRAB, FLAT)).toBe(false);
    expect(hitVectorGeometry([{ anchors: [], closed: true }], 0, 0, GRAB, FLAT)).toBe(false);
  });

  it("aperto e chiuso nello stesso nodo: si colpisce l'uno O l'altro", () => {
    const mixed: SubPathLite[] = [
      { anchors: [anchor({ x: 0, y: 0 }), anchor({ x: 10, y: 0 }),
        anchor({ x: 10, y: 10 }), anchor({ x: 0, y: 10 })], closed: true },
      { anchors: [anchor({ x: 50, y: 0 }), anchor({ x: 50, y: 100 })], closed: false },
    ];
    expect(hitVectorGeometry(mixed, 5, 5, GRAB, FLAT)).toBe(true);    // riempimento
    expect(hitVectorGeometry(mixed, 52, 50, GRAB, FLAT)).toBe(true);  // vicinanza
    expect(hitVectorGeometry(mixed, 30, 50, GRAB, FLAT)).toBe(false);
  });
});
