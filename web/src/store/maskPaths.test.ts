import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create, toJson, fromJson, type MessageInitShape } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene, type NodeLite } from "./types";
import { MASK_PATHS, isMaskPath, type MaskPath } from "./maskPaths";
import { makeSetPropsOp } from "../tools/ops";

// ---------------------------------------------------------------------------
// Helper condivisi
// ---------------------------------------------------------------------------

function createRectOp(id: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

// Scena di partenza: un solo nodo "n1" i cui valori sono TUTTI diversi dai
// valori sonda usati sotto, così "il campo è stato scritto" e "il campo era
// già così" non si confondono mai.
function baseScene() {
  return applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1"));
}

function setPropsOp(paths: readonly string[], patch: MessageInitShape<typeof NodeSchema> = {}): Op {
  return create(OpSchema, {
    opId: "op1", docId: "doc1",
    kind: { case: "setProps", value: { id: "n1", patch: create(NodeSchema, patch), mask: { paths: [...paths] } } },
  });
}

// La strada che l'op fa DAVVERO: createConnectTransport (connect-web) non passa
// useBinaryFormat, quindi ogni SubmitOp viene serializzato in JSON e ogni
// OpRecord che torna da Subscribe viene deserializzato da JSON. Nessun test
// deve costruire il messaggio e darlo ad applyOp senza passare di qui: è
// esattamente nel mezzo che google.protobuf.FieldMask riscrive i path.
function overWire(op: Op): Op {
  return fromJson(OpSchema, toJson(OpSchema, op));
}

function maskOf(op: Op): readonly string[] {
  if (op.kind.case !== "setProps") throw new Error("non è un op setProps");
  return op.kind.value.mask?.paths ?? [];
}

// ---------------------------------------------------------------------------
// 1. Guardia CROSS-LANGUAGE: MASK_PATHS vs. il sorgente Go, letto davvero.
//
// core.applySetProps (Go) è l'AUTORITÀ su quali path esistono; maskPaths.ts lo
// rispecchia. Una seconda copia scritta a mano DENTRO questo test non è una
// guardia: chi aggiunge un path la aggiorna nello stesso commit e il test resta
// verde. L'unico controllo che regge è leggere internal/core/apply.go ed
// estrarne i letterali dei `case` -- stessa tecnica con cui golden.test.ts
// legge testdata/golden/. Così `case "corner_radius"` aggiunto SOLO in Go fa
// fallire la suite TypeScript, che è il punto: senza, il client rifiuterebbe in
// silenzio un op che il server accetta e divergerebbe dal documento
// autorevole fino al reload.
// ---------------------------------------------------------------------------

const GO_APPLY_PATH = resolve(__dirname, "../../../internal/core/apply.go");
const GO_FN = "func applySetProps(";

// Ritorna i letterali stringa dei `case` di OGNI `switch path {` dentro
// applySetProps, uno slot per switch (oggi: quello di validazione e quello di
// applicazione). Se apply.go viene rifattorizzato in una forma che questo
// parser non riconosce, il risultato cambia forma e i test sotto falliscono
// rumorosamente invece di diventare vacui.
function goApplySetPropsSwitches(): string[][] {
  const src = readFileSync(GO_APPLY_PATH, "utf8");
  const at = src.indexOf(GO_FN);
  if (at < 0) {
    throw new Error(
      `${GO_APPLY_PATH} non contiene più "${GO_FN}": la guardia cross-language non sa più ` +
        `dove guardare. Aggiorna questo parser assieme al refactor di Go.`,
    );
  }
  const after = src.slice(at + GO_FN.length);
  const nextFn = after.indexOf("\nfunc ");
  const body = nextFn < 0 ? after : after.slice(0, nextFn);

  return body
    .split(/switch\s+path\s*\{/)
    .slice(1)
    .map((block) => {
      const paths: string[] = [];
      for (const caseLine of block.matchAll(/\bcase\s+([^\n:]*):/g)) {
        for (const literal of caseLine[1].matchAll(/"([^"]*)"/g)) paths.push(literal[1]);
      }
      return paths;
    });
}

const uniqSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

describe("MASK_PATHS è ancorato a core.applySetProps (Go), non a una copia locale", () => {
  it("apply.go espone ancora i due switch su `path` che questa guardia sa leggere", () => {
    const switches = goApplySetPropsSwitches();
    // Uno valida l'intera mask, l'altro applica i campi. Se Go ne guadagna o
    // perde uno, il parser va rivisto PRIMA di fidarsi del confronto sotto.
    expect(switches).toHaveLength(2);
    expect(switches[0].length).toBeGreaterThan(0);
    expect(switches[1].length).toBeGreaterThan(0);
  });

  it("i due switch di Go elencano lo stesso insieme (validazione e applicazione non divergono)", () => {
    const [validated, applied] = goApplySetPropsSwitches();
    expect(uniqSorted(validated)).toEqual(uniqSorted(applied));
  });

  it("MASK_PATHS è ESATTAMENTE l'insieme dei case letti dal sorgente Go", () => {
    expect(uniqSorted(MASK_PATHS)).toEqual(uniqSorted(goApplySetPropsSwitches().flat()));
  });
});

// ---------------------------------------------------------------------------
// 2. Ogni path di MASK_PATHS, uno per uno: è un campo vero, sopravvive al filo
//    JSON, e applyOp lo applica davvero (e solo lui).
//
// È la riga che mancava. Il filo è JSON e google.protobuf.FieldMask ha una
// codifica che RISCRIVE il path invece di trasportarlo verbatim: fieldMaskToJson
// converte in lowerCamelCase e LANCIA se protoSnakeCase(protoCamelCase(p)) !== p;
// fieldMaskFromJson rifiuta categoricamente gli underscore sul filo. Con i 9
// path monoparola di M0 le due forme coincidono, quindi il trabocchetto è
// invisibile -- finché qualcuno scrive "cornerRadius" in MASK_PATHS: passerebbe
// ogni gate (compreso il confronto con Go, se lo aggiorna nello stesso edit) e
// poi lancerebbe dentro toJson durante submitOp, con il reject inghiottito da
// syncClient.ts. it.each(MASK_PATHS) rende impossibile aggiungere un path senza
// che il round trip sul filo venga verificato per QUEL path.
// ---------------------------------------------------------------------------

const NODE_FIELD_NAMES = NodeSchema.fields.map((f) => f.name);

// Un valore sonda per ogni path, diverso dal valore che baseScene() dà a n1.
// Il tipo mappato NON è decorativo: aggiungere un path a MASK_PATHS senza
// aggiungere la sua sonda qui è un errore di compilazione (`tsc -b` in
// `pnpm build`), quindi il nuovo path non può sfuggire a it.each. E
// `NodeLite[P]` costringe MaskPath a restare un sottoinsieme delle chiavi di
// NodeLite: un path che non corrisponde a nessun campo del modello non compila.
type Probe = { [P in MaskPath]: { patch: MessageInitShape<typeof NodeSchema>; expected: NodeLite[P] } };

const PROBE: Probe = {
  x: { patch: { x: 42 }, expected: 42 },
  y: { patch: { y: 7 }, expected: 7 },
  width: { patch: { width: 123 }, expected: 123 },
  height: { patch: { height: 456 }, expected: 456 },
  rotation: { patch: { rotation: 1.5 }, expected: 1.5 },
  opacity: { patch: { opacity: 0.25 }, expected: 0.25 },
  name: { patch: { name: "Rinominato" }, expected: "Rinominato" },
  visible: { patch: { visible: false }, expected: false },
  fills: {
    patch: { fills: [{ kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 1 } } } }] },
    expected: [{ r: 1, g: 0, b: 0, a: 1 }],
  },
};

