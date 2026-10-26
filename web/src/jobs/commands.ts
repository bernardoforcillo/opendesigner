import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { importFigFile } from "@/fig/importFig";
import { importPdfFile } from "@/pdf/importPdf";
import { uploadAsset } from "@/rpc/assets";
import { dropImages } from "@/tools/imageDrop";
import { relinkImage } from "@/tools/imageLinks";
import { importSvgFile } from "@/tools/svgImport";
import { addFontOp } from "@/ui/typographyOps";
import { findAll, replaceOps } from "@/store/findReplace";
import { useScene } from "@/store/store";
import { alignOps, type AlignCommand } from "@/selection/align";
import { orderKeyBetween } from "@/store/orderKey";
import { childrenOf } from "@/store/tree";
import { duplicateSelection } from "@/tools/clipboard";
import { groupOps, ungroupOps } from "@/tools/grouping";
import { makeSetPropsOp } from "@/tools/ops";
import { flattenGroupOps, liveBooleanOps, setBooleanOpOps, type BooleanOp } from "@/vector/boolean";
import { outlineStrokeOps } from "@/vector/outlineStroke";
import { booleanOpOf } from "@/vector/regions";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "@/gen/opendesigner/v1/opendesigner_pb";
import { nextOrderKey } from "@/store/orderKey";
import { normalizeVector } from "@/store/vectorGeometry";
import { toPbFills, toPbStrokes, toPbSubPaths, type FillLite, type SubPathLite } from "@/store/types";
import { makeCreateNodeOp, makeSetVectorPathOp, uuid } from "@/tools/ops";
import { changeObjectsOps, clipWithShapeOps, exportSnippet, findObjects, fitOps, gapOps, placeSnippetOps, qrOps, releaseClipOps, stepRepeatOps, type FitMode, type ObjectChange, type ObjectQuery } from "@/tools/objectTools";
import { QR_LEVELS, type QrLevel } from "@/tools/qrcode";
import { PlaceError, parseDocx, parseRtf, parseXlsx, placeTableOps, placeTextOps } from "@/tools/placeDocument";
import { IdmlError, idmlOps, parseIdml } from "@/export/idml";
import { convertSpotsOps, inkReport, mergeSpotsOps, overprintOps, type OverprintMode } from "@/tools/inks";
import { applyTableStyleOps } from "@/tools/tableOps";
import { CHECK_CODES, checkText, type CheckCode } from "@/tools/textChecks";
import { editorialNotes } from "@/store/textTokens";
import { generateContentsOps } from "@/tools/contents";
import { overrideMasterItemOps } from "@/tools/pageOps";
import { MAX_TABLE_SIDE, addColumnOps, addRowOps, createTableOps, deleteColumnOps, deleteRowOps, resizeTableOps, tableIdOf } from "@/tools/tableOps";
import type { JobResult } from "@/jobs/editorJobs";

// COMMANDS an agent runs over MCP that edit the document through the editor's own code: the same functions
// the menus and dialogs use build the ops (so there is ONE implementation of a table, a contents page, a
// find-and-change), and the result is applied as one gesture -- one undo step -- like a click. The editor must
// have the document open, as for the other editor jobs.

const ok = (data: unknown): JobResult => ({ ok: true, text: JSON.stringify(data) });
const fail = (message: string): JobResult => ({ ok: false, message });

