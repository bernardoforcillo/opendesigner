import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldsIn, mergeOps, parseTable, placeholdersOnPage, substitute } from "@/tools/dataMerge";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import type { NodeLite } from "@/store/types";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";

describe("parseTable", () => {
  it("reads quoted cells, doubled quotes, embedded newlines and CRLF", () => {
    const t = parseTable('Name,Note\r\n"Smith, J.","said ""hi"""\r\nLee,"two\nlines"\r\n');
    expect(t.headers).toEqual(["Name", "Note"]);
    expect(t.rows).toEqual([["Smith, J.", 'said "hi"'], ["Lee", "two\nlines"]]);
  });
  it("detects semicolons and tabs, strips a BOM, skips blank lines", () => {
    expect(parseTable("﻿a;b\n1;2\n\n3;4").rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseTable("a\tb\n1\t2").headers).toEqual(["a", "b"]);
  });
  it("an empty file is an empty table", () => {
    expect(parseTable("")).toEqual({ headers: [], rows: [] });
  });
});

describe("substitute", () => {
  it("replaces known fields only and keeps offsets of what follows", () => {
    const s = substitute("Hi {{Name}}, see {{Nope}}!", { Name: "Bernardo" });
    expect(s.text).toBe("Hi Bernardo, see {{Nope}}!");
    expect(s.map(0)).toBe(0);
    expect(s.map("Hi {{Name}}, ".length)).toBe("Hi Bernardo, ".length);
    expect(s.map("Hi {{Name}}".length)).toBe("Hi Bernardo".length);
  });
  it("turns line breaks in a value into spaces so the paragraph structure survives", () => {
    expect(substitute("{{A}}", { A: "x\ny" }).text).toBe("x y");
  });
  it("finds placeholders with spaces inside the braces", () => {
    expect(fieldsIn("{{ First }} {{Last}}")).toEqual(["First", "Last"]);
  });
});

const style = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const text = (id: string, content: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 20, rotation: 0,
  fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style }, ...over,
});

describe("mergeOps", () => {
  beforeEach(() => {
    const s = emptyScene("doc", "Doc");
    s.nodes = s.nodes.set("a", text("a", "Dear {{Name}},", { text: { content: "Dear {{Name}},", style, runs: [{ start: 13, end: 14, styleId: "x" }] } }));
    s.nodes = s.nodes.set("b", text("b", "Static", { meta: { "link.url": "https://x.test/{{Id}}" } }));
    useScene.getState().setScene(s);
    useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
  });

  it("lists the placeholders of the page and what the table does not cover", () => {
    const s = useScene.getState().scene!;
    expect(placeholdersOnPage(s, "page1")).toEqual(["Name", "Id"]);
    const plan = mergeOps(s, "page1", { headers: ["Name", "Extra"], rows: [["Ada", "x"]] });
    expect(plan.missingFields).toEqual(["Id"]);
    expect(plan.unusedFields).toEqual(["Extra"]);
  });

  it("adds one page per record after the template, with values in text, runs and link URLs", () => {
    const s = useScene.getState().scene!;
    const plan = mergeOps(s, "page1", { headers: ["Name", "Id"], rows: [["Ada", "7"], ["Grace Hopper", "8"]] });
    expect(plan.pages).toBe(2);
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture(plan.ops);
    const after = useScene.getState().scene!;
    expect(after.pages.map((p) => p.name)).toEqual(["Page 1", "Page 1 1", "Page 1 2"]);
    const texts = (pageId: string) => [...after.nodes.values()].filter((n) => n.parentId === pageId && n.text).map((n) => n.text!.content).sort();
    expect(texts("page1")).toEqual(["Dear {{Name}},", "Static"]);
    const second = after.pages[2]!.id;
    expect(texts(second)).toEqual(["Dear Grace Hopper,", "Static"]);
    const run = [...after.nodes.values()].find((n) => n.parentId === second && n.text?.runs)!;
    expect(run.text!.runs![0]).toMatchObject({ start: "Dear Grace Hopper".length, end: "Dear Grace Hopper,".length });
    const link = [...after.nodes.values()].find((n) => n.parentId === second && n.meta?.["link.url"])!;
    expect(link.meta!["link.url"]).toBe("https://x.test/8");
  });

  it("does nothing for an empty table", () => {
    expect(mergeOps(useScene.getState().scene!, "page1", { headers: ["Name"], rows: [] }).ops).toEqual([]);
  });
});

describe("parity with the server (internal/datamerge)", () => {
  // The same cases are checked by internal/datamerge/datamerge_test.go: the editor and the MCP tool read and merge alike.
  const cases = JSON.parse(readFileSync(join(process.cwd(), "..", "testdata", "merge", "cases.json"), "utf8")) as {
    tables: { in: string; headers: string[]; rows: string[][] }[];
    substitutions: { content: string; record: Record<string, string>; text: string; maps: [number, number][] }[];
  };
  it("reads the shared tables", () => {
    for (const c of cases.tables) expect(parseTable(c.in)).toEqual({ headers: c.headers, rows: c.rows });
  });
  it("substitutes the shared texts and maps the shared offsets", () => {
    for (const c of cases.substitutions) {
      const s = substitute(c.content, c.record);
      expect(s.text).toBe(c.text);
      for (const [from, to] of c.maps) expect(s.map(from)).toBe(to);
    }
  });
});
