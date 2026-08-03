import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { useScene } from "../store/store";
import { makeCreatePageOp, makeDeletePageOp, makeRenamePageOp, uuid } from "../tools/ops";
import type { Op } from "../gen/brawt/v1/brawt_pb";

// SELETTORE DI PAGINA (traccia annidamento, parte client). Il canvas mostra UNA
// pagina alla volta (canvasRenderer.ts::rootsOf legge currentPageId); questa
// barra è dove la si sceglie, si aggiungono/eliminano pagine e si rinominano.
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
      className="w-28 min-w-0 select-text rounded border border-sky-500 bg-white px-2 py-0.5 text-sm outline-none"
    />
  );
}

export function PageBar() {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  // La pagina il cui nome è in rinomina, o null. Una sola alla volta.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Senza documento non c'è nessuna pagina da mostrare: la barra sparisce del
  // tutto invece di disegnarsi vuota (stesso ripiego di LayersPanel a scene
  // nulla).
  if (!scene) return null;
  const pages = scene.pages;

  function createPage() {
    // id noto PRIMA del submit: ci si sposta sopra subito, senza aspettare
    // l'eco (l'op è già stato applicato in ottimistico da endGesture).
    const id = uuid();
    submit(makeCreatePageOp(id, `Page ${pages.length + 1}`));
    useScene.getState().setCurrentPage(id);
  }

  // La cascata, il rifiuto dell'ultima pagina ecc. sono del core: qui si evita
  // solo di MANDARE un op che si sa già rifiutato (l'ultima pagina non si
  // cancella), che è anche perché il pulsante è disabilitato sotto.
  function deleteCurrent() {
    if (pages.length <= 1 || currentPageId === null) return;
    submit(makeDeletePageOp(currentPageId));
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
      className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-2 py-1"
    >
      {pages.map((p) =>
        renamingId === p.id ? (
          <PageRenameField
            key={p.id}
            initial={p.name}
            placeholder={p.name || "Pagina"}
            onCommit={(value) => commitRename(p.id, value)}
            onCancel={() => setRenamingId(null)}
          />
        ) : (
          // Il doppio click sta sul WRAPPER e non sul Button: react-aria-
          // components non inoltra onDoubleClick al <button>, ma l'evento vi
          // risale comunque (bubbling). Il click singolo resta il onPress del
          // Button (cambia pagina); il doppio apre la rinomina.
          <div key={p.id} onDoubleClick={() => setRenamingId(p.id)} className="shrink-0">
            <Button
              aria-current={p.id === currentPageId ? "page" : undefined}
              onPress={() => useScene.getState().setCurrentPage(p.id)}
              className={[
                "rounded px-3 py-1 text-sm outline-none",
                "data-[focus-visible]:ring-1 data-[focus-visible]:ring-sky-500",
                p.id === currentPageId
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-600 hover:bg-neutral-200",
              ].join(" ")}
            >
              {p.name.trim() !== "" ? p.name : "Pagina senza nome"}
            </Button>
          </div>
        ),
      )}
      <Button
        aria-label="Nuova pagina"
        onPress={createPage}
        className="shrink-0 rounded px-2 py-1 text-sm text-neutral-600 outline-none hover:bg-neutral-200 data-[focus-visible]:ring-1 data-[focus-visible]:ring-sky-500"
      >
        +
      </Button>
      <Button
        aria-label="Elimina pagina"
        // L'ULTIMA pagina non si cancella (ErrLastPage nel core): il pulsante è
        // disabilitato invece di mandare un op che si sa rifiutato.
        isDisabled={pages.length <= 1}
        onPress={deleteCurrent}
        className="shrink-0 rounded px-2 py-1 text-sm text-neutral-600 outline-none hover:bg-neutral-200 data-[disabled]:opacity-40 data-[focus-visible]:ring-1 data-[focus-visible]:ring-sky-500"
      >
        Elimina
      </Button>
    </div>
  );
}
