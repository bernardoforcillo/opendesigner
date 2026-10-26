import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { isValidBook, validIsbn13 } from "@/store/docSettings";
import { bookOf, bookToMsg, type BookLite, type DocSettingsLite } from "@/store/types";
import { makeSetDocSettingsOp } from "@/tools/ops";
import { buildOnix, onixProblems, type OnixRelease } from "@/export/onix";
import { downloadBlob } from "@/export/exportScene";
import { Button, cls } from "@/ui/ds";

// BOOK METADATA (document menu): the bibliographic record of the document -- ISBN, title, contributors,
// language, publisher, date, subjects, prices, description -- stored in the document settings. It feeds
// the ONIX 3.0 message ("Download ONIX…"), the EPUB package metadata and the PDF's author and title.
// See docs/onix.md.

const ROLES = [["A01", "Author"], ["A12", "Illustrator"], ["B01", "Editor"], ["B06", "Translator"], ["A23", "Foreword by"], ["A24", "Introduction by"], ["A13", "Photographer"]] as const;
const SCHEMES = [["10", "BISAC"], ["12", "BIC"], ["93", "Thema"], ["20", "Keywords"]] as const;
const FORMS = [["ED", "Digital (EPUB)"], ["BC", "Paperback"], ["BB", "Hardback"]] as const;
const LANGS = ["eng", "ita", "fre", "ger", "spa", "por"];

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

