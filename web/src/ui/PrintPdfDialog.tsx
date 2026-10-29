import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { runDocumentExport, runPackage } from "@/export/exportScene";
import { preflightScene } from "@/export/preflight";
import type { PrintPdfOptions } from "@/export/printPdf";
import { Button, cls } from "@/ui/ds";
import { useT } from "@/i18n";
import { issueText } from "@/ui/shell/PreflightPanel";

// EXPORT PDF (document menu): the options of a PDF going to a printer, with the preflight of the document
// beside them. The preflight here reads the document; what only the writer can see (image resolution,
// missing glyphs, effects it cannot reproduce) is reported after the file is written. PDF/X is "ready",
// not validated -- see docs/output.md.

const STANDARDS = [
  { id: "none", label: "PDF (no standard)" },
  { id: "x4", label: "PDF/X-4 (transparency allowed)" },
  { id: "x3", label: "PDF/X-3 (no transparency)" },
  { id: "x1a", label: "PDF/X-1a (CMYK only, no transparency)" },
] as const;

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function PrintPdfDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const tr = useT();
  const scene = useScene((s) => s.scene);
  const [opts, setOpts] = useState<Required<Pick<PrintPdfOptions, "pdfx" | "bleed" | "marks" | "slug" | "spreads" | "interactive" | "booklet" | "tagged">>>({
    pdfx: "none", bleed: true, marks: false, slug: false, spreads: false, interactive: true, booklet: false, tagged: false,
  });
  if (!scene || !isOpen) return null;
  const set = <K extends keyof typeof opts>(k: K, v: (typeof opts)[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const issues = preflightScene(scene, opts);
  const facing = scene.settings?.facingPages === true;
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Export PDF" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Export PDF</h2>
          <label className="flex items-center gap-2">
            Standard
            <select aria-label="PDF standard" className={cls.select} value={opts.pdfx} onChange={(e) => set("pdfx", e.target.value as typeof opts.pdfx)}>
              {STANDARDS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1.5">
            <Check label="Include bleed" checked={opts.bleed} onChange={(v) => set("bleed", v)} />
            <Check label="Crop marks and page information" checked={opts.marks} onChange={(v) => set("marks", v)} />
            <Check label="Include slug" checked={opts.slug} onChange={(v) => set("slug", v)} />
            <Check label="Facing pages as spreads" checked={opts.spreads} disabled={!facing} onChange={(v) => set("spreads", v)} />
            <Check label="Bookmarks and links" checked={opts.interactive} onChange={(v) => set("interactive", v)} />
            <Check label="Tagged PDF (reading order, headings, alt text)" checked={opts.tagged} onChange={(v) => set("tagged", v)} />
            <Check label="Booklet: two pages per sheet side, saddle-stitch order" checked={opts.booklet} onChange={(v) => set("booklet", v)} />
          </div>
          <section aria-label="Preflight" className="flex flex-col gap-1">
            <h3 className="text-[12px] font-semibold">Preflight</h3>
            {issues.length === 0 && <p className="text-fg-subtle">No problems found in the document.</p>}
            <ul className="flex flex-col gap-1">
              {issues.map((i, k) => (
                <li key={k} className={"rounded-md border border-line p-1.5 " + (i.severity === "error" ? "text-danger" : i.severity === "info" ? "text-fg-subtle" : "")}>
                  <span className="font-medium">{i.severity === "error" ? "Error" : i.severity === "warning" ? "Warning" : "Note"}: </span>{issueText(i, tr)}
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-fg-subtle">A checklist of known problems, not a PDF/X validator. Image resolution and missing glyphs are checked when the file is written.</p>
          </section>
          <div className="flex justify-end gap-2">
            <Button onPress={() => onOpenChange(false)}>Cancel</Button>
            <Button onPress={() => { onOpenChange(false); void runPackage({}, opts); }}>Package…</Button>
            <Button variant="primary" onPress={() => { onOpenChange(false); void runDocumentExport("pdf", {}, opts); }}>Export</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
