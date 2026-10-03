import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromJson } from "@bufbuild/protobuf";
import { OpSchema, DocumentSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyOp } from "./applyOp";
import { emptyScene, fromDocument } from "./types";

// Runs every fixture under testdata/golden/ as its own test, so adding a new
// fixture file is enough to exercise it -- no runner edits.
const goldenDir = resolve(__dirname, "../../../testdata/golden");
const fixtures = readdirSync(goldenDir).filter((f) => f.endsWith(".json"));

describe("golden parity", () => {
  it("found golden fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture} matches expected document`, () => {
      const raw = JSON.parse(readFileSync(resolve(goldenDir, fixture), "utf8"));
      // `rejected` elenca gli indici degli op che le DUE implementazioni devono
      // respingere (un parent inesistente, un reparent che chiude un ciclo).
      // Go verifica che Apply ritorni errore; qui applyOp è totale e non ha
      // errori, quindi l'equivalente osservabile è la scena INVARIATA -- che è
      // poi ciò che il client deve mostrare quando il server rifiuta l'op.
      // Vedi internal/core/golden_test.go::goldenFile.
      const rejected = new Set<number>(raw.rejected ?? []);
      let scene = emptyScene(raw.docId, "Untitled");
      raw.ops.forEach((opJson: unknown, i: number) => {
        const before = scene;
        scene = applyOp(scene, fromJson(OpSchema, opJson as never));
        if (rejected.has(i)) expect(scene, `op ${i} doveva essere rifiutato`).toEqual(before);
      });
      const expected = fromDocument(fromJson(DocumentSchema, raw.expected));
      expect(scene.nodes).toEqual(expected.nodes);
      // I COMPONENTI fanno parte del documento quanto i nodi: dal lato Go il
      // confronto è un proto.Equal sull'intero Document (Document.components
      // compreso), quindi una fixture con op sui componenti
      // (createComponent/setInstanceOverride) proverebbe la parità solo a metà se
      // qui si guardassero i soli nodi. Un master referenziato per rootNodeId,
      // mai copiato.
      expect(scene.components).toEqual(expected.components);
      // Le PAGINE fanno parte del documento quanto i nodi: dal lato Go il
      // confronto è un proto.Equal sull'intero Document, quindi una fixture con
      // op sulle pagine (createPage/deletePage/renamePage) proverebbe la parità
      // solo a metà se qui si guardassero i soli nodi -- e l'ORDINE conta,
      // perché è quello del selettore di pagina.
      expect(scene.pages).toEqual(expected.pages);
      // I FLUSSI (e le loro transizioni) fanno parte del documento: dal lato Go
      // il proto.Equal sull'intero Document li copre, qui vanno confrontati a
      // parte -- compresa la cascata di una delete (transizioni tolte, start
      // svuotato, hotspot azzerato).
      expect(scene.flows).toEqual(expected.flows);
      expect(scene.transitions).toEqual(expected.transitions);
      // Le CLIP di animazione (e la cascata di una delete: tracce tolte, clip
      // col target sparito cancellate, rifiuti per easing/tempi/duplicati).
      expect(scene.clips).toEqual(expected.clips);
    });
  }
});