function commit(ops: Op[]): void {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(ops);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** The node ids of `nodeIds`, or a message saying what is wrong with them. */
function nodeIdsOf(o: Record<string, unknown>, scene: { nodes: { has(id: string): boolean } }): string[] | string {
  if (!Array.isArray(o.nodeIds) || o.nodeIds.length === 0 || !o.nodeIds.every(isStr)) return "nodeIds must be a non-empty list of ids";
  const missing = (o.nodeIds as string[]).find((id) => !scene.nodes.has(id));
  return missing ? `no node ${missing}` : (o.nodeIds as string[]);
}

/** Paths from the command's options (absolute coordinates, handles relative to their anchor), or a message. */
function pathsOf(v: unknown): SubPathLite[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) return "paths must be a list of 1..200 paths";
  const out: SubPathLite[] = [];
  for (const [i, p] of v.entries()) {
    if (typeof p !== "object" || p === null || !Array.isArray((p as { anchors?: unknown }).anchors)) return `paths[${i}].anchors must be a list`;
    const raw = (p as { anchors: unknown[]; closed?: unknown }).anchors;
    if (raw.length === 0 || raw.length > 10000) return `paths[${i}] needs 1..10000 anchors`;
    const anchors: SubPathLite["anchors"] = [];
    for (const [k, a] of raw.entries()) {
      const o = a as Record<string, unknown>;
      const num = (key: string, dflt?: number) => (o?.[key] === undefined && dflt !== undefined ? dflt : o?.[key]);
      const vals = [num("x"), num("y"), num("inX", 0), num("inY", 0), num("outX", 0), num("outY", 0)];
      if (!vals.every(isNum)) return `paths[${i}].anchors[${k}] needs numeric x and y (and optional inX, inY, outX, outY)`;
      anchors.push({ x: vals[0] as number, y: vals[1] as number, inX: vals[2] as number, inY: vals[3] as number, outX: vals[4] as number, outY: vals[5] as number });
    }
    out.push({ anchors, closed: (p as { closed?: unknown }).closed === true });
  }
  return out;
}

function fillOf(v: unknown): FillLite | string {
  const c = v as Record<string, unknown> | undefined;
  if (!c || ![c.r, c.g, c.b].every(isNum)) return "a colour needs r, g and b from 0 to 1";
  const a = c.a === undefined ? 1 : c.a;
  if (!isNum(a)) return "a colour needs r, g and b from 0 to 1";
  return { r: c.r as number, g: c.g as number, b: c.b as number, a };
}

/** The first regular (non-master) page, or the one named. */
function pageIdFrom(o: Record<string, unknown>): string | string[] {
  const scene = useScene.getState().scene!;
  if (o.pageId !== undefined) {
    if (!isStr(o.pageId)) return ["pageId must be a string"];
    if (!scene.pages.some((p) => p.id === o.pageId)) return [`no page ${o.pageId}`];
    return o.pageId;
  }
  return scene.pages.find((p) => !p.isMaster)?.id ?? scene.pages[0]!.id;
}

/** Every command the editor runs (kept in step with the switch below by a test). */
const COMMAND_NAMES = ["align_nodes", "apply_table_style", "batch", "boolean_operation", "change_objects", "check_text", "clip_with_shape", "convert_spots_to_process", "create_qr_code", "create_vector", "duplicate_nodes", "edit_table", "export_snippet", "find_change", "find_objects", "fit_frame", "flatten_boolean", "generate_contents", "group_nodes", "ink_report", "insert_table", "list_commands", "list_editorial_notes", "merge_spot_inks", "outline_stroke", "override_master_item", "place_snippet", "reorder_node", "set_gap", "set_overprint", "set_vector_path", "step_and_repeat", "ungroup_nodes"];

/** Commands that read an input file sent with the job. */
const FILE_COMMANDS = new Set(["place_image", "relink_image", "import_svg", "import_pdf", "import_fig", "upload_font", "place_document", "import_idml"]);

/** The page a placed or imported thing lands on: the importers use the editor's current page, so it is set to the one asked for. */
function aimAt(o: Record<string, unknown>): string | null {
  if (o.pageId === undefined) return null;
  const scene = useScene.getState().scene!;
  if (!isStr(o.pageId) || !scene.pages.some((p) => p.id === o.pageId && !p.isMaster)) return "pageId must be a regular page";
  useScene.getState().setCurrentPage(o.pageId);
  return null;
}

/** What the importer said (it goes to the notice channel), as a result. */
function noticeResult(extra: Record<string, unknown> = {}): JobResult {
  const notice = useScene.getState().notice;
  return ok({ ...extra, ...(notice ? { message: notice } : {}) });
}

