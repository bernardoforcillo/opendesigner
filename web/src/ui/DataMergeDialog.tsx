import { useMemo, useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { mergeOps, parseTable, placeholdersOnPage } from "@/tools/dataMerge";
import { Button } from "@/ui/ds";

// DATA MERGE (document menu): a page with {{Field}} placeholders in its text, and a CSV/TSV table with
// one row per record. "Create merged pages" adds a page per record after the template, in one undo step.
// Images are not merged (see docs/output.md).

export function DataMergeDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn } = useT();
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
    useScene.setState({ notice: `${tn("Merged {n} pages from \"{name}\"", plan.pages, { name: page?.name ?? "—" })}${plan.missingFields.length ? `; ${t("no column for {fields}", { fields: plan.missingFields.join(", ") })}` : ""}.` });
    onOpenChange(false);
  }

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[600px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Data merge")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Data merge")}</h2>
          <p className="text-fg-subtle">
            {t("Write {field} in the text of the page you are on, then paste a table (CSV, semicolon or tab separated) with the field names in the first row.", { field: "{{Field}}" })}
          </p>
          <p>{t("Template page: {name}", { name: page?.name || "—" })} · {used.length > 0 ? t("placeholders: {list}", { list: used.map((f) => `{{${f}}}`).join(" ") }) : t("no placeholders on it")}</p>
          <textarea aria-label={t("Table")} rows={7} value={source} onChange={(e) => setSource(e.target.value)} placeholder={"Name,City\nAda,London\nGrace,New York"}
            className="w-full rounded-md border border-line bg-surface p-2 font-mono text-[12px]" />
          <div className="flex items-center gap-2">
            <label className="text-fg-subtle">
              {t("or choose a file")}{" "}
              <input type="file" aria-label={t("Table file")} accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => { void e.target.files?.[0]?.text().then(setSource); }} />
            </label>
          </div>
          {table.headers.length > 0 && <p role="status">{tn("{n} records", table.rows.length)}, {t("fields: {fields}", { fields: table.headers.join(", ") })}</p>}
          {table.rows.length > 0 && missing.length > 0 && <p role="alert" className="text-danger">{t("No column for {fields}; those stay as written.", { fields: missing.map((f) => `{{${f}}}`).join(", ") })}</p>}
          <div className="flex justify-end gap-2">
            <Button onPress={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button variant="primary" isDisabled={!ready} onPress={create}>{t("Create merged pages")}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
