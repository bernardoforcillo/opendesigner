import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { executeJob } from "@/jobs/editorJobs";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import type { NodeLite } from "@/store/types";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";

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
    expect((await cmd({ name: "generate_contents", kind: "glossary" })).message).toBe("kind must be toc, index or endnotes");
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

describe("structure commands", () => {
  const rect = (id: string, x: number, key: string, over: Partial<NodeLite> = {}): NodeLite => ({
    id, parentId: "page1", orderKey: key, name: id, visible: true, opacity: 1, x, y: 0, width: 20, height: 20, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  });
  beforeEach(() => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.delete("t1").set("A", rect("A", 0, "a1")).set("B", rect("B", 50, "a2")).set("C", rect("C", 130, "a3")) });
  });
  const orderOf = () => nodes().filter((n) => n.parentId === "page1" && n.kind === "rect").sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1)).map((n) => n.id);

  it("groups and ungroups", async () => {
    const g = await cmd({ name: "group_nodes", nodeIds: ["A", "B"] });
    expect(g.ok).toBe(true);
    const group = nodes().find((n) => n.kind === "group")!;
    expect(nodes().find((n) => n.id === "A")!.parentId).toBe(group.id);
    expect((await cmd({ name: "ungroup_nodes", nodeIds: [group.id] })).ok).toBe(true);
    expect(nodes().find((n) => n.id === "A")!.parentId).toBe("page1");
    expect((await cmd({ name: "ungroup_nodes", nodeIds: ["A"] })).message).toBe("none of those nodes is a group");
    expect((await cmd({ name: "group_nodes", nodeIds: ["ghost"] })).message).toBe("no node ghost");
    expect((await cmd({ name: "group_nodes", nodeIds: [] })).message).toMatch(/non-empty list/);
  });

  it("aligns and distributes", async () => {
    expect((await cmd({ name: "align_nodes", nodeIds: ["A", "B", "C"], command: "left" })).data.moved).toBe(2);
    expect(nodes().find((n) => n.id === "C")!.x).toBe(0);
    await cmd({ name: "align_nodes", nodeIds: ["A", "B", "C"], command: "left" });
    expect((await cmd({ name: "align_nodes", nodeIds: ["A", "B"], command: "distribute-h" })).message).toMatch(/at least three/);
    expect((await cmd({ name: "align_nodes", nodeIds: ["A", "B"], command: "diagonal" })).message).toMatch(/command must be/);
  });

  it("makes a live boolean group and changes its operation", async () => {
    const r = await cmd({ name: "boolean_operation", nodeIds: ["A", "B"], op: "union" });
    expect(r.ok).toBe(true);
    const gid = r.data.groupId as string;
    expect(nodes().find((n) => n.id === gid)!.meta!["boolean.op"] ?? Object.values(nodes().find((n) => n.id === gid)!.meta ?? {})[0]).toBeTruthy();
    expect((await cmd({ name: "boolean_operation", nodeIds: [gid], op: "subtract" })).ok).toBe(true);
    expect((await cmd({ name: "boolean_operation", nodeIds: ["C"], op: "union" })).ok).toBe(false);
    expect((await cmd({ name: "boolean_operation", nodeIds: ["C"], op: "xor" })).message).toMatch(/op must be/);
    expect((await cmd({ name: "flatten_boolean", groupId: gid })).ok).toBe(true);
    expect((await cmd({ name: "flatten_boolean", groupId: "C" })).ok).toBe(false);
  });

  it("changes the stacking order", async () => {
    expect(orderOf()).toEqual(["A", "B", "C"]);
    await cmd({ name: "reorder_node", nodeId: "A", to: "front" });
    expect(orderOf()).toEqual(["B", "C", "A"]);
    await cmd({ name: "reorder_node", nodeId: "A", to: "backward" });
    expect(orderOf()).toEqual(["B", "A", "C"]);
    await cmd({ name: "reorder_node", nodeId: "A", to: "forward" });
    expect(orderOf()).toEqual(["B", "C", "A"]);
    await cmd({ name: "reorder_node", nodeId: "A", to: "back" });
    expect(orderOf()).toEqual(["A", "B", "C"]);
    expect((await cmd({ name: "reorder_node", nodeId: "A", to: "back" })).data.moved).toBe(false);
    expect((await cmd({ name: "reorder_node", nodeId: "A", to: "up" })).message).toMatch(/to must be/);
  });

  it("duplicates nodes", async () => {
    const r = await cmd({ name: "duplicate_nodes", nodeIds: ["A"] });
    expect(r.ok).toBe(true);
    expect(r.data.nodeIds).toHaveLength(1);
    expect(nodes().filter((n) => n.kind === "rect")).toHaveLength(4);
  });
});

