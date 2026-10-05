import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { MermaidError } from "../diagram/mermaid";
import { mermaidToSvg } from "../diagram/toSvg";
import { importSvgAt, viewportCenter } from "../tools/svgImport";

// CREA UN DIAGRAMMA: si incolla il testo Mermaid (un flowchart), il canvas lo
// disegna al centro della vista come un gruppo di forme normali -- modificabili,
// esportabili, un solo passo di undo.

const EXAMPLE = `flowchart TD
  A[Inizio] --> B{Utente registrato?}
  B -->|sì| C[Accedi]
  B -->|no| D[Registrati]
  D --> C
  C --> E([Fine])`;

export function DiagramDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    let svg: string;
    try {
      svg = mermaidToSvg(source);
    } catch (err) {
      setError(err instanceof MermaidError ? err.message : "il diagramma non è leggibile");
      return;
    }
    const id = await importSvgAt(svg, viewportCenter(), { name: "Diagramma", scale: 1 });
    if (id === null) {
      setError("impossibile inserire il diagramma (nessun documento aperto?)");
      return;
    }
    setSource("");
    setError(null);
    onOpenChange(false);
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="w-full max-w-[520px] rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Crea diagramma" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Crea diagramma</h2>
          <p className="text-fg-subtle">Incolla un flowchart in sintassi Mermaid: forme, frecce ed etichette diventano livelli del documento.</p>
          <textarea
            aria-label="Codice Mermaid"
            value={source}
            onChange={(e) => { setSource(e.target.value); setError(null); }}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={EXAMPLE}
            spellCheck={false}
            rows={10}
            className="w-full resize-y rounded-md border border-line bg-surface p-2 font-mono text-[12px] outline-none focus:border-accent"
          />
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-between gap-2">
            <button type="button" className="h-8 rounded-md px-3 hover:bg-surface-3" onClick={() => { setSource(EXAMPLE); setError(null); }}>
              Inserisci esempio
            </button>
            <div className="flex gap-2">
              <button type="button" className="h-8 rounded-md px-3 hover:bg-surface-3" onClick={() => onOpenChange(false)}>Annulla</button>
              <button type="button" disabled={source.trim() === ""} className="h-8 rounded-md bg-accent px-3 text-accent-fg disabled:opacity-50" onClick={() => void create()}>
                Crea
              </button>
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
