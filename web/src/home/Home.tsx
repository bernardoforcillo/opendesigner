import { useCallback, useEffect, useRef, useState } from "react";
import { Button as RacButton, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Banner, Button, EmptyState, Icon } from "../ui/ds";
import { Logo } from "../ui/shell/DocMenu";
import { TEMPLATES } from "../templates/catalog";
import type { Template } from "../templates/catalog";
import { docClient } from "../rpc/client";
import { DocCard, type DocSummary } from "./DocCard";
import { TemplatePreview } from "./TemplatePreview";
import { hashForDoc, parseJoinLink, sortRecent } from "./route";
import { startDocument, StartError, type StartClient } from "./startDocument";

// LA HOME: il punto d'ingresso dell'app. Da qui si parte -- da un template o da
// una tavola vuota --, si riprende un documento o ci si unisce a quello di un
// collega con il suo link. Ogni documento nasce QUI, esplicitamente: l'editor
// non ne crea più uno da solo aprendosi.

/** La parte del client RPC che serve alla Home (i test ne passano uno finto). */
export interface HomeClient extends StartClient {
  listDocuments(req: Record<string, never>): Promise<{ docs: { id: string; name: string; updatedAt: bigint | number; screens: number; flows: number }[] }>;
  renameDocument(req: { docId: string; name: string }): Promise<unknown>;
  deleteDocument(req: { docId: string }): Promise<unknown>;
}

