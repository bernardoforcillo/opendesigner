import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { insertDiagram } from "../diagram/insert";
import { BOARD_OBJECTS, BoardError, renderBoard, STICKY_COLORS, type BoardKind } from "../board/board";
import { viewportCenter } from "../tools/svgImport";
import { cls } from "./ds";

// WHITEBOARD OBJECTS (document menu → Whiteboard…): a sticky note, a table, a kanban board, a
// mind map, or a starting template, dropped at the center of the view as a group of plain
// shapes and text -- editable, restylable, one undo step.

export function BoardDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [color, setColor] = useState<(typeof STICKY_COLORS)[number]>("yellow");
  const [rows, setRows] = useState(4);
  const [columns, setColumns] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (kind: BoardKind) => {
    setBusy(true);
    setError(null);
    try {
      const res = await renderBoard({ kind, color, rows: kind === "table" ? rows : 0, columns: kind === "table" ? columns : 0 });
      if (insertDiagram(res, viewportCenter()) === null) {
        setError("cannot insert it (no document is open, or another edit is in progress)");
        return;
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof BoardError ? e.message : "could not draw it");
    } finally {
      setBusy(false);
    }
  };

  const group = (g: "Objects" | "Templates") => (
    <section aria-label={g} className="flex flex-col gap-1.5">
      <h3 className={cls.sectionTitle}>{g}</h3>
      <div className="grid grid-cols-2 gap-1.5">
        {BOARD_OBJECTS.filter((o) => o.group === g).map((o) => (
          <button
            key={o.kind}
            type="button"
            disabled={busy}
            onClick={() => void add(o.kind)}
            className="flex flex-col items-start gap-0.5 rounded-lg border border-line px-3 py-2 text-left outline-none hover:bg-surface-3 focus-visible:shadow-[var(--ring)] disabled:opacity-50"
          >
            <span className="font-medium">{o.label}</span>
            <span className="text-[11px] text-fg-subtle">{o.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[520px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Whiteboard" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Whiteboard</h2>
          <p className="text-fg-subtle">Drop a ready-made object or template on the canvas. Everything is plain shapes and text: change it as you like.</p>
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <span className="flex items-center gap-1.5" role="group" aria-label="Sticky color">
              {STICKY_COLORS.map((c) => (
                <button
                  key={c} type="button" aria-label={`Sticky color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)}
                  className={`size-5 rounded-full border ${color === c ? "border-fg ring-2 ring-accent" : "border-line"}`}
                  style={{ background: STICKY_CSS[c] }}
                />
              ))}
            </span>
            <label className="flex items-center gap-1">Rows
              <input aria-label="Table rows" type="number" min={1} max={30} value={rows} onChange={(e) => setRows(Number(e.target.value) || 1)} className={`${cls.input} h-7 w-14`} />
            </label>
            <label className="flex items-center gap-1">Columns
              <input aria-label="Table columns" type="number" min={1} max={30} value={columns} onChange={(e) => setColumns(Number(e.target.value) || 1)} className={`${cls.input} h-7 w-14`} />
            </label>
          </div>
          {group("Objects")}
          {group("Templates")}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end">
            <button type="button" className="h-8 rounded-md px-3 hover:bg-surface-3" onClick={() => onOpenChange(false)}>Close</button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const STICKY_CSS: Record<(typeof STICKY_COLORS)[number], string> = {
  yellow: "#ffeb73", pink: "#ffbdd1", green: "#b3eda6", blue: "#a8d6ff", orange: "#ffc780", purple: "#d1bdff",
};
