import { useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { DiagramError, insertDiagram, renderDiagram, selectedDiagram } from "../diagram/insert";
import { viewportCenter } from "../tools/svgImport";

// CREA (O MODIFICA) UN DIAGRAMMA: si scrive o si incolla testo Mermaid -- un
// flowchart oppure un diagramma UML (classi, sequenza, stati) -- e il canvas lo
// disegna al centro della vista come un gruppo di forme normali: modificabili,
// esportabili, un solo passo di undo. Con un diagramma selezionato la finestra
// si apre sul suo testo e "Aggiorna" lo ridisegna al suo posto.

const EXAMPLES: { label: string; source: string }[] = [
  {
    label: "Flowchart",
    source: `flowchart TD
  A[Inizio] --> B{Utente registrato?}
  B -->|sì| C[Accedi]
  B -->|no| D[Registrati]
  D --> C
  C --> E([Fine])`,
  },
  {
    label: "Classi UML",
    source: `classDiagram
  class Animale {
    <<abstract>>
    +String nome
    +mangia() void
  }
  class Anatra {
    +nuota()
  }
  Animale <|-- Anatra
  Proprietario "1" --> "*" Animale : possiede`,
  },
  {
    label: "Sequenza UML",
    source: `sequenceDiagram
  autonumber
  actor U as Utente
  participant A as App
  participant S as Server
  U->>A: Accedi
  A->>+S: POST /login
  S-->>-A: token
  alt credenziali valide
    A-->>U: Benvenuto
  else errore
    A-->>U: Riprova
  end`,
  },
  {
    label: "Stati UML",
    source: `stateDiagram-v2
  [*] --> Bozza
  Bozza --> InRevisione : invia
  InRevisione --> Bozza : rifiuta
  InRevisione --> Pubblicato : approva
  Pubblicato --> [*]`,
  },
];

export function DiagramDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // All'apertura: se è selezionato un diagramma si parte dal suo testo.
  useEffect(() => {
    if (!isOpen) return;
    const d = selectedDiagram();
    setEditId(d?.id ?? null);
    setSource(d?.source ?? "");
    setError(null);
  }, [isOpen]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await renderDiagram(source);
      const id = insertDiagram(res, viewportCenter(), editId ?? undefined);
      if (id === null) {
        setError("impossibile inserire il diagramma (nessun documento aperto, o un'altra modifica è in corso)");
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof DiagramError ? err.message : "il diagramma non è leggibile");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="w-full max-w-[560px] rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={editId ? "Modifica diagramma" : "Crea diagramma"} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{editId ? "Modifica diagramma" : "Crea diagramma"}</h2>
          <p className="text-fg-subtle">
            Scrivi o incolla testo Mermaid: flowchart, classi, sequenza e stati UML diventano livelli del documento.
          </p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Esempi">
            {EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" className="h-7 rounded-md border border-line px-2.5 hover:bg-surface-3" onClick={() => { setSource(ex.source); setError(null); }}>
                {ex.label}
              </button>
            ))}
          </div>
          <textarea
            aria-label="Codice Mermaid"
            value={source}
            onChange={(e) => { setSource(e.target.value); setError(null); }}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={EXAMPLES[0].source}
            spellCheck={false}
            rows={12}
            className="w-full resize-y rounded-md border border-line bg-surface p-2 font-mono text-[12px] outline-none focus:border-accent"
          />
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="h-8 rounded-md px-3 hover:bg-surface-3" onClick={() => onOpenChange(false)}>Annulla</button>
            <button type="button" disabled={busy || source.trim() === ""} className="h-8 rounded-md bg-accent px-3 text-accent-fg disabled:opacity-50" onClick={() => void create()}>
              {editId ? "Aggiorna" : "Crea"}
            </button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
