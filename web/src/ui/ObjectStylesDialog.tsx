import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { OBJECT_STYLE_PROPS, type ObjectStyleProp } from "@/store/types";
import { applyObjectStyleOps, createObjectStyleOps, deleteObjectStyleOps, redefineObjectStyleOps, updateObjectStyleOps, stylable } from "@/tools/objectStyles";
import { Button, cls } from "@/ui/ds";

// OBJECT STYLES (document menu): shared looks for shapes. A style sets some of fill, stroke, effects, opacity, corner
// radius and blend mode; everything that applies it takes those, and redefining the style updates them all. The
// node's own values stay under it, so detaching gives them back. See docs/graphics-colour.md.

const LABELS: Record<ObjectStyleProp, string> = {
  fills: "Fill", strokes: "Stroke", effects: "Effects", opacity: "Opacity", corner_radius: "Corner radius", blend_mode: "Blend mode",
};

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

export function ObjectStylesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, tx } = useT();
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const [selected, setSelected] = useState<string | null>(null);
  if (!scene || !isOpen) return null;
  const styles = isOpen ? Object.values(scene.objectStyles).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const cur = styles.find((d) => d.id === selected) ?? null;
  const first = selection.find((id) => stylable(scene.nodes.get(id)));
  const users = cur ? [...scene.nodes.values()].filter((n) => n.objectStyleId === cur.id).length : 0;

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[620px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Object styles")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Object styles")}</h2>
          <p className="text-fg-subtle">{t("Make a style from the look of the selected shape, apply it to others, and change it once for all of them.")}</p>
          <div className="grid grid-cols-[200px_1fr] gap-3">
            <div className="flex flex-col gap-2">
              <ul aria-label={t("Object styles")} className="flex max-h-[260px] flex-col gap-px overflow-auto">
                {styles.map((d) => (
                  <li key={d.id}>
                    <button type="button" aria-current={d.id === selected ? "true" : undefined}
                      className={"w-full truncate rounded-md px-2 py-1 text-left " + (d.id === selected ? "bg-accent-soft text-accent" : "hover:bg-surface-3")}
                      onClick={() => setSelected(d.id)}>{d.name}</button>
                  </li>
                ))}
              </ul>
              <Button isDisabled={!first} onPress={() => {
                const made = first && createObjectStyleOps(scene, first, `Object style ${styles.length + 1}`);
                if (made) { run(made.ops); setSelected(made.id); }
              }}>{t("New from selection")}</Button>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              {!cur ? <p className="text-fg-subtle">{t("Select a style, or make one from a shape.")}</p> : (
                <>
                  <input aria-label={t("Object style name")} className={cls.input} defaultValue={cur.name} key={cur.id + ":name"} maxLength={80}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== cur.name) run(updateObjectStyleOps(scene, cur.id, { name: v })); }} />
                  <span className={cls.label}>{t("It sets")}</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {OBJECT_STYLE_PROPS.map((p) => (
                      <label key={p} className="flex items-center gap-1.5">
                        <input type="checkbox" aria-label={tx(LABELS[p])} checked={cur.sets.includes(p)}
                          onChange={(e) => run(updateObjectStyleOps(scene, cur.id, { sets: OBJECT_STYLE_PROPS.filter((q) => (q === p ? e.target.checked : cur.sets.includes(q))) }))} /> {tx(LABELS[p])}
                      </label>
                    ))}
                  </div>
                  <select aria-label={t("Based on")} className={cls.select} value={cur.basedOn ?? ""} onChange={(e) => run(updateObjectStyleOps(scene, cur.id, { basedOn: e.target.value }))}>
                    <option value="">{t("Not based on another style")}</option>
                    {styles.filter((d) => d.id !== cur.id).map((d) => <option key={d.id} value={d.id}>{t("Based on {name}", { name: d.name })}</option>)}
                  </select>
                  <p className="text-fg-subtle">{users === 0 ? t("Not used yet.") : tn("Used by {n} objects", users)}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button isDisabled={selection.length === 0} onPress={() => run(applyObjectStyleOps(scene, selection, cur.id))}>{t("Apply to selection")}</Button>
                    <Button isDisabled={!first} onPress={() => { if (first) run(redefineObjectStyleOps(scene, cur.id, first)); }}>{t("Redefine from selection")}</Button>
                    <Button variant="danger" onPress={() => { run(deleteObjectStyleOps(scene, cur.id)); setSelected(null); }}>{t("Delete")}</Button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>{t("Done")}</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