async function runFileCommand(o: Record<string, unknown>, file: File): Promise<JobResult> {
  const point = { x: isNum(o.x) ? o.x : 0, y: isNum(o.y) ? o.y : 0 };
  switch (o.name) {
    case "place_image": {
      const bad = aimAt(o);
      if (bad) return fail(bad);
      const ids = await dropImages([file], point);
      return ids.length > 0 ? ok({ nodeId: ids[0] }) : fail(useScene.getState().notice ?? "the image could not be placed");
    }
    case "relink_image": {
      if (!isStr(o.nodeId)) return fail("nodeId is required");
      return (await relinkImage(o.nodeId, file)) ? ok({ nodeId: o.nodeId }) : fail(useScene.getState().notice ?? "the image could not be relinked (is nodeId an image?)");
    }
    case "import_svg": {
      const bad = aimAt(o);
      if (bad) return fail(bad);
      const id = await importSvgFile(file, point);
      return id ? noticeResult({ nodeId: id }) : fail(useScene.getState().notice ?? "the SVG could not be imported");
    }
    case "import_pdf": {
      if (o.mode !== undefined && o.mode !== "editable" && o.mode !== "image") return fail("mode must be editable or image");
      const r = await importPdfFile(file, undefined, (o.mode as "editable" | "image" | undefined) ?? "editable");
      return r.ok ? ok({ pages: r.pages, message: r.message }) : fail(r.message);
    }
    case "import_fig": {
      const bad = aimAt(o);
      if (bad) return fail(bad);
      const r = await importFigFile(file);
      return r.ok ? ok({ message: r.message, warnings: r.warnings }) : fail(r.message);
    }
    case "import_idml": {
      try {
        const { pages, notes } = await parseIdml(new Uint8Array(await file.arrayBuffer()));
        const made = idmlOps(useScene.getState().scene!, pages);
        commit(made.ops);
        useScene.getState().setCurrentPage(made.pageIds[0]!);
        const left = notes.length > 0 ? ` Not carried over: ${notes.join(", ")}.` : "";
        return ok({ pages: made.pageIds.length, nodes: made.nodes, message: `Imported ${made.pageIds.length} page(s) with rectangles, ovals, polygons, lines and text. Images, effects, styles and master pages are not carried over.${left}` });
      } catch (e) {
        return fail(e instanceof IdmlError ? e.message : "the IDML file could not be read");
      }
    }
    case "place_document": {
      const bad = aimAt(o);
      if (bad) return fail(bad);
      const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
      if (!["docx", "rtf", "xlsx"].includes(ext)) return fail("place_document reads .docx, .rtf and .xlsx files");
      const scene = useScene.getState().scene!;
      const page = useScene.getState().currentPageId ?? scene.pages.find((p) => !p.isMaster)?.id ?? scene.pages[0]!.id;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (ext === "xlsx") {
          const made = placeTableOps(scene, await parseXlsx(bytes), page, point.x, point.y);
          if (typeof made === "string") return fail(made);
          commit(made.ops);
          return ok({ nodeId: made.tableId, kind: "table" });
        }
        const paragraphs = ext === "docx" ? await parseDocx(bytes) : parseRtf(new TextDecoder().decode(bytes));
        const made = placeTextOps(scene, paragraphs, page, point.x, point.y, isNum(o.width) ? o.width : 400);
        if (typeof made === "string") return fail(made);
        commit(made.ops);
        return ok({ nodeId: made.nodeId, kind: "text", paragraphs: made.paragraphs, message: "Text and headings (bold, italic) were placed; images, tables, footnotes, fonts and colours of the file were not carried over." });
      } catch (e) {
        return fail(e instanceof PlaceError ? e.message : "the file could not be read");
      }
    }
    case "upload_font": {
      if (!isStr(o.family) || o.family.trim() === "") return fail("family is required");
      const weight = o.weight === undefined ? "400" : o.weight;
      if (!isStr(weight) || !/^[1-9]00$/.test(weight)) return fail("weight must be 100, 200, ... 900");
      if (o.italic !== undefined && !isBool(o.italic)) return fail("italic must be true or false");
      const docId = useScene.getState().scene!.id;
      try {
        const ref = await uploadAsset(docId, file);
        const { font, op } = addFontOp(o.family, weight, o.italic === true, ref.hash);
        const before = Object.keys(useScene.getState().scene?.fonts ?? {}).length;
        commit([op]);
        if (Object.keys(useScene.getState().scene?.fonts ?? {}).length === before) return fail("a font with this family, weight and style already exists, or the family name has unsupported characters");
        return ok({ fontId: font.id, assetHash: ref.hash });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "could not upload the font");
      }
    }
  }
  return fail(`unknown command ${String(o.name)}`);
}

