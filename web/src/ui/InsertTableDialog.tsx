import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { MAX_TABLE_SIDE, createTableOps } from "@/tools/tableOps";
import { viewportCenter } from "@/tools/svgImport";
import { Button } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";

// INSERT TABLE (document menu): rows x columns of equal cells on the page on screen, at the centre of the
// view, with the first rows as a header. A table is a group of rectangles and texts (tools/tableOps.ts); its
// rows and columns are edited from the properties panel while it is selected.

export function InsertTableDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useT();
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(3);
  const [head, setHead] = useState(1);
  const [cellW, setCellW] = useState(120);
  const [cellH, setCellH] = useState(36);

  function insert() {
    const st = useScene.getState();
    const scene = st.scene;
    const pageId = st.currentPageId ?? scene?.pages[0]?.id;
    if (!scene || !pageId) return;
    const c = viewportCenter();
    const made = createTableOps(scene, pageId, Math.round(c.x - (cols * cellW) / 2), Math.round(c.y - (rows * cellH) / 2), rows, cols, cellW, cellH, head);
    if (!made) return;
    st.beginGesture();
    st.endGesture(made.ops);
    st.setSelection(made.selection);
    onOpenChange(false);
  }
  const valid = Number.isInteger(rows) && Number.isInteger(cols) && rows >= 1 && cols >= 1 && rows <= MAX_TABLE_SIDE && cols <= MAX_TABLE_SIDE;

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="w-full max-w-[380px] rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Insert table")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Insert table")}</h2>
          <div className="grid grid-cols-3 gap-2">
            <NumberField label={t("Rows")} minValue={1} value={rows} onCommit={(v) => setRows(Math.round(v))} />
            <NumberField label={t("Columns")} minValue={1} value={cols} onCommit={(v) => setCols(Math.round(v))} />
            <NumberField label={t("Header rows")} minValue={0} value={head} onCommit={(v) => setHead(Math.round(v))} />
            <NumberField label={t("Cell width")} minValue={8} value={cellW} onCommit={setCellW} />
            <NumberField label={t("Cell height")} minValue={8} value={cellH} onCommit={setCellH} />
          </div>
          {!valid && <p role="alert" className="text-danger">{t("A table has 1 to {n} rows and columns.", { n: MAX_TABLE_SIDE })}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="primary" isDisabled={!valid} onPress={insert}>{t("Insert")}</Button>
            <Button onPress={() => onOpenChange(false)}>{t("Cancel")}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
