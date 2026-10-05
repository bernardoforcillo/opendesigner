import { useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { DiagramError, insertDiagram, renderDiagram, selectedDiagram } from "../diagram/insert";
import { viewportCenter } from "../tools/svgImport";

// CREATE (OR EDIT) A DIAGRAM: you write or paste Mermaid text -- a
// flowchart or a UML diagram (classes, sequence, states) -- and the canvas
// draws it at the center of the view as a group of normal shapes: editable,
// exportable, a single undo step. With a diagram selected the dialog
// opens on its text and "Update" redraws it in its place.

const EXAMPLES: { label: string; source: string }[] = [
  {
    label: "Flowchart",
    source: `flowchart TD
  A[Start] --> B{Registered user?}
  B -->|yes| C[Log in]
  B -->|no| D[Sign up]
  D --> C
  C --> E([End])`,
  },
  {
    label: "UML classes",
    source: `classDiagram
  class Animal {
    <<abstract>>
    +String name
    +eat() void
  }
  class Duck {
    +swim()
  }
  Animal <|-- Duck
  Owner "1" --> "*" Animal : owns`,
  },
  {
    label: "UML sequence",
    source: `sequenceDiagram
  autonumber
  actor U as User
  participant A as App
  participant S as Server
  U->>A: Log in
  A->>+S: POST /login
  S-->>-A: token
  alt valid credentials
    A-->>U: Welcome
  else error
    A-->>U: Try again
  end`,
  },
  {
    label: "UML states",
    source: `stateDiagram-v2
  [*] --> Draft
  Draft --> InReview : submit
  InReview --> Draft : reject
  InReview --> Published : approve
  Published --> [*]`,
  },
];

export function DiagramDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // On open: if a diagram is selected we start from its text.
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
        setError("cannot insert the diagram (no document is open, or another edit is in progress)");
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof DiagramError ? err.message : "the diagram is not readable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="w-full max-w-[560px] rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={editId ? "Edit diagram" : "Create diagram"} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{editId ? "Edit diagram" : "Create diagram"}</h2>
          <p className="text-fg-subtle">
            Write or paste Mermaid text: flowcharts and UML class, sequence and state diagrams become layers of the document.
          </p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" className="h-7 rounded-md border border-line px-2.5 hover:bg-surface-3" onClick={() => { setSource(ex.source); setError(null); }}>
                {ex.label}
              </button>
            ))}
          </div>
          <textarea
            aria-label="Mermaid code"
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
            <button type="button" className="h-8 rounded-md px-3 hover:bg-surface-3" onClick={() => onOpenChange(false)}>Cancel</button>
            <button type="button" disabled={busy || source.trim() === ""} className="h-8 rounded-md bg-accent px-3 text-accent-fg disabled:opacity-50" onClick={() => void create()}>
              {editId ? "Update" : "Create"}
            </button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