describe("vectors", () => {
  const tri = [{ closed: true, anchors: [{ x: 100, y: 100 }, { x: 160, y: 100 }, { x: 130, y: 160 }] }];

  it("creates a vector whose box is the true bounds of its geometry", async () => {
    const r = await cmd({ name: "create_vector", paths: tri, fill: { r: 1, g: 0, b: 0 }, stroke: { color: { r: 0, g: 0, b: 0 }, weight: 2 }, nodeName: "Triangle" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ x: 100, y: 100, width: 60, height: 60 });
    const n = nodes().find((x) => x.id === r.data.nodeId)!;
    expect(n.kind).toBe("vector");
    expect(n.name).toBe("Triangle");
    expect(n.vector!.subpaths[0]!.anchors[0]).toMatchObject({ x: 0, y: 0 }); // normalised: the box carries the position
    expect(n.fills[0]).toMatchObject({ r: 1, g: 0, b: 0, a: 1 });
    expect(n.strokes[0]!.weight).toBe(2);
  });

  it("a curve's box is its true bounds, not its control points'", async () => {
    const r = await cmd({ name: "create_vector", paths: [{ anchors: [{ x: 0, y: 0, outX: 0, outY: 100 }, { x: 100, y: 0, inX: 0, inY: 100 }] }] });
    expect(r.data.height).toBeCloseTo(75, 5); // a cubic with both handles at 100 reaches 0.75 of it
  });

  it("rewrites a path and keeps the box in step", async () => {
    const made = await cmd({ name: "create_vector", paths: tri });
    const r = await cmd({ name: "set_vector_path", nodeId: made.data.nodeId, paths: [{ closed: true, anchors: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }] }] });
    expect(r.ok).toBe(true);
    const n = nodes().find((x) => x.id === made.data.nodeId)!;
    expect(n).toMatchObject({ x: 10, y: 10, width: 40, height: 20 });
  });

  it("refuses bad paths", async () => {
    expect((await cmd({ name: "create_vector", paths: [] })).message).toMatch(/1..200 paths/);
    expect((await cmd({ name: "create_vector", paths: [{ anchors: [{ x: 1 }] }] })).message).toMatch(/numeric x and y/);
    expect((await cmd({ name: "create_vector", paths: tri, fill: { r: "red" } })).message).toMatch(/r, g and b/);
    expect((await cmd({ name: "set_vector_path", nodeId: "t1", paths: tri })).message).toBe("nodeId is not a vector node");
  });
});

