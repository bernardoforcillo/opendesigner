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
      // `rejected` lists the indices of the ops that the TWO implementations must
      // reject (a nonexistent parent, a reparent that closes a cycle).
      // Go verifies that Apply returns an error; here applyOp is total and has no
      // errors, so the observable equivalent is the UNCHANGED scene -- which is
      // what the client must show when the server rejects the op anyway.
      // See internal/core/golden_test.go::goldenFile.
      const rejected = new Set<number>(raw.rejected ?? []);
      let scene = emptyScene(raw.docId, "Untitled");
      raw.ops.forEach((opJson: unknown, i: number) => {
        const before = scene;
        scene = applyOp(scene, fromJson(OpSchema, opJson as never));
        if (rejected.has(i)) expect(scene, `op ${i} should have been rejected`).toEqual(before);
      });
      const expected = fromDocument(fromJson(DocumentSchema, raw.expected));
      expect(scene.nodes).toEqual(expected.nodes);
      // COMPONENTS are part of the document as much as nodes: on the Go side the
      // comparison is a proto.Equal on the whole Document (Document.components
      // included), so a fixture with ops on components
      // (createComponent/setInstanceOverride) would prove parity only halfway if
      // only the nodes were looked at here. A master referenced by rootNodeId,
      // never copied.
      expect(scene.components).toEqual(expected.components);
      // PAGES are part of the document as much as nodes: on the Go side the
      // comparison is a proto.Equal on the whole Document, so a fixture with
      // ops on pages (createPage/deletePage/renamePage) would prove parity
      // only halfway if only the nodes were looked at here -- and ORDER matters,
      // because it is that of the page selector.
      expect(scene.pages).toEqual(expected.pages);
      // FLOWS (and their transitions) are part of the document: on the Go side
      // the proto.Equal on the whole Document covers them, here they must be compared
      // separately -- including the cascade of a delete (transitions removed, start
      // emptied, hotspot reset).
      expect(scene.flows).toEqual(expected.flows);
      expect(scene.transitions).toEqual(expected.transitions);
      // Animation CLIPS (and the cascade of a delete: tracks removed, clips
      // whose target vanished deleted, rejections for easing/timing/duplicates).
      expect(scene.clips).toEqual(expected.clips);
    });
  }
});
