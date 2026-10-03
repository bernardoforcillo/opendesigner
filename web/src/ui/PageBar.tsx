import { useEffect, useRef, useState } from "react";
import { Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Button, Icon, IconButton, cls } from "./ds";
import { useScene } from "../store/store";
import { makeCreatePageOp, makeDeletePageOp, makeRenamePageOp, uuid } from "../tools/ops";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

// SELETTORE DI PAGINA (traccia annidamento, parte client). Il canvas mostra UNA
// pagina alla volta (canvasRenderer.ts::rootsOf legge currentPageId); questa
// barra è dove la si sceglie, si aggiungono/eliminano pagine e si rinominano.
//
// Aspetto: un pulsante compatto con la pagina CORRENTE e un chevron, che apre un
// popover con l'elenco (selezione, rinomina ed elimina per riga, "Aggiungi una
// pagina" in fondo). Accanto, "Nuova pagina" ed "Elimina pagina" restano sempre
// a portata di click (agiscono sulla corrente).
//
// currentPageId è STATO DI VISTA e si legge/scrive dallo STESSO store del
// canvas (store.ts::setCurrentPage): un solo stato, niente da sincronizzare a
// mano fra barra e renderer. Gli op di pagina (CreatePage/DeletePage/
// RenamePage) esistono già in proto + core + applyOp.ts: qui si CABLANO soltanto,
// dallo stesso percorso di gesto dei tool e dei pannelli.

// Un op = un gesto = un invio in rete (la regola del brief M1b, la stessa che
// seguono i tool e LayersPanel): anche la singola azione di pagina passa da
// beginGesture/endGesture, così viaggia sul filo come qualunque altra modifica.
function submit(op: Op): void {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture([op]);
}

const RENAME_LABEL = "Nome della pagina";

// Campo di rinomina inline, gemello di quello di LayersPanel (stesso motivo per
// cui è un componente a parte: la sessione ha uno stato suo -- il testo digitato
// e il fatto di essere già chiusa -- che deve nascere e morire con il campo).
function PageRenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  // Si chiude UNA volta sola: Enter/Escape chiudono, e il blur che arriva subito
  // dopo (il campo sta per smontarsi) non deve confermare una seconda volta.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  function settle(commit: boolean) {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      aria-label={RENAME_LABEL}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(e) => {
        // NIENTE tasto esce da qui: le scorciatoie globali (undo/redo su window,
        // Escape/Canc su toolManager) non devono agire mentre si scrive un nome.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          settle(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      // flex-1: occupa lo spazio del pulsante-pagina che sostituisce, così la
      // barra non "salta" quando si apre la rinomina.
      className={`${cls.input} flex-1 select-text border-accent bg-surface focus-visible:shadow-none!`}
    />
  );
}