describe("long-document commands", () => {
  it("apply a table style to header, body and alternate rows, and remember it", async () => {
    const made = await cmd({ name: "insert_table", rows: 4, cols: 2, headerRows: 1 });
    const tableId = made.data.tableId as string;
    const s = useScene.getState().scene!;
    const os = (id: string) => ({ id, name: id, sets: ["fills" as const], fills: [{ r: 1, g: 0, b: 0, a: 1 }] });
    const td = (id: string) => ({ id, name: id, style: { fontFamily: "", fontSize: 12, fontWeight: "", lineHeight: 0, align: "left" as const } });
    useScene.getState().setScene({
      ...s,
      objectStyles: { H: os("H"), B: os("B"), A: os("A") },
      textStyles: { th: td("th"), tb: td("tb") },
      settings: { tableStyles: [{ id: "ts1", name: "Report", headerObjectStyleId: "H", bodyObjectStyleId: "B", altObjectStyleId: "A", headerTextStyleId: "th", bodyTextStyleId: "tb" }] },
    });
    const r = await cmd({ name: "apply_table_style", tableId, styleId: "ts1" });
    expect(r.ok).toBe(true);
    const rects = nodes().filter((n) => n.meta?.["table.cell"] !== undefined);
    const style = (row: number) => rects.filter((n) => n.meta!["table.cell"]!.startsWith(`${row},`)).map((n) => n.objectStyleId);
    expect(style(0)).toEqual(["H", "H"]);
    expect(style(1)).toEqual(["B", "B"]);
    expect(style(2)).toEqual(["A", "A"]);
    expect(style(3)).toEqual(["B", "B"]);
    const texts = nodes().filter((n) => n.meta?.["table.text"] !== undefined);
    expect(texts.filter((n) => n.meta!["table.text"]!.startsWith("0,")).every((n) => n.textStyleId === "th")).toBe(true);
    expect(texts.filter((n) => !n.meta!["table.text"]!.startsWith("0,")).every((n) => n.textStyleId === "tb")).toBe(true);
    expect(nodes().find((n) => n.id === tableId)!.meta!["table.style"]).toBe("ts1");
    expect((await cmd({ name: "apply_table_style", tableId, styleId: "nope" })).message).toMatch(/no table style/);
    expect((await cmd({ name: "apply_table_style", tableId: "t1", styleId: "ts1" })).message).toMatch(/not a table/);
  });

  it("checks the text for typographic slips and lists editorial notes", async () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("t2", text("t2", "It is is  a \"test\"... see - here , ok[!fix me]")) });
    const r = await cmd({ name: "check_text" });
    const codes = (r.data.issues as { nodeId: string; code: string }[]).filter((i) => i.nodeId === "t2").map((i) => i.code);
    for (const c of ["repeated-word", "double-space", "straight-quote", "three-dots", "spaced-hyphen", "space-before-punctuation"]) expect(codes).toContain(c);
    const only = await cmd({ name: "check_text", checks: ["three-dots"] });
    expect((only.data.issues as { code: string }[]).every((i) => i.code === "three-dots")).toBe(true);
    expect((await cmd({ name: "check_text", checks: ["spelling"] })).message).toMatch(/checks must be/);
    const notes = await cmd({ name: "list_editorial_notes" });
    expect(notes.data.notes).toHaveLength(1);
    expect(notes.data.notes[0]).toMatchObject({ nodeId: "t2", text: "fix me" });
  });

  it("generates the endnotes", async () => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("e1", text("e1", "One[*First source] two[*Second source]")) });
    const r = await cmd({ name: "generate_contents", kind: "endnotes" });
    expect(r.ok).toBe(true);
    expect(r.data.lines).toBe(2);
    const gen = nodes().find((n) => n.meta?.["contents.kind"] === "endnotes")!;
    expect(gen.text!.content).toBe("1. First source\n2. Second source");
  });
});