/** The editor proper: mounted only while the dialog is open, so its draft always starts from the document. */
function Form({ onClose }: { onClose: () => void }) {
  const scene = useScene((s) => s.scene)!;
  const [b, setB] = useState<BookLite>(scene.settings?.book ?? {});
  const [release, setRelease] = useState<OnixRelease>("3.1");
  const set = <K extends keyof BookLite>(k: K, v: BookLite[K]) => setB((cur) => ({ ...cur, [k]: v }));
  const msg = bookToMsg(b);
  const valid = isValidBook(msg);
  const problems = onixProblems(b);
  const isbnOk = !b.isbn13 || validIsbn13(b.isbn13);

  function save(): BookLite | undefined {
    const next = bookOf(msg);
    const settings: DocSettingsLite = { ...(scene.settings ?? {}) };
    if (next) settings.book = next; else delete settings.book;
    run([makeSetDocSettingsOp(settings)]);
    return next;
  }
  function download() {
    const next = save();
    const xml = next ? buildOnix(next, new Date(), release) : null;
    if (!xml) return;
    downloadBlob(new Blob([xml], { type: "application/xml;charset=utf-8" }), `${next!.isbn13}.onix.xml`);
  }

  const text = (label: string, key: "title" | "subtitle" | "seriesName" | "seriesNumber" | "editionNumber" | "publisherName" | "imprint" | "senderName" | "senderEmail", placeholder = "") => (
    <label className="flex flex-col gap-0.5">
      <span className={cls.label}>{label}</span>
      <input aria-label={label} className={cls.input} value={b[key] ?? ""} placeholder={placeholder} onChange={(e) => set(key, e.target.value === "" ? undefined : e.target.value)} />
    </label>
  );

  return (
    <Dialog aria-label="Book metadata" className="flex flex-col gap-3 outline-none">
      <h2 className="text-[14px] font-semibold">Book metadata (ONIX 3.1)</h2>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className={cls.label}>ISBN-13</span>
          <input aria-label="ISBN-13" className={cls.input} value={b.isbn13 ?? ""} placeholder="9788804668237" inputMode="numeric"
            onChange={(e) => set("isbn13", e.target.value.replace(/[-\s]/g, "") || undefined)} />
          {!isbnOk && <span role="alert" className="text-danger">Not a valid ISBN-13 (13 digits, check digit).</span>}
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={cls.label}>Format</span>
          <select aria-label="Product form" className={cls.select} value={b.productForm ?? ""} onChange={(e) => set("productForm", e.target.value || undefined)}>
            <option value="">Digital (EPUB)</option>
            {FORMS.slice(1).map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        {text("Title", "title")}
        {text("Subtitle", "subtitle")}
        {text("Series", "seriesName")}
        {text("Number in series", "seriesNumber")}
        {text("Edition", "editionNumber")}
        <label className="flex flex-col gap-0.5">
          <span className={cls.label}>Language (ISO 639-2)</span>
          <input aria-label="Language" className={cls.input} list="book-langs" maxLength={3} value={b.language ?? ""} placeholder="eng"
            onChange={(e) => set("language", e.target.value.toLowerCase() || undefined)} />
          <datalist id="book-langs">{LANGS.map((l) => <option key={l} value={l} />)}</datalist>
        </label>
        {text("Publisher", "publisherName")}
        {text("Imprint", "imprint")}
        <label className="flex flex-col gap-0.5">
          <span className={cls.label}>Publication date</span>
          <input aria-label="Publication date" type="date" className={cls.input}
            value={b.publicationDate ? `${b.publicationDate.slice(0, 4)}-${b.publicationDate.slice(4, 6)}-${b.publicationDate.slice(6, 8)}` : ""}
            onChange={(e) => set("publicationDate", e.target.value.replace(/-/g, "") || undefined)} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={cls.label}>Pages</span>
          <input aria-label="Page count" type="number" min={0} className={cls.input} value={b.pageCount ?? ""} onChange={(e) => set("pageCount", Number(e.target.value) || undefined)} />
        </label>
      </div>

      <span className={cls.label}>Contributors</span>
      {(b.contributors ?? []).map((c, i) => (
        <div key={i} className="grid grid-cols-[130px_1fr_auto] items-center gap-1.5">
          <select aria-label={`Contributor role ${i + 1}`} className={cls.select} value={c.role}
            onChange={(e) => set("contributors", (b.contributors ?? []).map((x, k) => (k === i ? { ...x, role: e.target.value } : x)))}>
            {ROLES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <input aria-label={`Contributor name ${i + 1}`} className={cls.input} value={c.personName} placeholder="Name"
            onChange={(e) => set("contributors", (b.contributors ?? []).map((x, k) => (k === i ? { ...x, personName: e.target.value } : x)))} />
          <Button aria-label={`Remove contributor ${i + 1}`} onPress={() => set("contributors", (b.contributors ?? []).filter((_, k) => k !== i))}>×</Button>
        </div>
      ))}
      <Button onPress={() => set("contributors", [...(b.contributors ?? []), { role: "A01", personName: "" }])}>Add a contributor</Button>

      <span className={cls.label}>Subjects</span>
      {(b.subjects ?? []).map((s, i) => (
        <div key={i} className="grid grid-cols-[110px_130px_1fr_auto] items-center gap-1.5">
          <select aria-label={`Subject scheme ${i + 1}`} className={cls.select} value={s.scheme}
            onChange={(e) => set("subjects", (b.subjects ?? []).map((x, k) => (k === i ? { ...x, scheme: e.target.value } : x)))}>
            {SCHEMES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <input aria-label={`Subject code ${i + 1}`} className={cls.input} value={s.code} placeholder="FIC014000"
            onChange={(e) => set("subjects", (b.subjects ?? []).map((x, k) => (k === i ? { ...x, code: e.target.value } : x)))} />
          <input aria-label={`Subject heading ${i + 1}`} className={cls.input} value={s.heading ?? ""} placeholder="Heading (optional)"
            onChange={(e) => set("subjects", (b.subjects ?? []).map((x, k) => (k === i ? { ...x, heading: e.target.value || undefined } : x)))} />
          <Button aria-label={`Remove subject ${i + 1}`} onPress={() => set("subjects", (b.subjects ?? []).filter((_, k) => k !== i))}>×</Button>
        </div>
      ))}
      <Button onPress={() => set("subjects", [...(b.subjects ?? []), { scheme: "10", code: "" }])}>Add a subject</Button>

      <span className={cls.label}>Prices</span>
      {(b.prices ?? []).map((p, i) => (
        <div key={i} className="grid grid-cols-[150px_1fr_80px_auto] items-center gap-1.5">
          <select aria-label={`Price type ${i + 1}`} className={cls.select} value={p.priceType}
            onChange={(e) => set("prices", (b.prices ?? []).map((x, k) => (k === i ? { ...x, priceType: e.target.value } : x)))}>
            <option value="02">Recommended, incl. tax</option>
            <option value="01">Recommended, excl. tax</option>
          </select>
          <input aria-label={`Price amount ${i + 1}`} className={cls.input} value={p.amount} placeholder="9.99"
            onChange={(e) => set("prices", (b.prices ?? []).map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} />
          <input aria-label={`Price currency ${i + 1}`} className={cls.input} value={p.currency} placeholder="EUR" maxLength={3}
            onChange={(e) => set("prices", (b.prices ?? []).map((x, k) => (k === i ? { ...x, currency: e.target.value.toUpperCase() } : x)))} />
          <Button aria-label={`Remove price ${i + 1}`} onPress={() => set("prices", (b.prices ?? []).filter((_, k) => k !== i))}>×</Button>
        </div>
      ))}
      <Button onPress={() => set("prices", [...(b.prices ?? []), { priceType: "02", amount: "", currency: "EUR" }])}>Add a price</Button>

      <label className="flex flex-col gap-0.5">
        <span className={cls.label}>Description (blank line = new paragraph)</span>
        <textarea aria-label="Description" rows={5} className="w-full rounded-md border border-line bg-surface p-2 text-[13px]" value={b.description ?? ""}
          onChange={(e) => set("description", e.target.value.trim() === "" ? undefined : e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {text("Message sender", "senderName", "defaults to the publisher")}
        {text("Sender email", "senderEmail")}
      </div>

      {!valid && <p role="alert" className="text-danger">Some values are not valid (codes, amounts, dates or lengths); fix them before saving.</p>}
      {problems.length > 0 && (
        <ul aria-label="ONIX completeness" className="flex flex-col gap-0.5 text-[12px]">
          {problems.map((p, i) => <li key={i} className={p.severity === "error" ? "text-danger" : "text-fg-subtle"}>{p.severity === "error" ? "Required: " : "Missing: "}{p.message}</li>)}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button onPress={onClose}>Cancel</Button>
        <select aria-label="ONIX release" className={cls.select} value={release} onChange={(e) => setRelease(e.target.value as OnixRelease)}>
          <option value="3.1">ONIX 3.1</option>
          <option value="3.0">ONIX 3.0</option>
        </select>
        <Button isDisabled={!valid || problems.some((p) => p.severity === "error")} onPress={download}>Save and download ONIX…</Button>
        <Button variant="primary" isDisabled={!valid} onPress={() => { save(); onClose(); }}>Save</Button>
      </div>
    </Dialog>
  );
}

export function BookMetadataDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  if (!scene || !isOpen) return null;
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[90vh] w-full max-w-[680px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Form onClose={() => onOpenChange(false)} />
      </Modal>
    </ModalOverlay>
  );
}