// `compact`: il selettore dentro la riga delle schede del pannello sinistro --
// niente riga propria, niente pulsanti + e cestino (nuova pagina ed eliminazione
// stanno già nell'elenco che il pulsante apre).
export function PageBar({ compact = false }: { compact?: boolean } = {}) {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  // La pagina il cui nome è in rinomina, o null. Una sola alla volta.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Il popover dell'elenco è CONTROLLATO: va chiuso a mano dopo la scelta di una
  // pagina o l'avvio di una rinomina (la rinomina vive nella barra).
  const [open, setOpen] = useState(false);

  // Senza documento non c'è nessuna pagina da mostrare: la barra sparisce del
  // tutto invece di disegnarsi vuota (stesso ripiego di LayersPanel a scene
  // nulla).
  if (!scene) return null;
  const pages = scene.pages;
  const current = pages.find((p) => p.id === currentPageId) ?? pages[0];
  const pageLabel = (name: string) => (name.trim() !== "" ? name : "Pagina senza nome");

  function createPage() {
    // id noto PRIMA del submit: ci si sposta sopra subito, senza aspettare
    // l'eco (l'op è già stato applicato in ottimistico da endGesture).
    const id = uuid();
    submit(makeCreatePageOp(id, `Page ${pages.length + 1}`));
    useScene.getState().setCurrentPage(id);
    setOpen(false);
  }

  // La cascata, il rifiuto dell'ultima pagina ecc. sono del core: qui si evita
  // solo di MANDARE un op che si sa già rifiutato (l'ultima pagina non si
  // cancella), che è anche perché i pulsanti sono disabilitati sotto.
  function deletePage(id: string | null) {
    if (pages.length <= 1 || id === null) return;
    submit(makeDeletePageOp(id));
  }

  function commitRename(id: string, raw: string) {
    setRenamingId(null);
    const name = raw.trim();
    const page = pages.find((p) => p.id === id);
    // Niente op per un nome invariato o vuoto (come commitRename di LayersPanel):
    // un op "che non cambia niente" costerebbe un giro di rete a vuoto.
    if (!page || name === "" || name === page.name) return;
    submit(makeRenamePageOp(id, name));
  }

  return (
    <div
      role="group"
      aria-label="Pagine"
      className={compact ? "flex w-[112px] shrink-0 items-center" : "flex h-10 shrink-0 items-center gap-1 border-b border-line px-2"}
    >
      {current && renamingId === current.id ? (
        <PageRenameField
          initial={current.name}
          placeholder={current.name || "Pagina"}
          onCommit={(value) => commitRename(current.id, value)}
          onCancel={() => setRenamingId(null)}
        />
      ) : (
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          {/* Il doppio click sta sul WRAPPER e non sul Button: react-aria-
              components non inoltra onDoubleClick al <button>, ma l'evento vi
              risale comunque (bubbling). Il click singolo apre l'elenco; il
              doppio apre la rinomina della pagina corrente. */}
          <div
            className="min-w-0 flex-1"
            onDoubleClick={() => {
              if (!current) return;
              setOpen(false);
              setRenamingId(current.id);
            }}
          >
            <Button
              className={
                "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-fg " +
                "outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[var(--ring)] data-[pressed]:bg-surface-3"
              }
            >
              <Icon name="page" size={14} className="shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate">{current ? pageLabel(current.name) : "Pagina"}</span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-fg-subtle" />
            </Button>
          </div>
          <Popover
            placement="bottom start"
            offset={4}
            className="z-50 w-60 rounded-lg border border-line bg-raised text-fg shadow-pop outline-none"
          >
            <Dialog aria-label="Elenco pagine" className="flex flex-col outline-none">
              <ul className="flex max-h-64 flex-col gap-px overflow-auto p-1">
                {pages.map((p) => {
                  const active = p.id === currentPageId;
                  return (
                    <li key={p.id} className="group/page flex items-center gap-0.5">
                      <Button
                        aria-current={active ? "page" : undefined}
                        onPress={() => {
                          useScene.getState().setCurrentPage(p.id);
                          setOpen(false);
                        }}
                        className={[
                          "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none",
                          "data-[focus-visible]:shadow-[var(--ring)]",
                          active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-surface-3",
                        ].join(" ")}
                      >
                        <Icon name="check" size={13} className={active ? "shrink-0" : "shrink-0 opacity-0"} />
                        <span className="min-w-0 flex-1 truncate">{pageLabel(p.name)}</span>
                      </Button>
                      <span className="flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/page:opacity-100">
                        <IconButton
                          icon="pen"
                          label={`Rinomina ${pageLabel(p.name)}`}
                          size={24}
                          onPress={() => {
                            setOpen(false);
                            // La rinomina vive nella barra e riguarda la corrente:
                            // ci si sposta prima sulla pagina scelta.
                            useScene.getState().setCurrentPage(p.id);
                            setRenamingId(p.id);
                          }}
                        />
                        <IconButton
                          icon="trash"
                          label={`Elimina ${pageLabel(p.name)}`}
                          size={24}
                          isDisabled={pages.length <= 1}
                          onPress={() => deletePage(p.id)}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t border-line p-1">
                <Button
                  onPress={createPage}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted outline-none hover:bg-surface-3 hover:text-fg data-[focus-visible]:shadow-[var(--ring)]"
                >
                  <Icon name="plus" size={13} />
                  Aggiungi una pagina
                </Button>
              </div>
            </Dialog>
          </Popover>
        </DialogTrigger>
      )}
      {!compact && <IconButton icon="plus" label="Nuova pagina" onPress={createPage} />}
      {!compact && (
        <IconButton
          icon="trash"
          label="Elimina pagina"
          // L'ULTIMA pagina non si cancella (ErrLastPage nel core): il pulsante è
          // disabilitato invece di mandare un op che si sa rifiutato.
          isDisabled={pages.length <= 1}
          onPress={() => deletePage(currentPageId)}
        />
      )}
    </div>
  );
}
