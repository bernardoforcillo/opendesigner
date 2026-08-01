import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromJson } from "@bufbuild/protobuf";
import { OpSchema, DocumentSchema } from "../gen/brawt/v1/brawt_pb";
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
      let scene = emptyScene(raw.docId, "Untitled");
      for (const opJson of raw.ops) scene = applyOp(scene, fromJson(OpSchema, opJson));
      const expected = fromDocument(fromJson(DocumentSchema, raw.expected));
      expect(scene.nodes).toEqual(expected.nodes);
    });
  }
});
