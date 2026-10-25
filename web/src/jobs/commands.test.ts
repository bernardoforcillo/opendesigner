import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { executeJob } from "./editorJobs";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

const style = { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" as const };
const text = (id: string, content: string, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 200, height: 40, rotation: 0,
  fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style }, ...over,
});
const cmd = async (o: Record<string, unknown>, input: { name: string; data: Uint8Array } | null = null) => {
  const r = await executeJob("command", JSON.stringify(o), {}, input);
  return { ...r, data: r.text ? JSON.parse(r.text) : undefined };
};
const nodes = () => [...useScene.getState().scene!.nodes.values()];

beforeEach(() => {
  const s = emptyScene("d", "Doc");
  s.nodes = s.nodes.set("t1", text("t1", "Colour and colour, COLOUR."));
  useScene.setState({ scene: null, selection: [], gesture: null, notice: null, undoStack: [], redoStack: [] });
  useScene.getState().setScene(s);
  useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
});

describe("find_change", () => {
  it("lists matches with their context, then replaces them all in one undo step", async () => {
    const found = await cmd({ name: "find_change", query: "colour" });
    expect(found.ok).toBe(true);
    expect(found.data.count).toBe(3);
    expect(found.data.matches[0]).toMatchObject({ nodeId: "t1", start: 0, end: 6, text: "Colour" });
    const sensitive = await cmd({ name: "find_change", query: "colour", matchCase: true });
    expect(sensitive.data.count).toBe(1);
    const done = await cmd({ name: "find_change", query: "colour", replace: "color" });
    expect(done.data.replaced).toBe(3);
    expect(useScene.getState().scene!.nodes.get("t1")!.text!.content).toBe("color and color, color.");
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.get("t1")!.text!.content).toBe("Colour and colour, COLOUR.");
  });
  it("supports regular expressions with groups, and refuses a broken pattern", async () => {
    await cmd({ name: "find_change", query: "(c)olour", regex: true, matchCase: true, replace: "$1ouleur" });
    expect(useScene.getState().scene!.nodes.get("t1")!.text!.content).toBe("Colour and couleur, COLOUR.");
    const bad = await cmd({ name: "find_change", query: "(", regex: true });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/invalid pattern/);
  });
});

describe("tables", () => {
  it("inserts a table and edits its rows and columns", async () => {
    const made = await cmd({ name: "insert_table", rows: 3, cols: 2, x: 10, y: 10, cellWidth: 100, cellHeight: 30 });
    expect(made.ok).toBe(true);
    expect(made.data.cells).toBe(6);
    const tableId = made.data.tableId as string;
    expect(nodes().filter((n) => n.meta?.["table.cell"] !== undefined || n.parentId === tableId).length).toBeGreaterThan(6);
    expect((await cmd({ name: "edit_table", tableId, action: "add_row", index: 0 })).ok).toBe(true);
    expect((await cmd({ name: "edit_table", tableId, action: "resize_column", index: 1, size: 200 })).ok).toBe(true);
    expect(useScene.getState().scene!.nodes.get(tableId)!.meta!["table.cols"]).toBe("100,200");
    expect(useScene.getState().scene!.nodes.get(tableId)!.meta!["table.rows"]).toBe("30,30,30,30");
    expect((await cmd({ name: "edit_table", tableId, action: "delete_column", index: 5 })).ok).toBe(false);
    expect((await cmd({ name: "edit_table", tableId, action: "explode", index: 0 })).message).toMatch(/action must be/);
    expect((await cmd({ name: "edit_table", tableId: "nope", action: "add_row", index: 0 })).message).toMatch(/not a table/);
  });
  it("refuses impossible tables", async () => {
    expect((await cmd({ name: "insert_table", rows: 0, cols: 2 })).ok).toBe(false);
    expect((await cmd({ name: "insert_table", rows: 2, cols: 2, headerRows: 5 })).ok).toBe(false);
    expect((await cmd({ name: "insert_table", rows: 2, cols: 2, parentId: "nope" })).ok).toBe(false);
  });
});

