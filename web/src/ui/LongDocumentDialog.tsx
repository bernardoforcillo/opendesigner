import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { editorialNotes } from "@/store/textTokens";
import { makeSetDocSettingsOp, uuid } from "@/tools/ops";
import { applyTableStyleOps, tableIdOf } from "@/tools/tableOps";
import { checkText, type TextIssue } from "@/tools/textChecks";
import type { DocSettingsLite, TableStyleLite, TextConditionLite } from "@/store/types";
import { Button, cls } from "@/ui/ds";

// LONG DOCUMENTS (document menu): the settings that long text needs -- the conditions of conditional text, the table
// styles -- and the lists of what is hidden in the text: editorial notes, and the typographic slips a proofreader
// would catch. The markers themselves ([=anchor] [>reference] [*endnote] [!note] [?condition]...[/?]) are written in the
// text; see docs/long-documents.md.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

function Form() {
  const { t, tx } = useT();
  const scene = useScene((s) => s.scene)!;
  const selection = useScene((s) => s.selection);
  const [name, setName] = useState("");
  const [issues, setIssues] = useState<TextIssue[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const settings = scene.settings ?? {};
  const conditions = settings.conditions ?? [];
  const styles = settings.tableStyles ?? [];
  const write = (patch: Partial<DocSettingsLite>) => {
    const next: DocSettingsLite = { ...settings, ...patch };
    if (!next.conditions?.length) delete next.conditions;
    if (!next.tableStyles?.length) delete next.tableStyles;
    run([makeSetDocSettingsOp(next)]);
  };
  const setCondition = (i: number, patch: Partial<TextConditionLite>) => write({ conditions: conditions.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const addCondition = () => {
    const n = name.trim();
    if (n === "" || conditions.some((c) => c.name === n) || !/^[A-Za-z0-9_ -]{1,40}$/.test(n)) return;
    write({ conditions: [...conditions, { name: n, visible: true }] });
    setName("");
  };
  const patchStyle = (id: string, patch: Partial<TableStyleLite>) => write({ tableStyles: styles.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const cur = styles.find((t) => t.id === selected) ?? null;
  const tableId = selection.map((id) => tableIdOf(scene, id)).find((id) => id !== null) ?? null;
  const notes = editorialNotes(scene);
  const objects = Object.values(scene.objectStyles ?? {}), texts = Object.values(scene.textStyles).filter((d) => d.kind !== "character");
  const goTo = (nodeId: string, pageId: string) => { const st = useScene.getState(); st.setCurrentPage(pageId); st.setSelection([nodeId]); };

  const pick = (label: string, key: keyof TableStyleLite, list: { id: string; name: string }[]) => (
    <label className="flex flex-col gap-0.5">
      <span className={cls.label}>{tx(label)}</span>
      <select aria-label={tx(label)} className={cls.select} value={(cur?.[key] as string | undefined) ?? ""} onChange={(e) => patchStyle(cur!.id, { [key]: e.target.value || undefined })}>
        <option value="">{t("Leave as it is")}</option>
        {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
  );

  return (
    <Dialog aria-label={t("Long documents")} className="flex flex-col gap-3 outline-none">
      <h2 className="text-[14px] font-semibold">{t("Long documents")}</h2>

      <section aria-label={t("Conditions")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Conditional text")}</h3>
        <p className="text-fg-subtle">{t("Write [?Name] before and [/?] after the words that belong to a condition. A hidden condition leaves its text out of the canvas, the exports, the contents and the index.")}</p>
        {conditions.map((c, i) => (
          <div key={c.name} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
            <span>{c.name}</span>
            <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={t("Show {name}", { name: c.name })} checked={c.visible} onChange={(e) => setCondition(i, { visible: e.target.checked })} /> {t("Show")}</label>
            <Button aria-label={t("Delete condition {name}", { name: c.name })} onPress={() => write({ conditions: conditions.filter((_, k) => k !== i) })}>×</Button>
          </div>
        ))}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input aria-label={t("New condition")} className={cls.input} value={name} maxLength={40} placeholder={t("Print, Web, Draft…")} onChange={(e) => setName(e.target.value)} />
          <Button onPress={addCondition}>{t("Add condition")}</Button>
        </div>
      </section>

      <section aria-label={t("Table styles")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Table styles")}</h3>
        <div className="flex flex-wrap gap-1.5">
          {styles.map((t) => (
            <button key={t.id} type="button" aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}
              className={"rounded-md border px-2 py-1 " + (selected === t.id ? "border-accent" : "border-line")}>{t.name}</button>
          ))}
          <Button onPress={() => { const id = `ts-${uuid().slice(0, 8)}`; write({ tableStyles: [...styles, { id, name: t("Table style {n}", { n: styles.length + 1 }) }] }); setSelected(id); }}>{t("New table style")}</Button>
        </div>
        {cur && (
          <div className="flex flex-col gap-1.5 rounded-md border border-line p-2">
            <label className="flex flex-col gap-0.5">
              <span className={cls.label}>{t("Name")}</span>
              <input aria-label={t("Table style name")} className={cls.input} key={cur.id} defaultValue={cur.name} onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== cur.name) patchStyle(cur.id, { name: v }); }} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {pick("Header cells", "headerObjectStyleId", objects)}
              {pick("Header text", "headerTextStyleId", texts)}
              {pick("Body cells", "bodyObjectStyleId", objects)}
              {pick("Body text", "bodyTextStyleId", texts)}
              {pick("Every second body row", "altObjectStyleId", objects)}
            </div>
            <div className="flex justify-between">
              <Button variant="danger" onPress={() => { write({ tableStyles: styles.filter((t) => t.id !== cur.id) }); setSelected(null); }}>{t("Delete style")}</Button>
              <Button isDisabled={!tableId} onPress={() => run(applyTableStyleOps(useScene.getState().scene!, tableId!, cur))}>{tableId ? t("Apply to the selected table") : t("Select a table to apply it")}</Button>
            </div>
          </div>
        )}
      </section>

      <section aria-label={t("Editorial notes")} className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold">{t("Editorial notes")}</h3>
        {notes.length === 0 && <p className="text-fg-subtle">{t("None. Write [!your comment] in the text; it is never drawn, exported or printed.")}</p>}
        <ul className="flex flex-col gap-1">
          {notes.map((n, i) => (
            <li key={i}><button type="button" className="w-full rounded-md border border-line p-1.5 text-left" onClick={() => goTo(n.nodeId, n.pageId)}>
              <span className="block">{n.text}</span><span className="block text-[12px] text-fg-subtle">…{n.context}</span>
            </button></li>
          ))}
        </ul>
      </section>

      <section aria-label={t("Text checks")} className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold">{t("Text checks")}</h3>
        <p className="text-fg-subtle">{t("Repeated words, double spaces, spaces before punctuation, straight quotes, three dots, spaced hyphens. Not a dictionary: your browser underlines misspelt words as you type.")}</p>
        <div><Button onPress={() => setIssues(checkText(useScene.getState().scene!, undefined, 100))}>{t("Check the text")}</Button></div>
        {issues && issues.length === 0 && <p role="status">{t("No slips found.")}</p>}
        {issues && issues.length > 0 && (
          <ul aria-label={t("Slips")} className="flex max-h-48 flex-col gap-1 overflow-auto">
            {issues.map((x, i) => (
              <li key={i}><button type="button" className="w-full rounded-md border border-line p-1.5 text-left" onClick={() => goTo(x.nodeId, x.pageId)}>{x.message} <code>{JSON.stringify(x.text)}</code></button></li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}

export function LongDocumentDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  if (!scene || !isOpen) return null;
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[90vh] w-full max-w-[620px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <div className="flex flex-col gap-3">
          <Form />
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </div>
      </Modal>
    </ModalOverlay>
  );
}
