import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create, toJson, fromJson } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene } from "./types";
import { MASK_PATHS, isMaskPath } from "./maskPaths";

// Elenco letterale di ciò che core.applySetProps (Go, internal/core/apply.go)
// accetta OGGI. Non importarlo da nessuna parte -- va tenuto come un secondo
// elenco INDIPENDENTE apposta, così questo test fallisce se qualcuno modifica
// MASK_PATHS senza controllare che Go sia d'accordo (o viceversa).
const GO_APPLY_SET_PROPS_PATHS = [
  "x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fills",
];

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, relPath), "utf8");
}

function createRectOp(id: string): Op {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

describe("MASK_PATHS: unica fonte di verità per SetProperties.mask", () => {
  it("rispecchia esattamente lo switch di core.applySetProps (Go) -- stesso insieme, stesso ordine non richiesto", () => {
    expect([...MASK_PATHS].sort()).toEqual([...GO_APPLY_SET_PROPS_PATHS].sort());
  });

  // Il difetto della review non è un valore sbagliato oggi (i 9 path di M0
  // sono tutti monoparola: camelCase e snake_case coincidono, quindi qualunque
  // bug di casing è invisibile) -- è che il valore vive DUE VOLTE, come
  // letterali indipendenti in applyOp.ts e in apply.go, senza nulla che li
  // tenga allineati. Questi due controlli leggono il SORGENTE (come fa già
  // golden.test.ts per le fixture) per dimostrare che quella duplicazione è
  // stata eliminata per davvero, non solo "anche" corretta: applyOp.ts non
  // deve più definire il proprio Set letterale, e ops.ts non deve più
  // accettare `paths: string[]` ai punti di costruzione di un op reale.
  it("applyOp.ts importa l'elenco condiviso invece di ridefinirlo come Set letterale", () => {
    const src = readSrc("applyOp.ts");
    expect(src).toMatch(/from ["']\.\/maskPaths["']/);
    expect(src).not.toMatch(/new Set\(\[\s*"x"/);
  });

  it("tools/ops.ts::makeSetPropsOp tipizza paths come MaskPath[], non come string[] arbitrario", () => {
    const src = readSrc("../tools/ops.ts");
    expect(src).toMatch(/paths:\s*MaskPath\[\]/);
    expect(src).not.toMatch(/paths:\s*string\[\]/);
  });
});

// ---------------------------------------------------------------------------
// Il trasporto è JSON: createConnectTransport (connect-web) non passa
// useBinaryFormat, quindi ogni SubmitOp passa da qui. google.protobuf.FieldMask
// ha una codifica JSON che RISCRIVE il path invece di trasportarlo verbatim
// (verificato in node_modules/@bufbuild/protobuf/dist/esm/{to,from}-json.js):
// il filo porta lowerCamelCase, la libreria pretende che il path TS/Go sia
// scritto in snake_case. I 9 path attuali sono tutti monoparola, quindi le due
// forme coincidono e il problema è invisibile -- il primo path multiparola
// (corner_radius, il prossimo candidato naturale: RectNode.corner_radius,
// citato esplicitamente dalla review) lo rende visibile.
// ---------------------------------------------------------------------------
describe("SetProperties.mask multiparola sul filo JSON", () => {
  it("un path scritto nella convenzione istintiva TS (camelCase) NON arriva mai sul filo: toJson lancia", () => {
    const patch = create(NodeSchema, { shape: { case: "rect", value: { cornerRadius: 12 } } });
    const op = create(OpSchema, {
      opId: "op1", docId: "doc1",
      kind: { case: "setProps", value: { id: "n1", patch, mask: { paths: ["cornerRadius"] } } },
    });
    expect(() => toJson(OpSchema, op)).toThrow(/irreversible/);
  });

  it("un path scritto correttamente in snake_case sopravvive al round trip toJson -> fromJson", () => {
    const patch = create(NodeSchema, { shape: { case: "rect", value: { cornerRadius: 12 } } });
    const op = create(OpSchema, {
      opId: "op1", docId: "doc1",
      kind: { case: "setProps", value: { id: "n1", patch, mask: { paths: ["corner_radius"] } } },
    });

    const wire = toJson(OpSchema, op) as { setProps?: { mask?: string } };
    // Sul filo il FieldMask è una STRINGA singola (non un array), path uniti
    // da virgola, in lowerCamelCase -- esattamente come "x,y" nelle fixture
    // golden esistenti, solo che qui la conversione non è l'identità.
    expect(wire.setProps?.mask).toBe("cornerRadius");

    const decoded = fromJson(OpSchema, wire);
    expect(decoded.kind.case).toBe("setProps");
    if (decoded.kind.case !== "setProps") throw new Error("unreachable");
    // fieldMaskFromJson riconverte in snake_case: il round trip deve tornare
    // ESATTAMENTE al path con cui siamo partiti, non alla forma sul filo.
    expect(decoded.kind.value.mask?.paths).toEqual(["corner_radius"]);
    expect(isMaskPath("corner_radius")).toBe(false); // vedi nota nel test seguente
  });

  it("un path multiparola round-trippato correttamente, ma non ancora supportato da Go, viene rifiutato TUTTO da applyOp -- non applicato a metà, non un crash", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1"));

    const patch = create(NodeSchema, { x: 999, shape: { case: "rect", value: { cornerRadius: 12 } } });
    const op = create(OpSchema, {
      opId: "op1", docId: "doc1",
      kind: { case: "setProps", value: { id: "n1", patch, mask: { paths: ["x", "corner_radius"] } } },
    });

    // La stessa strada del filo, non la costruzione diretta del messaggio:
    // build -> toJson (quello che fa davvero il transport) -> fromJson.
    const decoded = fromJson(OpSchema, toJson(OpSchema, op));
    s = applyOp(s, decoded);

    // core.applySetProps (Go, apply.go:79-86) non ha un case "corner_radius":
    // rifiuterebbe l'INTERO op con "unsupported mask path". applyOp deve fare
    // lo stesso -- e siccome valida l'intera mask PRIMA di mutare qualsiasi
    // campo, "x" non deve muoversi nemmeno se compare nella stessa mask.
    // NOTA: quando Go guadagnerà un case "corner_radius" (M1b), questa
    // asserzione andrà capovolta assieme a quel cambio -- vedi maskPaths.ts.
    expect(s.nodes["n1"].x).toBe(0);
    expect(s.nodes["n1"].cornerRadius).toBe(0);
  });

  it("un path REALMENTE supportato da Go viene applicato da applyOp dopo lo stesso round trip sul filo (non solo via create() diretto)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1"));

    const patch = create(NodeSchema, { x: 42, y: 7 });
    const op = create(OpSchema, {
      opId: "op1", docId: "doc1",
      kind: { case: "setProps", value: { id: "n1", patch, mask: { paths: ["x", "y"] } } },
    });
    const decoded = fromJson(OpSchema, toJson(OpSchema, op));
    s = applyOp(s, decoded);
    expect(s.nodes["n1"].x).toBe(42);
    expect(s.nodes["n1"].y).toBe(7);
  });
});