export async function runCommand(o: Record<string, unknown>, file: File | null = null): Promise<JobResult> {
  const scene = useScene.getState().scene;
  if (!scene) return fail("the editor has no document open");
  if (typeof o.name === "string" && FILE_COMMANDS.has(o.name)) return file ? runFileCommand(o, file) : fail(`${o.name} needs an input file`);
  switch (o.name) {
    case "generate_contents": {
      if (o.kind !== "toc" && o.kind !== "index" && o.kind !== "endnotes") return fail("kind must be toc, index or endnotes");
      if (o.maxLevel !== undefined && !(isNum(o.maxLevel) && Number.isInteger(o.maxLevel) && o.maxLevel >= 1 && o.maxLevel <= 9)) return fail("maxLevel must be 1..9");
      const page = pageIdFrom(o);
      if (Array.isArray(page)) return fail(page[0]!);
      const made = generateContentsOps(scene, o.kind, page, (o.maxLevel as number | undefined) ?? 3);
      if (!made) {
        return fail(o.kind === "toc"
          ? "No headings yet: give a paragraph style a heading level (set_text_style outlineLevel) and apply it."
          : o.kind === "endnotes" ? "No endnotes yet: write [*the note] in the text where the reference goes."
          : "No index terms yet: mark a word in the text with [#term].");
      }
      commit(made.ops);
      return ok({ lines: made.lines, nodeIds: made.selection });
    }
    case "insert_table": {
      for (const k of ["x", "y", "cellWidth", "cellHeight"] as const) if (o[k] !== undefined && !isNum(o[k])) return fail(`${k} must be a number`);
      const rows = o.rows, cols = o.cols;
      if (!isNum(rows) || !isNum(cols) || !Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > MAX_TABLE_SIDE || cols > MAX_TABLE_SIDE) return fail(`rows and columns must be whole numbers from 1 to ${MAX_TABLE_SIDE}`);
      const head = o.headerRows === undefined ? 1 : o.headerRows;
      if (!isNum(head) || !Number.isInteger(head) || head < 0 || head > rows) return fail("headerRows must be 0..rows");
      const page = pageIdFrom(o);
      if (Array.isArray(page)) return fail(page[0]!);
      const parent = o.parentId === undefined ? page : o.parentId;
      if (!isStr(parent) || (!scene.nodes.has(parent) && !scene.pages.some((p) => p.id === parent))) return fail("parentId is not a page or a node");
      const made = createTableOps(scene, parent, (o.x as number | undefined) ?? 0, (o.y as number | undefined) ?? 0, rows, cols, (o.cellWidth as number | undefined) ?? 120, (o.cellHeight as number | undefined) ?? 36, head);
      if (!made) return fail("the table cannot be made (cells must be at least a few pixels)");
      commit(made.ops);
      return ok({ tableId: made.selection[0], cells: rows * cols });
    }
    case "edit_table": {
      if (!isStr(o.tableId)) return fail("tableId is required");
      const id = tableIdOf(scene, o.tableId);
      if (!id) return fail("that is not a table (or a cell of one)");
      const index = o.index;
      if (!isNum(index) || !Number.isInteger(index)) return fail("index must be a whole number");
      let ops: Op[] = [];
      switch (o.action) {
        case "add_row": ops = addRowOps(scene, id, index); break;
        case "add_column": ops = addColumnOps(scene, id, index); break;
        case "delete_row": ops = deleteRowOps(scene, id, index); break;
        case "delete_column": ops = deleteColumnOps(scene, id, index); break;
        case "resize_row":
        case "resize_column":
          if (!isNum(o.size)) return fail("size is required");
          ops = resizeTableOps(scene, id, o.action === "resize_row" ? "row" : "col", index, o.size);
          break;
        default: return fail("action must be add_row, add_column, delete_row, delete_column, resize_row or resize_column");
      }
      if (ops.length === 0) return fail("nothing to do (index out of range, the last row or column, or the size is already that)");
      commit(ops);
      return ok({ tableId: id });
    }
    case "find_change": {
      if (!isStr(o.query) || o.query === "") return fail("query is required");
      for (const k of ["matchCase", "wholeWord", "regex"] as const) if (o[k] !== undefined && !isBool(o[k])) return fail(`${k} must be true or false`);
      if (o.replace !== undefined && !isStr(o.replace)) return fail("replace must be a string");
      const opts = { query: o.query, matchCase: o.matchCase === true, wholeWord: o.wholeWord === true, regex: o.regex === true };
      const found = findAll(scene, opts);
      if ("error" in found) return fail(`invalid pattern: ${found.error}`);
      const limit = isNum(o.limit) ? Math.max(1, Math.min(500, Math.floor(o.limit))) : 100;
      const list = found.slice(0, limit).map((m) => ({ nodeId: m.nodeId, pageId: m.pageId, start: m.start, end: m.end, text: m.text, context: m.context }));
      if (o.replace === undefined) return ok({ count: found.length, matches: list });
      if (found.length === 0) return ok({ replaced: 0 });
      const ops = replaceOps(scene, found, opts, o.replace);
      if (ops.length > 0) commit(ops);
      return ok({ replaced: found.length });
    }
    case "group_nodes":
    case "ungroup_nodes": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      const made = o.name === "group_nodes" ? groupOps(scene, ids) : ungroupOps(scene, ids);
      if (!made) return fail(o.name === "group_nodes" ? "nothing to group" : "none of those nodes is a group");
      commit(made.ops);
      return ok({ selection: "selection" in made ? made.selection : [] });
    }
    case "align_nodes": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      const cmds = ["left", "hcenter", "right", "top", "middle", "bottom", "distribute-h", "distribute-v"];
      if (!isStr(o.command) || !cmds.includes(o.command)) return fail(`command must be one of ${cmds.join(", ")}`);
      if (o.command.startsWith("distribute") && ids.length < 3) return fail("distributing needs at least three nodes");
      const ops = alignOps(scene, ids, o.command as AlignCommand);
      if (ops.length === 0) return ok({ moved: 0 });
      commit(ops);
      return ok({ moved: ops.length });
    }
    case "boolean_operation": {
      const BOOL = ["union", "subtract", "intersect", "exclude"];
      if (!isStr(o.op) || !BOOL.includes(o.op)) return fail(`op must be one of ${BOOL.join(", ")}`);
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      const only = ids.length === 1 ? scene.nodes.get(ids[0]!) : undefined;
      if (only && booleanOpOf(only)) {
        const ops = setBooleanOpOps(only, o.op as BooleanOp);
        if (ops.length > 0) commit(ops);
        return ok({ groupId: only.id });
      }
      const made = liveBooleanOps(scene, ids, o.op as BooleanOp);
      if (!made) return fail("a boolean operation needs two or more shapes with an outline (rectangles, ellipses, vectors) that produce a result");
      commit(made.ops);
      return ok({ groupId: made.selection[0] });
    }
    case "flatten_boolean": {
      if (!isStr(o.groupId)) return fail("groupId is required");
      const made = flattenGroupOps(scene, o.groupId);
      if (!made) return fail("groupId is not a group of shapes");
      commit(made.ops);
      return ok({ nodeId: made.selection[0] });
    }
    case "outline_stroke": {
      if (!isStr(o.nodeId)) return fail("nodeId is required");
      const made = outlineStrokeOps(scene, o.nodeId);
      if (!made) return fail("that node has no stroke that can be outlined");
      commit(made.ops);
      return ok({ nodeId: made.selection[0] });
    }
    case "duplicate_nodes": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      useScene.getState().setSelection(ids);
      const copies = duplicateSelection();
      return copies.length > 0 ? ok({ nodeIds: copies }) : fail("nothing was duplicated (an edit may be in progress)");
    }
    case "reorder_node": {
      if (!isStr(o.nodeId)) return fail("nodeId is required");
      const n = scene.nodes.get(o.nodeId);
      if (!n) return fail(`no node ${o.nodeId}`);
      if (!["front", "back", "forward", "backward"].includes(String(o.to))) return fail("to must be front, back, forward or backward");
      const sibs = childrenOf(scene, n.parentId);
      const i = sibs.findIndex((x) => x.id === n.id);
      const key = (k: number) => sibs[k]?.orderKey ?? null;
      let order: string | null = null;
      if (o.to === "front" && i < sibs.length - 1) order = orderKeyBetween(sibs.at(-1)!.orderKey, null);
      else if (o.to === "back" && i > 0) order = orderKeyBetween(null, sibs[0]!.orderKey);
      else if (o.to === "forward" && i < sibs.length - 1) order = orderKeyBetween(key(i + 1), key(i + 2));
      else if (o.to === "backward" && i > 0) order = orderKeyBetween(key(i - 2), key(i - 1));
      if (order === null) return ok({ moved: false });
      commit([makeSetPropsOp(n.id, { orderKey: order }, ["order_key"])]);
      return ok({ moved: true });
    }
    case "create_vector": {
      const paths = pathsOf(o.paths);
      if (typeof paths === "string") return fail(paths);
      const page = pageIdFrom(o);
      if (Array.isArray(page)) return fail(page[0]!);
      const parent = o.parentId === undefined ? page : o.parentId;
      if (!isStr(parent) || (!scene.nodes.has(parent) && !scene.pages.some((p) => p.id === parent))) return fail("parentId is not a page or a node");
      const fills: FillLite[] = [];
      if (o.fill !== undefined) { const f = fillOf(o.fill); if (typeof f === "string") return fail(f); fills.push(f); }
      const strokes = [];
      if (o.stroke !== undefined) {
        const st = o.stroke as { color?: unknown; weight?: unknown };
        const c = fillOf(st.color);
        if (typeof c === "string" || !isNum(st.weight) || st.weight < 0) return fail("stroke needs a colour and a weight >= 0");
        strokes.push({ color: c, weight: st.weight, align: "center" as const });
      }
      const norm = normalizeVector({ x: 0, y: 0 }, paths);
      const id = uuid();
      commit([makeCreateNodeOp(create(NodeSchema, {
        id, parentId: parent, orderKey: nextOrderKey(scene), name: isStr(o.nodeName) ? o.nodeName : "Vector", visible: true, opacity: 1,
        x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height, rotation: 0,
        fills: toPbFills(fills), strokes: toPbStrokes(strokes),
        shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
      }))]);
      return ok({ nodeId: id, x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height });
    }
    case "set_vector_path": {
      if (!isStr(o.nodeId)) return fail("nodeId is required");
      const n = scene.nodes.get(o.nodeId);
      if (!n || n.kind !== "vector") return fail("nodeId is not a vector node");
      const paths = pathsOf(o.paths);
      if (typeof paths === "string") return fail(paths);
      // The box follows the geometry in the same gesture (the writer's invariant, store/vectorGeometry.ts).
      const norm = normalizeVector({ x: 0, y: 0 }, paths);
      commit([
        makeSetVectorPathOp(n.id, norm.subpaths),
        makeSetPropsOp(n.id, { x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height }, ["x", "y", "width", "height"]),
      ]);
      return ok({ nodeId: n.id, x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height });
    }
    case "apply_table_style": {
      if (!isStr(o.tableId) || !isStr(o.styleId)) return fail("tableId and styleId are required");
      const id = tableIdOf(scene, o.tableId);
      if (!id) return fail("that is not a table (or a cell of one)");
      const style = (scene.settings?.tableStyles ?? []).find((t) => t.id === o.styleId);
      if (!style) return fail(`no table style ${o.styleId} (define it with set_document_settings tableStyles)`);
      const ops = applyTableStyleOps(scene, id, style);
      if (ops.length > 0) commit(ops);
      return ok({ tableId: id, changed: ops.length });
    }
    case "check_text": {
      let only: CheckCode[] | undefined;
      if (o.checks !== undefined) {
        if (!Array.isArray(o.checks) || !o.checks.every((c) => CHECK_CODES.includes(c as CheckCode))) return fail(`checks must be a list of: ${CHECK_CODES.join(", ")}`);
        only = o.checks as CheckCode[];
      }
      const limit = isNum(o.limit) ? Math.max(1, Math.min(2000, Math.floor(o.limit))) : 200;
      const issues = checkText(scene, only, limit);
      return ok({ count: issues.length, issues });
    }
    case "list_editorial_notes": {
      return ok({ notes: editorialNotes(scene) });
    }
    case "step_and_repeat": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      if (!isNum(o.count) || !isNum(o.dx) || !isNum(o.dy)) return fail("count, dx and dy are required numbers");
      const made = stepRepeatOps(scene, ids, { count: o.count, dx: o.dx, dy: o.dy });
      if (typeof made === "string") return fail(made);
      commit(made.ops);
      return ok({ nodeIds: made.ids });
    }
    case "set_gap": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      if (o.axis !== "x" && o.axis !== "y") return fail("axis must be x or y");
      if (!isNum(o.gap)) return fail("gap must be a number");
      const ops = gapOps(scene, ids, o.axis, o.gap);
      if (typeof ops === "string") return fail(ops);
      if (ops.length > 0) commit(ops);
      return ok({ moved: ops.length });
    }
    case "fit_frame": {
      if (!isStr(o.nodeId)) return fail("nodeId is required");
      const ops = fitOps(scene, o.nodeId, String(o.mode) as FitMode);
      if (typeof ops === "string") return fail(ops);
      if (ops.length > 0) commit(ops);
      return ok({ changed: ops.length });
    }
    case "clip_with_shape": {
      if (!isStr(o.shapeId)) return fail("shapeId is required");
      if (o.release === true) {
        const ops = releaseClipOps(scene, o.shapeId);
        if (typeof ops === "string") return fail(ops);
        commit(ops);
        return ok({ released: true });
      }
      if (!Array.isArray(o.contentIds) || !o.contentIds.every(isStr)) return fail("contentIds must be a list of node ids");
      const made = clipWithShapeOps(scene, o.shapeId, o.contentIds as string[]);
      if (typeof made === "string") return fail(made);
      commit(made.ops);
      return ok({ groupId: made.groupId });
    }
    case "create_qr_code": {
      if (!isStr(o.text) || o.text === "") return fail("text is required");
      if (o.level !== undefined && !QR_LEVELS.includes(o.level as QrLevel)) return fail("level must be L, M, Q or H");
      const page = pageIdFrom(o);
      if (Array.isArray(page)) return fail(page[0]!);
      const parent = o.parentId === undefined ? page : o.parentId;
      if (!isStr(parent) || (!scene.nodes.has(parent) && !scene.pages.some((p) => p.id === parent))) return fail("parentId is not a page or a node");
      let dark: FillLite | undefined, light: FillLite | undefined;
      if (o.dark !== undefined) { const f = fillOf(o.dark); if (typeof f === "string") return fail(f); dark = f; }
      if (o.light !== undefined) { const f = fillOf(o.light); if (typeof f === "string") return fail(f); light = f; }
      const made = qrOps(scene, { text: o.text, level: o.level as QrLevel | undefined, size: isNum(o.size) ? o.size : undefined, x: isNum(o.x) ? o.x : 0, y: isNum(o.y) ? o.y : 0, parentId: parent, dark, light });
      if (typeof made === "string") return fail(made);
      commit(made.ops);
      return ok({ groupId: made.groupId });
    }
    case "find_objects":
    case "change_objects": {
      const q: ObjectQuery = {};
      if (o.kind !== undefined) { if (!isStr(o.kind)) return fail("kind must be a string"); q.kind = o.kind as ObjectQuery["kind"]; }
      if (o.nameMatches !== undefined) { if (!isStr(o.nameMatches)) return fail("nameMatches must be a string"); q.name = o.nameMatches; }
      if (o.fill !== undefined) { const f = fillOf(o.fill); if (typeof f === "string") return fail(f); q.fill = f; }
      if (o.stroke !== undefined) { const f = fillOf(o.stroke); if (typeof f === "string") return fail(f); q.stroke = f; }
      if (o.pageId !== undefined) { if (!isStr(o.pageId)) return fail("pageId must be a string"); q.pageId = o.pageId; }
      const found = findObjects(scene, q);
      if (typeof found === "string") return fail(found);
      if (o.name === "find_objects") return ok({ count: found.length, nodes: found.slice(0, 500).map((n) => ({ id: n.id, name: n.name, kind: n.kind })) });
      const c = (o.change ?? {}) as Record<string, unknown>;
      const change: ObjectChange = {};
      if (c.fill !== undefined) { const f = fillOf(c.fill); if (typeof f === "string") return fail(f); change.fill = f; }
      if (c.stroke !== undefined) { const f = fillOf(c.stroke); if (typeof f === "string") return fail(f); change.stroke = f; }
      if (c.strokeWeight !== undefined) { if (!isNum(c.strokeWeight) || c.strokeWeight < 0) return fail("strokeWeight must be >= 0"); change.strokeWeight = c.strokeWeight; }
      if (c.opacity !== undefined) { if (!isNum(c.opacity) || c.opacity < 0 || c.opacity > 1) return fail("opacity must be from 0 to 1"); change.opacity = c.opacity; }
      if (c.visible !== undefined) { if (!isBool(c.visible)) return fail("visible must be true or false"); change.visible = c.visible; }
      if (c.rename !== undefined) { if (!isStr(c.rename)) return fail("rename must be a string"); change.rename = c.rename; }
      if (Object.keys(change).length === 0) return fail("change needs at least one of fill, stroke, strokeWeight, opacity, visible, rename");
      const ops = changeObjectsOps(scene, found, change, q);
      if (ops.length > 0) commit(ops);
      return ok({ matched: found.length, changed: ops.length });
    }
    case "export_snippet": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      const text = exportSnippet(scene, ids);
      return text ? ok({ snippet: text }) : fail("nothing to export");
    }
    case "place_snippet": {
      if (!isStr(o.snippet)) return fail("snippet is required");
      const page = pageIdFrom(o);
      if (Array.isArray(page)) return fail(page[0]!);
      const parent = o.parentId === undefined ? page : o.parentId;
      if (!isStr(parent) || (!scene.nodes.has(parent) && !scene.pages.some((p) => p.id === parent))) return fail("parentId is not a page or a node");
      const made = placeSnippetOps(scene, o.snippet, isNum(o.x) ? o.x : 0, isNum(o.y) ? o.y : 0, parent);
      if (typeof made === "string") return fail(made);
      commit(made.ops);
      return ok({ nodeIds: made.ids });
    }
    case "ink_report": {
      if (o.limit !== undefined && (!isNum(o.limit) || o.limit < 100 || o.limit > 400)) return fail("limit must be a total ink percentage from 100 to 400");
      return ok(inkReport(scene, isNum(o.limit) ? o.limit : 300));
    }
    case "convert_spots_to_process": {
      if (o.inks !== undefined && !(Array.isArray(o.inks) && o.inks.every(isStr))) return fail("inks must be a list of spot ink names");
      const ops = convertSpotsOps(scene, o.inks as string[] | undefined);
      if (typeof ops === "string") return fail(ops);
      if (ops.length > 0) commit(ops);
      return ok({ converted: ops.length });
    }
    case "merge_spot_inks": {
      if (!isStr(o.from) || !isStr(o.to)) return fail("from and to are required");
      const ops = mergeSpotsOps(scene, o.from, o.to);
      if (typeof ops === "string") return fail(ops);
      commit(ops);
      return ok({ swatches: ops.length });
    }
    case "set_overprint": {
      const ids = nodeIdsOf(o, scene);
      if (typeof ids === "string") return fail(ids);
      const ops = overprintOps(scene, ids, String(o.mode) as OverprintMode);
      if (typeof ops === "string") return fail(ops);
      if (ops.length > 0) commit(ops);
      return ok({ changed: ops.length });
    }
    case "batch": {
      if (!Array.isArray(o.commands) || o.commands.length === 0 || o.commands.length > 50) return fail("commands must be a list of 1..50 commands");
      const results: unknown[] = [];
      for (const [i, c] of o.commands.entries()) {
        if (typeof c !== "object" || c === null || !isStr((c as { name?: unknown }).name)) return fail(`commands[${i}] needs a name`);
        const name = (c as { name: string }).name;
        if (name === "batch") return fail("a batch cannot contain a batch");
        if (FILE_COMMANDS.has(name)) return fail(`commands[${i}]: ${name} needs a file and cannot run in a batch`);
        const r = await runCommand(c as Record<string, unknown>, null);
        if (!r.ok) return { ok: false, message: `commands[${i}] (${name}) failed: ${r.message}. The ${i} before it were applied (each is its own undo step).` };
        results.push(r.text ? JSON.parse(r.text) : null);
      }
      return ok({ results });
    }
    case "list_commands":
      return ok({ commands: COMMAND_NAMES, fileCommands: [...FILE_COMMANDS] });
    case "override_master_item": {
      if (!isStr(o.pageId) || !isStr(o.masterNodeId)) return fail("pageId and masterNodeId are required");
      const page = scene.pages.find((p) => p.id === o.pageId);
      if (!page || page.isMaster) return fail("pageId must be a regular page");
      const ops = overrideMasterItemOps(scene, page, o.masterNodeId);
      if (ops.length === 0) return fail("masterNodeId is not a node of the master");
      commit(ops);
      return ok({ copiedNodeIds: ops.filter((op) => op.kind.case === "createNode").map((op) => (op.kind as { value: { node?: { id: string } } }).value.node?.id) });
    }
    default:
      return fail(`unknown command ${String(o.name)}`);
  }
}