describe("generate_contents", () => {
  it("writes the table of contents from the headings, and says when there are none", async () => {
    expect((await cmd({ name: "generate_contents", kind: "toc" })).message).toMatch(/No headings yet/);
    const s = useScene.getState().scene!;
    useScene.getState().setScene({
      ...s,
      textStyles: { h1: { id: "h1", name: "Heading", style, outlineLevel: 1 } },
      nodes: s.nodes.set("h", text("h", "Chapter One", { text: { content: "Chapter One", style, paragraphStyles: ["h1"] } })),
    });
    const r = await cmd({ name: "generate_contents", kind: "toc", maxLevel: 2 });
    expect(r.ok).toBe(true);
    expect(r.data.lines).toBe(1);
    const gen = nodes().find((n) => n.meta?.["contents.kind"] === "toc")!;
    expect(gen.text!.content).toContain("Chapter One");
    expect((await cmd({ name: "generate_contents", kind: "glossary" })).message).toBe("kind must be toc or index");
  });
});

describe("override_master_item", () => {
  it("copies a master item onto the page and hides the master's one there", async () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({
      ...s,
      pages: [{ id: "page1", name: "One", masterId: "m1" }, { id: "m1", name: "A-Master", isMaster: true }],
      nodes: s.nodes.set("band", text("band", "Header", { parentId: "m1" })),
    });
    const r = await cmd({ name: "override_master_item", pageId: "page1", masterNodeId: "band" });
    expect(r.ok).toBe(true);
    expect(r.data.copiedNodeIds).toHaveLength(1);
    expect(useScene.getState().scene!.pages[0]!.hiddenMasterItems).toEqual(["band"]);
    expect((await cmd({ name: "override_master_item", pageId: "m1", masterNodeId: "band" })).ok).toBe(false);
    expect((await cmd({ name: "override_master_item", pageId: "page1", masterNodeId: "ghost" })).ok).toBe(false);
  });
});

describe("command", () => {
  it("rejects an unknown command", async () => {
    expect((await cmd({ name: "rm_rf" })).message).toBe("unknown command rm_rf");
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("commands that take a file", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("say so when the file is missing", async () => {
    for (const name of ["place_image", "import_svg", "import_pdf", "upload_font", "relink_image", "import_fig"]) {
      expect((await cmd({ name })).message).toBe(`${name} needs an input file`);
    }
  });

  it("import an SVG as editable nodes on the page asked for", async () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, pages: [{ id: "page1", name: "One" }, { id: "p2", name: "Two" }] });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#f00"/></svg>';
    const r = await cmd({ name: "import_svg", pageId: "p2", x: 100, y: 100 }, { name: "box.svg", data: bytes(svg) });
    expect(r.ok).toBe(true);
    const made = nodes().find((n) => n.id === r.data.nodeId)!;
    expect(made.parentId).toBe("p2");
    expect((await cmd({ name: "import_svg", pageId: "nope" }, { name: "a.svg", data: bytes(svg) })).message).toBe("pageId must be a regular page");
  });

  it("upload a font into the document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hash: "a".repeat(64), size: 4, contentType: "font/ttf" }), { status: 200 })));
    const r = await cmd({ name: "upload_font", family: "Acme Sans", weight: "700", italic: true }, { name: "acme.ttf", data: bytes("0000") });
    expect(r.ok).toBe(true);
    const fonts = Object.values(useScene.getState().scene!.fonts);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatchObject({ family: "Acme Sans", weight: "700", style: "italic", assetHash: "a".repeat(64) });
    const again = await cmd({ name: "upload_font", family: "Acme Sans", weight: "700", italic: true }, { name: "acme.ttf", data: bytes("0000") });
    expect(again.message).toMatch(/already exists/);
    expect((await cmd({ name: "upload_font", family: "X", weight: "650" }, { name: "x.ttf", data: bytes("0") })).message).toMatch(/weight must be/);
    expect((await cmd({ name: "upload_font" }, { name: "x.ttf", data: bytes("0") })).message).toBe("family is required");
  });

  it("refuse a bad PDF mode and a relink of something that is not an image", async () => {
    expect((await cmd({ name: "import_pdf", mode: "vector" }, { name: "a.pdf", data: bytes("%PDF") })).message).toBe("mode must be editable or image");
    expect((await cmd({ name: "relink_image", nodeId: "t1" }, { name: "a.png", data: bytes("x") })).ok).toBe(false);
  });
});
