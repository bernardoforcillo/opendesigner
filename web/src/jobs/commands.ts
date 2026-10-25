import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { importFigFile } from "../fig/importFig";
import { importPdfFile } from "../pdf/importPdf";
import { uploadAsset } from "../rpc/assets";
import { dropImages } from "../tools/imageDrop";
import { relinkImage } from "../tools/imageLinks";
import { importSvgFile } from "../tools/svgImport";
import { addFontOp } from "../ui/typographyOps";
import { findAll, replaceOps } from "../store/findReplace";
import { useScene } from "../store/store";
import { generateContentsOps } from "../tools/contents";
import { overrideMasterItemOps } from "../tools/pageOps";
import { MAX_TABLE_SIDE, addColumnOps, addRowOps, createTableOps, deleteColumnOps, deleteRowOps, resizeTableOps, tableIdOf } from "../tools/tableOps";
import type { JobResult } from "./editorJobs";

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

/** Commands that read an input file sent with the job. */
const FILE_COMMANDS = new Set(["place_image", "relink_image", "import_svg", "import_pdf", "import_fig", "upload_font"]);

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
      if (o.kind !== "toc" && o.kind !== "index") return fail("kind must be toc or index");
      if (o.maxLevel !== undefined && !(isNum(o.maxLevel) && Number.isInteger(o.maxLevel) && o.maxLevel >= 1 && o.maxLevel <= 9)) return fail("maxLevel must be 1..9");
      const page = pageIdFrom(o);
      if (Array.isArray(page)) return fail(page[0]!);
      const made = generateContentsOps(scene, o.kind, page, (o.maxLevel as number | undefined) ?? 3);
      if (!made) {
        return fail(o.kind === "toc"
          ? "No headings yet: give a paragraph style a heading level (set_text_style outlineLevel) and apply it."
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
