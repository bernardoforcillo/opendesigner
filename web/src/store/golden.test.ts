import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromJson } from "@bufbuild/protobuf";
import { OpSchema, DocumentSchema } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene, fromDocument } from "./types";

describe("golden parity", () => {
  it("create_and_move matches expected document", () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../testdata/golden/create_and_move.json"), "utf8"));
    let scene = emptyScene(raw.docId, "Untitled");
    for (const opJson of raw.ops) scene = applyOp(scene, fromJson(OpSchema, opJson));
    const expected = fromDocument(fromJson(DocumentSchema, raw.expected));
    expect(scene.nodes).toEqual(expected.nodes);
  });
});
