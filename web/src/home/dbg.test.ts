import { it, expect } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { templateById, templateOps } from "../templates/catalog";

it("incremental extent == fresh extent", () => {
  let n = 0;
  const ops = templateOps(templateById("onboarding")!, "doc", "page1", () => `i${++n}`);
  let s = emptyScene("doc", "x");
  for (const op of ops) { s = applyOp(s, op); sceneIndexOf(s); }
  const inc = sceneIndexOf(s);
  const fresh = sceneIndexOf({ ...s });
  const diffs: string[] = [];
  for (const nd of s.nodes.values()) {
    const a = JSON.stringify(inc.extent.get(nd.id)), b = JSON.stringify(fresh.extent.get(nd.id));
    if (a !== b) diffs.push(`${nd.name}: inc=${a} fresh=${b}`);
  }
  console.log("DIFFS", diffs.length, diffs.slice(0, 6));
  expect(diffs.length).toBe(0);
});