const JOURNEY = [
  { label: "Design", icon: "frame" },
  { label: "Flussi", icon: "flow" },
  { label: "Prova", icon: "play" },
  { label: "Sviluppo", icon: "code" },
  { label: "Export", icon: "download" },
] as const;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Home({
  client = docClient as unknown as HomeClient,
  navigate = (hash: string) => { location.hash = hash; },
  focusTemplates = false,
  now = () => Date.now(),
}: {
  client?: HomeClient;
  navigate?: (hash: string) => void;
  focusTemplates?: boolean;
  now?: () => number;
}) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ id: string; done: number; total: number } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<DocSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const templatesRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await client.listDocuments({});
      setDocs(sortRecent(res.docs.map((d) => ({
        id: d.id, name: d.name, updatedAt: Number(d.updatedAt), screens: d.screens, flows: d.flows,
      }))));
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
      setDocs((d) => d ?? []);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  // `#new` ("Nuovo documento" dal menu dell'editor) porta dritti ai template.
  useEffect(() => {
    if (focusTemplates) templatesRef.current?.scrollIntoView?.({ block: "start" });
  }, [focusTemplates]);

  async function start(t: Template) {
    if (starting) return;
    setStartError(null);
    setStarting({ id: t.id, done: 0, total: 1 });
    try {
      const id = await startDocument(client, t, {
        clientId: "home",
        onProgress: (done, total) => setStarting({ id: t.id, done, total }),
      });
      navigate(hashForDoc(id));
    } catch (e) {
      setStartError(e instanceof StartError && e.docId
        ? `Il template non si è applicato per intero (${e.message}). Il documento è nell'elenco: puoi aprirlo o eliminarlo.`
        : `Impossibile creare il documento: ${errText(e)}`);
      setStarting(null);
      void load();
    }
  }

  async function rename(id: string, name: string) {
    await client.renameDocument({ docId: id, name });
    setDocs((cur) => cur && cur.map((d) => (d.id === id ? { ...d, name } : d)));
  }

  async function confirmDelete() {
    if (!toDelete) return;
    try {
      await client.deleteDocument({ docId: toDelete.id });
      setDocs((cur) => cur && cur.filter((d) => d.id !== toDelete.id));
      setToDelete(null); setDeleteError(null);
      try { if (localStorage.getItem("opendesigner.docId") === toDelete.id) localStorage.removeItem("opendesigner.docId"); } catch { /* storage non disponibile */ }
    } catch (e) {
      setDeleteError(errText(e));
    }
  }

  return (
    <div className="flex h-screen flex-col bg-canvas text-fg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">opendesigner</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <JoinField navigate={navigate} />
          <Button variant="primary" icon="plus" onPress={() => void start(TEMPLATES[0])} isDisabled={!!starting} className="h-8">
            Nuovo documento
          </Button>
        </div>
      </header>

      {startError && <Banner tone="danger" onClose={() => setStartError(null)}>{startError}</Banner>}
      {loadError && <Banner tone="warn" onClose={() => setLoadError(null)}>Impossibile leggere i documenti ({loadError}).</Banner>}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-16 pt-8 sm:px-6">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Cosa vuoi progettare oggi?</h1>
          <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-fg-muted">
            Parti da un template o da una tavola vuota: disegni le schermate, le colleghi in un flusso, le provi
            come prototipo e porti a casa il codice.
          </p>
          <ol aria-label="Il percorso" className="mt-4 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
            {JOURNEY.map((s, i) => (
              <li key={s.label} className="flex items-center gap-1.5">
                <span className="flex h-6 items-center gap-1.5 rounded-full bg-surface px-2.5 shadow-[0_0_0_1px_var(--line)]">
                  <Icon name={s.icon} size={12} className="text-fg-subtle" /> {s.label}
                </span>
                {i < JOURNEY.length - 1 && <Icon name="chevronRight" size={10} className="text-fg-subtle" />}
              </li>
            ))}
          </ol>

          <section ref={templatesRef} aria-labelledby="home-templates" className="mt-9">
            <h2 id="home-templates" className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Inizia da un template</h2>
            <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(188px,1fr))]">
              {TEMPLATES.map((t) => (
                <TemplateCard key={t.id} template={t} busy={starting?.id === t.id ? starting : null} disabled={!!starting} onPick={() => void start(t)} />
              ))}
            </div>
          </section>

          <section aria-labelledby="home-docs" className="mt-10">
            <h2 id="home-docs" className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
              I tuoi documenti
              {docs && docs.length > 0 && <span className="tabular-nums">{docs.length}</span>}
            </h2>
            {docs === null ? (
              <p role="status" className="mt-4 text-[13px] text-fg-subtle">Carico i documenti…</p>
            ) : docs.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-line-strong bg-surface">
                <EmptyState
                  icon="page"
                  title="Nessun documento, per ora"
                  hint="Scegli un template qui sopra: in un click hai schermate già collegate da provare."
                />
              </div>
            ) : (
              <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
                {docs.map((d) => (
                  <DocCard key={d.id} doc={d} now={now()} onRename={rename} onDelete={(x) => { setDeleteError(null); setToDelete(x); }} />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      <ModalOverlay
        isOpen={!!toDelete}
        onOpenChange={(o) => { if (!o) setToDelete(null); }}
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      >
        <Modal className="w-full max-w-[380px] rounded-xl bg-raised p-4 text-fg shadow-pop outline-none">
          <Dialog role="alertdialog" className="outline-none">
            {({ close }) => (
              <>
                <Heading slot="title" className="text-[14px] font-semibold">Eliminare “{toDelete?.name}”?</Heading>
                <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
                  Il documento sparisce dall’elenco. I file restano nella cartella <code className="text-[12px]">.trash</code> del
                  workspace, quindi si può ancora recuperare a mano.
                </p>
                {deleteError && <p role="alert" className="mt-2 text-[12px] text-danger">{deleteError}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="secondary" onPress={close} autoFocus>Annulla</Button>
                  <RacButton
                    onPress={() => void confirmDelete()}
                    className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-danger px-2.5 text-[13px] font-medium text-white outline-none hover:brightness-110 focus-visible:shadow-[var(--ring)]"
                  >
                    <Icon name="trash" size={14} /> Elimina
                  </RacButton>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

function TemplateCard({
  template, busy, disabled, onPick,
}: { template: Template; busy: { done: number; total: number } | null; disabled: boolean; onPick: () => void }) {
  return (
    <RacButton
      onPress={onPick}
      isDisabled={disabled && !busy}
      aria-label={`Crea da template: ${template.name}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-left outline-none transition-shadow hover:shadow-[var(--shadow-bar)] focus-visible:shadow-[var(--ring)] disabled:opacity-50"
    >
      <div className="relative flex h-[112px] items-center justify-center border-b border-line bg-surface-2 px-3 py-2">
        <TemplatePreview template={template} className="h-full w-full" />
        {busy && (
          <div role="status" className="absolute inset-0 flex items-center justify-center bg-surface/80 text-[12px] font-medium text-fg-muted">
            Creo… {busy.total > 1 ? `${Math.round((busy.done / busy.total) * 100)}%` : ""}
          </div>
        )}
      </div>
      <div className="px-3 pb-3 pt-2.5">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <Icon name={template.icon} size={13} className="text-fg-subtle" /> {template.name}
        </h3>
        <p className="mt-0.5 text-[12px] leading-snug text-fg-muted">{template.tagline}</p>
      </div>
    </RacButton>
  );
}

/** "Unisciti": incolla il link di un collega (o il suo id) e si entra nel suo documento. */
function JoinField({ navigate }: { navigate: (hash: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function join() {
    const id = parseJoinLink(text);
    if (!id) { setError("Non è un link di opendesigner valido."); return; }
    navigate(hashForDoc(id));
  }

  return (
    <form className="relative hidden items-center gap-1.5 sm:flex" onSubmit={(e) => { e.preventDefault(); join(); }}>
      <input
        aria-label="Link di un documento condiviso"
        aria-invalid={error ? true : undefined}
        placeholder="Incolla un link per unirti"
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        className="h-8 w-[220px] min-w-0 rounded-md border border-transparent bg-surface-2 px-2.5 text-[13px] text-fg placeholder:text-fg-subtle hover:border-line-strong focus:border-accent focus:bg-surface focus:outline-none"
      />
      <Button type="submit" variant="secondary" icon="link" isDisabled={text.trim() === ""} className="h-8">Unisciti</Button>
      {error && <p role="alert" className="absolute right-0 top-9 z-10 whitespace-nowrap rounded-md bg-danger-soft px-2 py-1 text-[12px] text-danger">{error}</p>}
    </form>
  );
}