describe("object-tool commands", () => {
  const rect = (id: string, x: number, over: Partial<NodeLite> = {}): NodeLite => ({
    id, parentId: "page1", orderKey: id, name: id, visible: true, opacity: 1, x, y: 0, width: 40, height: 20, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  });
  beforeEach(() => {
    const s = useScene.getState().scene!;
    useScene.getState().setScene({ ...s, nodes: s.nodes.set("r1", rect("r1", 0)).set("r2", rect("r2", 100)) });
  });

  it("step_and_repeat, set_gap and the refusals", async () => {
    const r = await cmd({ name: "step_and_repeat", nodeIds: ["r1"], count: 2, dx: 0, dy: 30 });
    expect(r.ok).toBe(true);
    expect(r.data.nodeIds).toHaveLength(2);
    expect(nodes().filter((n) => n.kind === "rect")).toHaveLength(4);
    useScene.getState().undo();
    expect(nodes().filter((n) => n.kind === "rect")).toHaveLength(2);
    expect((await cmd({ name: "step_and_repeat", nodeIds: ["r1"], count: 0, dx: 1, dy: 0 })).message).toMatch(/count/);
    const g = await cmd({ name: "set_gap", nodeIds: ["r1", "r2"], axis: "x", gap: 10 });
    expect(g.data.moved).toBe(1);
    expect(useScene.getState().scene!.nodes.get("r2")!.x).toBe(50);
    expect((await cmd({ name: "set_gap", nodeIds: ["r1", "r2"], axis: "z", gap: 1 })).message).toMatch(/axis/);
  });

  it("create_qr_code, clip_with_shape, find_objects and change_objects", async () => {
    const qr = await cmd({ name: "create_qr_code", text: "https://example.org", size: 90, x: 10, y: 10 });
    expect(qr.ok).toBe(true);
    expect(nodes().filter((n) => n.parentId === qr.data.groupId).map((n) => n.kind).sort()).toEqual(["rect", "vector"]);
    expect((await cmd({ name: "create_qr_code", text: "x".repeat(400) })).message).toMatch(/too long/);
    const clip = await cmd({ name: "clip_with_shape", shapeId: "r1", contentIds: ["r2"] });
    expect(useScene.getState().scene!.nodes.get("r1")!.isMask).toBe(true);
    expect((await cmd({ name: "clip_with_shape", shapeId: "r1", release: true })).data.released).toBe(true);
    expect(clip.data.groupId).toBeTruthy();
    const found = await cmd({ name: "find_objects", kind: "rect", fill: { r: 1, g: 0, b: 0 }, nameMatches: "^r[12]$" });
    expect(found.data.count).toBe(2);
    const changed = await cmd({ name: "change_objects", kind: "rect", nameMatches: "^r[12]$", change: { fill: { r: 0, g: 0, b: 1 }, opacity: 0.5 } });
    expect(changed.data.matched).toBe(2);
    expect(useScene.getState().scene!.nodes.get("r1")!.fills[0]).toMatchObject({ r: 0, b: 1 });
    expect(useScene.getState().scene!.nodes.get("r1")!.opacity).toBe(0.5);
    expect((await cmd({ name: "find_objects" })).message).toMatch(/at least one/);
    expect((await cmd({ name: "change_objects", kind: "rect", change: {} })).message).toMatch(/at least one/);
  });

  it("snippets round-trip through export_snippet and place_snippet", async () => {
    const e = await cmd({ name: "export_snippet", nodeIds: ["r1", "r2"] });
    const p = await cmd({ name: "place_snippet", snippet: e.data.snippet, x: 300, y: 300 });
    expect(p.ok).toBe(true);
    const placed = (p.data.nodeIds as string[]).map((id) => useScene.getState().scene!.nodes.get(id)!);
    expect(placed.map((n) => [n.x, n.y])).toEqual([[300, 300], [400, 300]]);
    expect((await cmd({ name: "place_snippet", snippet: "{}" })).message).toMatch(/not an opendesigner snippet/);
  });

  it("fit_frame explains what it cannot do", async () => {
    expect((await cmd({ name: "fit_frame", nodeId: "r1", mode: "fit" })).message).toMatch(/no image fill/);
    expect((await cmd({ name: "fit_frame", nodeId: "r1", mode: "stretch" })).message).toMatch(/mode must be/);
  });
});

describe("place_document", () => {
  const fx = async (n: string, type: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return { name: n, data: new Uint8Array(readFileSync(join(process.cwd(), "src/tools/__fixtures__", n))), type };
  };
  it("places a Word file as styled text and an Excel sheet as a table", async () => {
    const d = await fx("sample.docx", "");
    const r = await cmd({ name: "place_document", x: 10, y: 10, width: 300 }, d);
    expect(r.ok).toBe(true);
    expect(r.data.paragraphs).toBe(4);
    expect(useScene.getState().scene!.nodes.get(r.data.nodeId)!.text!.content).toContain("Chapter One");
    const x = await fx("sample.xlsx", "");
    const t = await cmd({ name: "place_document" }, x);
    expect(t.data.kind).toBe("table");
    expect((await cmd({ name: "place_document" }, { name: "a.txt", data: new Uint8Array([65]) })).message).toMatch(/\.docx, \.rtf and \.xlsx/);
    expect((await cmd({ name: "place_document" }, { name: "bad.docx", data: new Uint8Array([1, 2, 3]) })).message).toMatch(/not a \.docx/);
  });
});

