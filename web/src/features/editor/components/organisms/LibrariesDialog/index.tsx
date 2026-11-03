import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { create } from "@bufbuild/protobuf";
import {
  GetLibraryRequestSchema, ImportFromLibraryRequestSchema, LibraryItemKind, LibraryItemSchema, ListDocumentsRequestSchema,
  SetLibraryRequestSchema,
} from "@/gen/opendesigner/v1/opendesigner_pb";
import type { DocInfo, ImportFromLibraryResponse, LibraryItem } from "@/gen/opendesigner/v1/opendesigner_pb";
import { useT } from "@/i18n";
import { docClient } from "@/rpc/client";
import { useScene } from "@/store/store";
import { Button, cls } from "@/ui/ds";

// THE LIBRARIES DIALOG (document menu → Libraries…): publish this document as a shared library, and
// import components, styles and variables from another document that is one. An import copies the
// items (and what they need) into this document as ordinary edits: editable, undoable, shared with
// everyone in the document.

const KINDS: { kind: LibraryItemKind; label: "Components" | "Text styles" | "Paint styles" | "Effect styles" | "Object styles" | "Variable collections" }[] = [
  { kind: LibraryItemKind.COMPONENT, label: "Components" },
  { kind: LibraryItemKind.TEXT_STYLE, label: "Text styles" },
  { kind: LibraryItemKind.PAINT_STYLE, label: "Paint styles" },
  { kind: LibraryItemKind.EFFECT_STYLE, label: "Effect styles" },
  { kind: LibraryItemKind.OBJECT_STYLE, label: "Object styles" },
  { kind: LibraryItemKind.COLLECTION, label: "Variable collections" },
];

const keyOf = (i: LibraryItem) => `${i.kind}:${i.id}`;

export function LibrariesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn } = useT();
  const docId = useScene((s) => s.scene?.id ?? "");
  const [docs, setDocs] = useState<DocInfo[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportFromLibraryResponse | null>(null);

  const me = docs.find((d) => d.id === docId);
  const libraries = useMemo(() => docs.filter((d) => d.library && d.id !== docId), [docs, docId]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "the request failed"); } finally { setBusy(false); }
  }, []);

  const refresh = useCallback(() => guard(async () => {
    const r = await docClient.listDocuments(create(ListDocumentsRequestSchema, {}));
    setDocs(r.docs);
  }), [guard]);

  useEffect(() => {
    if (!isOpen) return;
    setResult(null);
    void refresh();
  }, [isOpen, refresh]);

  // The first library is chosen on its own; the choice is dropped when its document stops being one.
  useEffect(() => {
    if (libraries.some((d) => d.id === libraryId)) return;
    setLibraryId(libraries[0]?.id ?? "");
  }, [libraries, libraryId]);

  useEffect(() => {
    setItems([]);
    setPicked(new Set());
    if (!isOpen || libraryId === "") return;
    let live = true;
    docClient.getLibrary(create(GetLibraryRequestSchema, { docId: libraryId })).then(
      (r) => { if (live) setItems(r.items); },
      (e) => { if (live) setError(e instanceof Error ? e.message : "could not read the library"); },
    );
    return () => { live = false; };
  }, [isOpen, libraryId]);

  const publish = (on: boolean) => guard(async () => {
    await docClient.setLibrary(create(SetLibraryRequestSchema, { docId, library: on }));
    const r = await docClient.listDocuments(create(ListDocumentsRequestSchema, {}));
    setDocs(r.docs);
  });

  const toggle = (i: LibraryItem) => setPicked((prev) => {
    const next = new Set(prev);
    if (!next.delete(keyOf(i))) next.add(keyOf(i));
    return next;
  });

  const doImport = () => guard(async () => {
    const chosen = items.filter((i) => picked.has(keyOf(i))).map((i) => create(LibraryItemSchema, { kind: i.kind, id: i.id }));
    setResult(await docClient.importFromLibrary(create(ImportFromLibraryRequestSchema, { docId, libraryDocId: libraryId, items: chosen })));
    setPicked(new Set());
  });

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[520px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Libraries")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Libraries")}</h2>

          <label className="flex items-start gap-2">
            <input
              type="checkbox" checked={me?.library ?? false} disabled={busy || me === undefined}
              onChange={(e) => void publish(e.target.checked)}
            />
            <span>
              <span className="block font-medium">{t("Publish as a library")}</span>
              <span className="block text-fg-subtle">{t("Publish this document as a library so other documents can import its components, styles and variables.")}</span>
            </span>
          </label>

          <section aria-label={t("Import from a library")} className="flex flex-col gap-2 border-t border-line pt-3">
            <h3 className="font-semibold">{t("Import from a library")}</h3>
            {libraries.length === 0 ? (
              <p className="text-fg-subtle">{t("No other document is published as a library yet.")}</p>
            ) : (
              <>
                <select aria-label={t("Library")} className={cls.input} value={libraryId} onChange={(e) => setLibraryId(e.target.value)}>
                  {libraries.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                {KINDS.map(({ kind, label }) => {
                  const of = items.filter((i) => i.kind === kind);
                  if (of.length === 0) return null;
                  return (
                    <fieldset key={kind} className="flex flex-col gap-0.5">
                      <legend className="mb-0.5 text-[11px] uppercase tracking-wide text-fg-subtle">{t(label)}</legend>
                      {of.map((i) => (
                        <label key={keyOf(i)} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2">
                          <input type="checkbox" checked={picked.has(keyOf(i))} onChange={() => toggle(i)} />
                          <span className="min-w-0 flex-1 truncate">{i.name || i.id}</span>
                        </label>
                      ))}
                    </fieldset>
                  );
                })}
                <div>
                  <Button variant="primary" isDisabled={busy || picked.size === 0} onPress={() => void doImport()}>{t("Import selected")}</Button>
                </div>
              </>
            )}
            {result && (
              <div role="status" className="text-ok">
                <p>{tn("Imported {n} items.", result.imported.length)}</p>
                {result.skipped.length > 0 && <p className="text-fg-subtle">{tn("{n} components were already in the document and were left as they are.", result.skipped.length)}</p>}
              </div>
            )}
          </section>

          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end border-t border-line pt-3">
            <Button onPress={() => onOpenChange(false)}>{t("Done")}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
