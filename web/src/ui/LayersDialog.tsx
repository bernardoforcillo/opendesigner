import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { createLayerOps, deleteLayerOps, moveToLayerOps, updateLayerOps } from "@/tools/layers";
import { Button, cls } from "@/ui/ds";

// LAYERS (document menu): layers shared by all pages. Put objects on a layer, then hide or lock it — on every page at
// once — or keep it out of the print. Objects on no layer are unaffected. See docs/graphics-colour.md.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function LayersDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, tx } = useT();
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || !isOpen) return null;
  const count = (id: string) => (isOpen ? [...scene.nodes.values()].filter((n) => n.layerId === id).length : 0);
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[560px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Layers")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Layers")}</h2>
          <p className="text-fg-subtle">{t("Layers are shared by all pages. Hide or lock one and everything on it follows, on every page.")}</p>
          {scene.layers.length === 0 && <p className="text-fg-subtle">{t("No layers yet.")}</p>}
          <ul aria-label={t("Layers")} className="flex flex-col gap-1.5">
            {scene.layers.map((l) => (
              <li key={l.id} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md border border-line p-1.5">
                <div className="flex min-w-0 flex-col gap-1">
                  <input aria-label={t("Name of {name}", { name: l.name })} className={cls.input} defaultValue={l.name} key={l.id + l.name} maxLength={80}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== l.name) run(updateLayerOps(scene, l.id, { name: v })); }} />
                  <div className="flex flex-wrap items-center gap-3 text-[12px]">
                    {([["Hidden", "hidden"], ["Locked", "locked"], ["Don't print", "noPrint"]] as const).map(([label, key]) => (
                      <label key={key} className="flex items-center gap-1">
                        <input type="checkbox" aria-label={t("{label}: {name}", { label: tx(label), name: l.name })} checked={l[key] === true} onChange={(e) => run(updateLayerOps(scene, l.id, { [key]: e.target.checked }))} /> {tx(label)}
                      </label>
                    ))}
                    <span className="text-fg-subtle">{tn("{n} objects", count(l.id))}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Button isDisabled={selection.length === 0} onPress={() => run(moveToLayerOps(scene, selection, l.id))}>{t("Move selection here")}</Button>
                  <Button variant="danger" onPress={() => run(deleteLayerOps(scene, l.id))}>{t("Delete")}</Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-between">
            <Button onPress={() => { const made = createLayerOps(scene); if (made) run(made.ops); }}>{t("New layer")}</Button>
            <Button onPress={() => onOpenChange(false)}>{t("Done")}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
