// Test helper: the fonts pdf.js extracts from the fixture PDF (needs the legacy build under node).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedFont } from "./importPdf";

export async function loadFixtureFonts(): Promise<ExtractedFont[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(join(process.cwd(), "src/pdf/__fixtures__/fonts.pdf")));
  const doc = await pdfjs.getDocument({ data, fontExtraProperties: true, useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  await page.getOperatorList();
  const content = await page.getTextContent();
  const runs = content.items.filter((i) => "str" in i) as { str: string; fontName: string }[];
  return [...new Set(runs.map((r) => r.fontName))].map((id) => {
    const f = page.commonObjs.get(id) as { name: string; data: Uint8Array };
    return { id, name: f.name, data: f.data, text: runs.filter((r) => r.fontName === id).map((r) => r.str).join("") };
  });
}
