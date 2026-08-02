import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene } from "./types";
import type { AnchorLite, SubPathLite } from "./types";
import {
  anchorPoint, inHandlePoint, outHandlePoint,
  hasInHandle, hasOutHandle, vectorBounds, normalizeVector,
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
  it("la bbox comprende i punti di CONTROLLO, non solo gli ancoraggi", () => {
    // Una cubica sta dentro l'inviluppo dei suoi quattro punti: prendere solo
    // gli ancoraggi darebbe un box più stretto dell'inchiostro, e il renderer
    // scarterebbe (o la selezione mancherebbe) pezzi di path davvero disegnati.
    const sp: SubPathLite[] = [{
      anchors: [anchor({ x: 0, y: 0, outX: -5, outY: 0 }), anchor({ x: 10, y: 10, inX: 0, inY: 8 })],
      closed: false,
    }];
    expect(vectorBounds(sp)).toEqual({ x: -5, y: 0, width: 15, height: 18 });
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