describe("import_idml", () => {
  it("adds the pages and items of an IDML file made by export_idml", async () => {
    const { buildIdml } = await import("@/export/idml");
    const before = useScene.getState().scene!;
    const pkg = buildIdml(before, "Doc")!;
    const pagesBefore = useScene.getState().scene!.pages.length;
    const r = await cmd({ name: "import_idml" }, { name: "x.idml", data: pkg.bytes });
    expect(r.ok).toBe(true);
    expect(r.data.pages).toBe(1);
    expect(useScene.getState().scene!.pages.length).toBe(pagesBefore + 1);
    expect((await cmd({ name: "import_idml" }, { name: "x.idml", data: new Uint8Array([1, 2, 3, 4]) })).message).toMatch(/not an IDML/);
    useScene.getState().undo();
    expect(useScene.getState().scene!.pages.length).toBe(pagesBefore);
  });
});

describe("ink, overprint and batch commands", () => {
  it("reports inks, sets overprint and converts spots", async () => {
    const { createSwatchOps } = await import("@/tools/swatches");
    const s0 = useScene.getState().scene!;
    const made = createSwatchOps(s0, { name: "Gold", cmyk: { c: 10, m: 30, y: 90, k: 0 }, spotName: "PANTONE 871 C" })!;
    for (const op of made.ops) useScene.getState().apply(op);
    expect((await cmd({ name: "ink_report" })).data.spots[0].name).toBe("PANTONE 871 C");
    expect((await cmd({ name: "ink_report", limit: 5 })).message).toMatch(/limit/);
    expect((await cmd({ name: "set_overprint", nodeIds: ["t1"], mode: "both" })).data.changed).toBe(1);
    expect(useScene.getState().scene!.nodes.get("t1")!.meta!.overprint).toBe("both");
    expect((await cmd({ name: "set_overprint", nodeIds: ["t1"], mode: "x" })).message).toMatch(/mode must be/);
    expect((await cmd({ name: "convert_spots_to_process", inks: ["nope"] })).message).toMatch(/no spot ink/);
    expect((await cmd({ name: "convert_spots_to_process" })).data.converted).toBe(1);
    expect((await cmd({ name: "ink_report" })).data.spots).toEqual([]);
  });

  it("runs a batch in order, stops at the first failure and refuses nesting and file commands", async () => {
    const ok = await cmd({ name: "batch", commands: [{ name: "set_overprint", nodeIds: ["t1"], mode: "fill" }, { name: "ink_report" }] });
    expect(ok.ok).toBe(true);
    expect(ok.data.results).toHaveLength(2);
    const bad = await cmd({ name: "batch", commands: [{ name: "set_overprint", nodeIds: ["t1"], mode: "off" }, { name: "set_overprint", nodeIds: ["nope"], mode: "fill" }, { name: "ink_report" }] });
    expect(bad.message).toMatch(/commands\[1\] \(set_overprint\) failed: no node nope.*1 before it/);
    expect(useScene.getState().scene!.nodes.get("t1")!.meta?.overprint).toBeUndefined();
    expect((await cmd({ name: "batch", commands: [{ name: "batch", commands: [] }] })).message).toMatch(/cannot contain a batch/);
    expect((await cmd({ name: "batch", commands: [{ name: "place_image" }] })).message).toMatch(/needs a file/);
    expect((await cmd({ name: "batch", commands: [] })).message).toMatch(/1\.\.50/);
  });

  it("lists exactly the commands the switch handles", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/jobs/commands.ts"), "utf8");
    const main = src.slice(src.indexOf("export async function runCommand"));
    const inner = new Set(["add_row", "add_column", "delete_row", "delete_column", "resize_row", "resize_column"]); // the edit_table sub-cases
    const handled = [...main.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!).filter((n) => !inner.has(n)).sort();
    const listed = (await cmd({ name: "list_commands" })).data.commands as string[];
    expect([...new Set(handled)]).toEqual(listed);
  });
});