describe("ogni path di MASK_PATHS sopravvive al filo JSON e viene applicato", () => {
  it.each(MASK_PATHS)(
    "%s: identico dopo toJson -> fromJson, campo reale di brawt.v1.Node, applicato da applyOp",
    (path) => {
      // (a) il path esce e rientra IDENTICO dalla codifica JSON del FieldMask.
      // Questa è l'asserzione che un "cornerRadius" in MASK_PATHS non può
      // superare: toJson lancia QUI, in un test, invece che in produzione
      // dentro submitOp con il reject inghiottito da syncClient.
      const wired = overWire(setPropsOp([path], PROBE[path].patch));
      expect(maskOf(wired)).toEqual([path]);

      // (b) ed è un nome di campo che esiste davvero nel Node generato -- non
      // un camelCase inventato, non un campo rinominato nel .proto e mai
      // propagato qui. Sopravvivere al filo non basta: "bogus" sopravvive.
      expect(NODE_FIELD_NAMES).toContain(path);

      // (c) e dopo quel giro applyOp lo applica DAVVERO, scrivendo quel campo
      // e nessun altro (un `case "y": next.x = ...` fallirebbe qui).
      const before = baseScene().nodes["n1"];
      const after = applyOp(baseScene(), wired).nodes["n1"];
      expect(after).toEqual({ ...before, [path]: PROBE[path].expected });
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Il complemento: ciò che NON è in MASK_PATHS non deve toccare la scena.
//    Insieme al blocco 2 questo fissa l'insieme accettato da applyOp come
//    esattamente MASK_PATHS -- comportamento, non forma del sorgente.
// ---------------------------------------------------------------------------

// Tutti round-trippabili sul filo (nessun underscore irreversibile): il motivo
// per cui vengono rifiutati è che core.applySetProps non li ha, non che la
// codifica li rompe. "corner_radius" è il prossimo candidato naturale (M1b,
// RectNode.corner_radius): quando Go guadagnerà quel case, la guardia
// cross-language del blocco 1 fallirà e costringerà ad aggiornare MASK_PATHS,
// PROBE e questa lista insieme.
const NOT_IN_GO_SWITCH = ["corner_radius", "parent_id", "order_key", "id", "shape", "bogus"];

describe("un path fuori da MASK_PATHS fa rifiutare l'INTERO op", () => {
  it.each(NOT_IN_GO_SWITCH)("%s: isMaskPath false, e la scena resta invariata anche in mask mista", (path) => {
    expect(isMaskPath(path)).toBe(false);

    const wired = overWire(setPropsOp(["x", path], { x: 999 }));
    // Il path arriva intatto: il rifiuto è una decisione di applyOp, non un
    // effetto collaterale della codifica.
    expect(maskOf(wired)).toEqual(["x", path]);

    // Parità con core.applySetProps: valida l'intera mask PRIMA di mutare, così
    // "x" non si muove nemmeno se sta nella stessa mask di un path ignoto.
    expect(applyOp(baseScene(), wired).nodes["n1"]).toEqual(baseScene().nodes["n1"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Il punto di costruzione: makeSetPropsOp accetta solo MaskPath.
//
// Questo è un vincolo di tipo, quindi il test che lo prova è a compile time.
// `@ts-expect-error` è una vera asserzione verificata da `tsc -b` (pnpm build,
// tsconfig include "src", quindi anche i .test.ts): se `paths` tornasse
// `string[]`, la riga smetterebbe di essere un errore e TypeScript fallirebbe
// con "Unused '@ts-expect-error' directive". Un grep sul sorgente, invece,
// passerebbe su qualsiasi riformattazione e fallirebbe su un a capo.
// ---------------------------------------------------------------------------

describe("makeSetPropsOp non lascia costruire un op con un path non supportato", () => {
  it("un path camelCase è un errore di compilazione al punto di costruzione, e a runtime non arriva sul filo", () => {
    // @ts-expect-error "cornerRadius" non è un MaskPath.
    const bad = makeSetPropsOp("n1", { shape: { case: "rect", value: { cornerRadius: 12 } } }, ["cornerRadius"]);

    // Se qualcuno aggirasse il tipo (un `as MaskPath`, un op costruito a mano),
    // ecco cosa succederebbe davvero in submitOp: toJson lancia, l'op non parte
    // mai, e la scena locale mostra un cambiamento che il server non vedrà.
    expect(() => toJson(OpSchema, bad)).toThrow(/irreversible/);
  });

  it("un path snake_case valido passa il tipo, il filo e applyOp", () => {
    const op = makeSetPropsOp("n1", { x: 42, y: 7 }, ["x", "y"]);
    const wired = overWire(op);
    expect(maskOf(wired)).toEqual(["x", "y"]);

    const after = applyOp(baseScene(), wired).nodes["n1"];
    expect(after.x).toBe(42);
    expect(after.y).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 5. La forma del FieldMask sul filo, pin-ata su un path multiparola reale.
//    Documenta PERCHÉ i blocchi sopra esistono: la conversione non è l'identità
//    appena un path ha più di una parola.
// ---------------------------------------------------------------------------

describe("forma del FieldMask sul filo JSON", () => {
  it("snake_case in TS/Go, lowerCamelCase sul filo, snake_case di nuovo al ritorno", () => {
    const op = setPropsOp(["corner_radius"], { shape: { case: "rect", value: { cornerRadius: 12 } } });

    // Sul filo il FieldMask è una STRINGA singola (non un array), path uniti da
    // virgola, in lowerCamelCase -- come "x,y" nelle fixture golden esistenti,
    // solo che qui la conversione non è l'identità.
    const wire = toJson(OpSchema, op) as { setProps?: { mask?: string } };
    expect(wire.setProps?.mask).toBe("cornerRadius");

    // fieldMaskFromJson riconverte: il round trip torna ESATTAMENTE al path di
    // partenza, non alla forma sul filo.
    expect(maskOf(fromJson(OpSchema, wire))).toEqual(["corner_radius"]);
  });

  it("un underscore sul filo viene rifiutato in ingresso (nessuno può bypassare la convenzione)", () => {
    const wire = { opId: "op1", docId: "doc1", setProps: { id: "n1", mask: "corner_radius" } };
    expect(() => fromJson(OpSchema, wire)).toThrow();
  });
});
