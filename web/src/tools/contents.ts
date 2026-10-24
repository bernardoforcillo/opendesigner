import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { pageTextArea } from "../store/docSettings";
import { orderKeyBetween } from "../store/orderKey";
import { pageNumbers } from "../store/pageNumbers";
import { headingsOf, indexEntries } from "../store/textTokens";
import { childrenOf } from "../store/tree";
import { toPbNode, type NodeLite, type SceneState, type TextStyleDefLite, type TextStyleLite } from "../store/types";
import { makeCreateNodeOp, makeSetPropsOp, makeSetTextOp, makeSetTextStyleDefOp, uuid } from "./ops";

// TABLE OF CONTENTS and INDEX. Both are GENERATED text, like in a layout tool: a command writes the text into a
// frame (which it creates, or finds again by its meta `contents.kind`) and running it again refreshes it.
//
//  - the contents lists the headings -- the paragraphs whose paragraph style has an outline level -- down to a
//    level, one line each, "Title <tab> page", in styles "Contents 1..3" (indented per level, with a right tab
//    and a dotted leader);
//  - the index lists the terms marked with [#term] in the texts, alphabetically, "term <tab> 3, 7".
//
// Page numbers are the document's own (sections and styles included). The generated frame is an ordinary text:
// restyle the "Contents n" / "Index" styles and regenerate, or edit the text by hand until the next update.

export const META_CONTENTS = "contents.kind";
export type ContentsKind = "toc" | "index";

const BASE: TextStyleLite = { fontFamily: "", fontSize: 14, fontWeight: "", lineHeight: 1.4, align: "left" };

export const contentsStyleId = (kind: ContentsKind, level = 1) => (kind === "toc" ? `contents-${level}` : "index-entry");

/** The generated frame of this kind, if the document has one. */
export function contentsNode(scene: SceneState, kind: ContentsKind): NodeLite | null {
  for (const n of scene.nodes.values()) if (n.kind === "text" && n.meta?.[META_CONTENTS] === kind) return n;
  return null;
}

function styleDefs(kind: ContentsKind, width: number, maxLevel: number): TextStyleDefLite[] {
  const tab = [{ position: width, align: "right" as const, leader: "." }];
  if (kind === "index") return [{ id: contentsStyleId("index"), name: "Index entry", style: BASE, tabStops: tab }];
  return Array.from({ length: maxLevel }, (_, i) => ({
    id: contentsStyleId("toc", i + 1), name: `Contents ${i + 1}`,
    style: { ...BASE, fontWeight: i === 0 ? "600" : "" }, indentLeft: i * 18, spaceBefore: i === 0 ? 4 : 0, tabStops: tab,
  }));
}

export interface Generated { ops: Op[]; selection: string[]; lines: number }

/**
 * The ops that write the contents or the index of the document into its frame -- created on page `pageId` when
 * there is none -- or null when there is nothing to list (no headings, no marked terms).
 */
export function generateContentsOps(scene: SceneState, kind: ContentsKind, pageId: string, maxLevel = 3): Generated | null {
  const labels = pageNumbers(scene.pages);
  let lines: string[];
  let styles: string[];
  if (kind === "toc") {
    const items = headingsOf(scene).filter((h) => h.level <= maxLevel);
    lines = items.map((h) => `${h.text}\t${labels.get(h.pageId)?.label ?? ""}`);
    styles = items.map((h) => contentsStyleId("toc", Math.min(h.level, maxLevel)));
  } else {
    const entries = indexEntries(scene);
    lines = entries.map((e) => `${e.term}\t${e.pages.join(", ")}`);
    styles = entries.map(() => contentsStyleId("index"));
  }
  if (lines.length === 0) return null;

  const existing = contentsNode(scene, kind);
  const page = scene.pages.find((p) => p.id === pageId) ?? scene.pages[0];
  const area = existing ? null : pageTextArea(page);
  const width = existing ? existing.width : area && area.width > 0 ? area.width : 400;
  const ops: Op[] = styleDefs(kind, width, maxLevel).map(makeSetTextStyleDefOp);
  const content = lines.join("\n");
  const height = lines.length * BASE.fontSize * BASE.lineHeight + 8;
  if (existing) {
    ops.push(makeSetTextOp(existing.id, content, existing.text!.style, { paragraphStyles: styles, runs: [] }));
    if (Math.abs(existing.height - height) > 0.5) ops.push(makeSetPropsOp(existing.id, { height }, ["height"]));
    return { ops, selection: [existing.id], lines: lines.length };
  }
  const top = childrenOf(scene, page.id).at(-1)?.orderKey ?? null;
  const node: NodeLite = {
    id: uuid(), parentId: page.id, orderKey: orderKeyBetween(top, null), name: kind === "toc" ? "Contents" : "Index", visible: true, opacity: 1,
    x: area?.x ?? 0, y: area?.y ?? 0, width, height, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    meta: { [META_CONTENTS]: kind }, text: { content, style: BASE, paragraphStyles: styles },
  };
  ops.push(makeCreateNodeOp(toPbNode(node)));
  return { ops, selection: [node.id], lines: lines.length };
}
