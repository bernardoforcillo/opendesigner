import { useMemo, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { mergeOps, parseTable, placeholdersOnPage } from "@/tools/dataMerge";
import { Button } from "@/ui/ds";

// DATA MERGE (document menu): a page with {{Field}} placeholders in its text, and a CSV/TSV table with
// one row per record. "Create merged pages" adds a page per record after the template, in one undo step.
// Images are not merged (see docs/output.md).

export function DataMergeDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  const [source, setSource] = useState("");
  const table = useMemo(() => parseTable(source), [source]);
  if (!scene || !isOpen) return null;
  const pageId = currentPageId ?? scene.pages[0]?.id ?? "";
  const page = scene.pages.find((p) => p.id === pageId);
  const used = placeholdersOnPage(scene, pageId);
  const missing = used.filter((f) => !table.headers.includes(f));
  const ready = !!page && !page.isMaster && table.rows.length > 0;

  function create() {
    const plan = mergeOps(scene!, pageId, table);
    if (plan.ops.length === 0) return;
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture(plan.ops);
    useScene.setState({ notice: `Merged ${plan.pages} ${plan.pages === 1 ? "page" : "pages"} from "${page?.name ?? "the page"}"${plan.missingFields.length ? `; no column for ${plan.missingFields.join(", ")}` : ""}.` });
    onOpenChange(false);
  }

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[600px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Data merge" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Data merge</h2>
          <p className="text-fg-subtle">
            Write <code>{"{{Field}}"}</code> in the text of the page you are on, then paste a table (CSV, semicolon or tab separated) with the field names in the first row.
          </p>
          <p>Template page: <strong>{page?.name || "—"}</strong>{used.length > 0 ? <> · placeholders: {used.map((f) => `{{${f}}}`).join(" ")}</> : " · no placeholders on it"}</p>
          <textarea aria-label="Table" rows={7} value={source} onChange={(e) => setSource(e.target.value)} placeholder={"Name,City\nAda,London\nGrace,New York"}
            className="w-full rounded-md border border-line bg-surface p-2 font-mono text-[12px]" />
          <div className="flex items-center gap-2">
            <label className="text-fg-subtle">
              or choose a file{" "}
              <input type="file" aria-label="Table file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => { void e.target.files?.[0]?.text().then(setSource); }} />
            </label>
          </div>
          {table.headers.length > 0 && <p role="status">{table.rows.length} {table.rows.length === 1 ? "record" : "records"}, fields: {table.headers.join(", ")}</p>}
          {table.rows.length > 0 && missing.length > 0 && <p role="alert" className="text-danger">No column for {missing.map((f) => `{{${f}}}`).join(", ")}; those stay as written.</p>}
          <div className="flex justify-end gap-2">
            <Button onPress={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" isDisabled={!ready} onPress={create}>Create merged pages</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
