import { useCallback, useEffect, useState } from "react";
import { Button as RacButton, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Banner, Button, Icon } from "@/ui/ds";
import { useT } from "@/i18n";
import { pathForDoc } from "@/home/route";

// BOOKS in the Home: several documents (chapters) that share styles and one page count. A book is a record
// of the workspace that names the documents; "Bring into line" asks the server to copy the style source's
// styles into the other chapters and to make each chapter's numbering continue the one before (docs/book.md).

export interface BookData { id: string; name: string; docIds: string[]; styleSourceId: string; startNumber: number }
export interface BookChapterData {
  docId: string; name: string; pages: number; firstPageNumber: number; missing: boolean; numbered: boolean; stylesBehind: number;
}
interface BookView { book: BookData; chapters: BookChapterData[] }

/** The part of the RPC client the books need (tests pass a fake one). */
export interface BooksClient {
  listBooks(req: Record<string, never>): Promise<{ books: BookData[] }>;
  getBook(req: { bookId: string }): Promise<{ book?: BookData; chapters: BookChapterData[] }>;
  saveBook(req: { book: { id: string; name: string; docIds: string[]; styleSourceId: string; startNumber: number } }): Promise<unknown>;
  deleteBook(req: { bookId: string }): Promise<unknown>;
  syncBook(req: { bookId: string; styles: boolean; numbering: boolean }): Promise<unknown>;
}

interface DocRef { id: string; name: string }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The draft the editing dialog works on. */
interface Draft { id: string; name: string; docIds: string[]; styleSourceId: string; startNumber: string }

export function BooksSection({ client, docs }: { client: BooksClient; docs: DocRef[] }) {
  const { t, tn } = useT();
  const [books, setBooks] = useState<BookView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<BookData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { books: list } = await client.listBooks({});
      const views = await Promise.all(list.map(async (b) => {
        const r = await client.getBook({ bookId: b.id });
        return { book: r.book ?? b, chapters: r.chapters };
      }));
      setBooks(views);
      setError(null);
    } catch (e) {
      setError(errText(e));
      setBooks((b) => b ?? []);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const nameOf = (id: string) => docs.find((d) => d.id === id)?.name ?? id;

  async function save() {
    if (!draft) return;
    const start = Number.parseInt(draft.startNumber, 10);
    try {
      await client.saveBook({ book: {
        id: draft.id, name: draft.name.trim(), docIds: draft.docIds,
        styleSourceId: draft.styleSourceId, startNumber: Number.isFinite(start) && start > 0 ? start : 0,
      } });
      setDraft(null); setDraftError(null);
      await load();
    } catch (e) {
      setDraftError(errText(e));
    }
  }

  async function sync(b: BookData) {
    setBusy(b.id);
    try {
      await client.syncBook({ bookId: b.id, styles: true, numbering: true });
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    try {
      await client.deleteBook({ bookId: toDelete.id });
      setToDelete(null);
      await load();
    } catch (e) {
      setError(errText(e));
      setToDelete(null);
    }
  }

  const edit = (b?: BookData) => {
    setDraftError(null);
    setDraft(b
      ? { id: b.id, name: b.name, docIds: [...b.docIds], styleSourceId: b.styleSourceId, startNumber: b.startNumber > 1 ? String(b.startNumber) : "" }
      : { id: "", name: "", docIds: [], styleSourceId: "", startNumber: "" });
  };
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const move = (i: number, by: -1 | 1) => draft && patch({
    docIds: draft.docIds.map((_, k, a) => a[k === i ? i + by : k === i + by ? i : k]),
  });

  return (
    <section aria-labelledby="home-books" className="mt-10">
      <div className="flex items-center gap-3">
        <h2 id="home-books" className="flex items-baseline gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          {t("Books")}
          {books && books.length > 0 && <span className="tabular-nums">{books.length}</span>}
        </h2>
        <Button variant="secondary" icon="plus" onPress={() => edit()} className="ml-auto h-7">{t("New book")}</Button>
      </div>
      {error && <Banner tone="warn" onClose={() => setError(null)}>{t("Could not read the books ({error}).", { error })}</Banner>}
      {books !== null && books.length === 0 && (
        <p className="mt-3 text-[13px] text-fg-muted">{t("No books yet")}. {t("Several documents that share styles and one page count.")}</p>
      )}
      <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
        {books?.map(({ book, chapters }) => {
          const inStep = chapters.every((c) => c.missing || (c.numbered && c.stylesBehind === 0));
          return (
            <article key={book.id} aria-label={book.name} className="flex flex-col rounded-xl border border-line bg-surface p-3">
              <header className="flex items-center gap-2">
                <Icon name="layers" size={14} className="text-fg-subtle" />
                <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{book.name}</h3>
                <span className="text-[11px] text-fg-subtle">{tn("{n} chapters", chapters.length)}</span>
              </header>
              <ol className="mt-2 flex flex-col gap-1 text-[12px]">
                {chapters.map((c) => (
                  <li key={c.docId} className="flex items-baseline gap-2">
                    {c.missing ? (
                      <span className="min-w-0 flex-1 truncate text-danger">{t("Chapter missing")}</span>
                    ) : (
                      <a href={pathForDoc(c.docId)} className="min-w-0 flex-1 truncate text-fg hover:underline">{c.name || nameOf(c.docId)}</a>
                    )}
                    {!c.missing && (
                      <span className="shrink-0 tabular-nums text-fg-muted">
                        {tn("{n} pages", c.pages)} · {t("Starts at page {n}", { n: c.firstPageNumber })}
                      </span>
                    )}
                    {!c.missing && c.stylesBehind > 0 && <span className="shrink-0 text-warn">{tn("{n} styles behind", c.stylesBehind)}</span>}
                  </li>
                ))}
              </ol>
              <footer className="mt-3 flex items-center gap-2">
                <span className={"text-[11px] " + (inStep ? "text-fg-subtle" : "text-warn")}>{inStep ? t("In step") : t("Out of step")}</span>
                <Button variant="secondary" onPress={() => void sync(book)} isDisabled={inStep || busy === book.id} className="ml-auto">{t("Bring into line")}</Button>
                <Button variant="secondary" onPress={() => edit(book)} aria-label={`${t("Edit book")}: ${book.name}`}>{t("Edit book")}</Button>
                <RacButton
                  aria-label={`${t("Delete book")}: ${book.name}`}
                  onPress={() => setToDelete(book)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-2 focus-visible:shadow-[var(--ring)]"
                >
                  <Icon name="trash" size={14} />
                </RacButton>
              </footer>
            </article>
          );
        })}
      </div>

      <ModalOverlay isOpen={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }} isDismissable className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <Modal className="w-full max-w-[460px] rounded-xl bg-raised p-4 text-fg shadow-pop outline-none">
          <Dialog className="outline-none" aria-label={draft?.id ? t("Edit book") : t("New book")}>
            {({ close }) => draft && (
              <>
                <Heading slot="title" className="text-[14px] font-semibold">{draft.id ? t("Edit book") : t("New book")}</Heading>
                <label className="mt-3 flex flex-col gap-1 text-[12px] text-fg-muted">
                  {t("Book name")}
                  <input
                    aria-label={t("Book name")} value={draft.name} onChange={(e) => patch({ name: e.target.value })} autoFocus
                    className="h-8 rounded-md border border-line bg-surface-2 px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none"
                  />
                </label>
                <h4 className="mt-3 text-[12px] text-fg-muted">{t("Chapters")}</h4>
                <ol className="mt-1 flex flex-col gap-1">
                  {draft.docIds.map((id, i) => (
                    <li key={id} className="flex items-center gap-1 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{nameOf(id)}</span>
                      <RacButton aria-label={`${t("Move chapter up")}: ${nameOf(id)}`} isDisabled={i === 0} onPress={() => move(i, -1)} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-2 disabled:opacity-30 focus-visible:shadow-[var(--ring)]"><Icon name="chevronUp" size={12} /></RacButton>
                      <RacButton aria-label={`${t("Move chapter down")}: ${nameOf(id)}`} isDisabled={i === draft.docIds.length - 1} onPress={() => move(i, 1)} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-2 disabled:opacity-30 focus-visible:shadow-[var(--ring)]"><Icon name="chevronDown" size={12} /></RacButton>
                      <RacButton aria-label={`${t("Remove chapter")}: ${nameOf(id)}`} onPress={() => patch({ docIds: draft.docIds.filter((x) => x !== id), styleSourceId: draft.styleSourceId === id ? "" : draft.styleSourceId })} className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-surface-2 focus-visible:shadow-[var(--ring)]"><Icon name="x" size={12} /></RacButton>
                    </li>
                  ))}
                </ol>
                <select
                  aria-label={t("Add a chapter…")} value=""
                  onChange={(e) => { if (e.target.value) patch({ docIds: [...draft.docIds, e.target.value] }); }}
                  className="mt-2 h-8 w-full rounded-md border border-line bg-surface-2 px-2 text-[13px]"
                >
                  <option value="">{t("Add a chapter…")}</option>
                  {docs.filter((d) => !draft.docIds.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <div className="mt-3 grid grid-cols-2 gap-3 text-[12px] text-fg-muted">
                  <label className="flex flex-col gap-1">
                    {t("Style source")}
                    <select aria-label={t("Style source")} value={draft.styleSourceId} onChange={(e) => patch({ styleSourceId: e.target.value })} className="h-8 rounded-md border border-line bg-surface-2 px-2 text-[13px] text-fg">
                      <option value="">{draft.docIds[0] ? nameOf(draft.docIds[0]) : "—"}</option>
                      {draft.docIds.slice(1).map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    {t("First page number")}
                    <input aria-label={t("First page number")} type="number" min={1} placeholder="1" value={draft.startNumber} onChange={(e) => patch({ startNumber: e.target.value })} className="h-8 rounded-md border border-line bg-surface-2 px-2.5 text-[13px] text-fg focus:border-accent focus:outline-none" />
                  </label>
                </div>
                {draftError && <p role="alert" className="mt-2 text-[12px] text-danger">{draftError}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="secondary" onPress={close}>{t("Cancel")}</Button>
                  <Button variant="primary" onPress={() => void save()} isDisabled={draft.name.trim() === ""}>{t("Save")}</Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay isOpen={!!toDelete} onOpenChange={(o) => { if (!o) setToDelete(null); }} isDismissable className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <Modal className="w-full max-w-[380px] rounded-xl bg-raised p-4 text-fg shadow-pop outline-none">
          <Dialog role="alertdialog" className="outline-none">
            {({ close }) => (
              <>
                <Heading slot="title" className="text-[14px] font-semibold">{t("Delete “{name}”? The documents stay.", { name: toDelete?.name ?? "" })}</Heading>
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="secondary" onPress={close} autoFocus>{t("Cancel")}</Button>
                  <RacButton
                    onPress={() => void confirmDelete()}
                    className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white outline-none hover:brightness-110 focus-visible:shadow-[var(--ring)]"
                  >
                    <Icon name="trash" size={14} /> {t("Delete book")}
                  </RacButton>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  );
}
