import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { convertSpotsOps, inkReport, mergeSpotsOps, overprintOps, type OverprintMode } from "@/tools/inks";
import { platesOf, separationView, trapSuggestions } from "@/tools/printPreview";
import { Button, cls } from "@/ui/ds";

// INK MANAGER (document menu): the process and spot inks of the document, spot -> process conversion, ink aliases, and overprint for the
// selection. Overprint is written to the PDF; the screen does not simulate it.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

function Form() {
  const { t, tn, tx } = useT();
  const scene = useScene((s) => s.scene)!;
  const selection = useScene((s) => s.selection);
  const [status, setStatus] = useState("");
  const [alias, setAlias] = useState<Record<string, string>>({});
  const report = inkReport(scene);
  const plates = platesOf(scene).map((p) => ({ name: p, objects: separationView(scene, p).size }));
  const traps = trapSuggestions(scene);
  const act = (ops: Ops | string, done: string) => { if (typeof ops === "string") setStatus(ops); else { run(ops); setStatus(done); } };
  return (
    <Dialog aria-label={t("Ink manager")} className="flex flex-col gap-3 outline-none">
      <h2 className="text-[14px] font-semibold">{t("Ink manager")}</h2>
      <p role="status" aria-label={t("Status")} className="min-h-[1.25rem] text-fg-subtle">{status}</p>

      <section aria-label={t("Process inks")} className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold">{t("Process inks")}</h3>
        <p>{t("{swatches}, {objects} painted with them.", { swatches: tn("{n} CMYK swatches", report.process.swatches), objects: tn("{n} objects", report.process.objects) })}</p>
        {report.overLimit.length > 0 && <p role="alert" className="text-danger">{t("Over 300% total ink: {list}.", { list: report.overLimit.map((o) => `${o.swatch} (${o.total}%)`).join(", ") })}</p>}
      </section>

      <section aria-label={t("Spot inks")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Spot inks")}</h3>
        {report.spots.length === 0 && <p className="text-fg-subtle">{t("None. A swatch with a spot name prints on its own plate.")}</p>}
        {report.spots.map((s) => (
          <div key={s.name} className="flex items-center gap-2 rounded-md border border-line p-1.5">
            <span className="flex-1">{s.name} <span className="text-fg-subtle">· {tn("{n} swatches", s.swatches.length)}, {tn("{n} objects", s.objects)}</span></span>
            <Button aria-label={t("Convert {name} to process", { name: s.name })} onPress={() => act(convertSpotsOps(scene, [s.name]), t("{name} now prints as process colour.", { name: s.name }))}>{t("To process")}</Button>
            <select aria-label={t("Alias {name} to", { name: s.name })} className={cls.select} value={alias[s.name] ?? ""} onChange={(e) => setAlias({ ...alias, [s.name]: e.target.value })}>
              <option value="">{t("Alias to…")}</option>
              {report.spots.filter((o) => o.name !== s.name).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select>
            <Button aria-label={t("Apply alias for {name}", { name: s.name })} isDisabled={!alias[s.name]} onPress={() => act(mergeSpotsOps(scene, s.name, alias[s.name]!), t("{name} now prints as {other}.", { name: s.name, other: alias[s.name]! }))}>{t("Alias")}</Button>
          </div>
        ))}
        {report.spots.length > 1 && <div><Button onPress={() => act(convertSpotsOps(scene), t("All spot inks converted to process."))}>{t("Convert all to process")}</Button></div>}
      </section>

      <section aria-label={t("Separations")} className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold">{t("Separations")}</h3>
        {plates.length === 0 && <p className="text-fg-subtle">{t("Nothing is painted yet.")}</p>}
        {plates.map((p) => <p key={p.name}>{p.name} <span className="text-fg-subtle">· {tn("{n} objects on this plate", p.objects)}</span></p>)}
      </section>

      <section aria-label={t("Trapping")} className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold">{t("Trapping")}</h3>
        {traps.length === 0
          ? <p className="text-fg-subtle">{t("No touching shapes need a trap.")}</p>
          : <p role="alert">{tn("{n} edges could show a white gap if the plates misregister:", traps.length)} {traps.slice(0, 5).map((tr) => `${scene.nodes.get(tr.spread)?.name ?? tr.spread} ${tr.kind === "centered" ? "/" : t("into")} ${scene.nodes.get(tr.under)?.name ?? tr.under}`).join(", ")}{traps.length > 5 ? "…" : ""}. {t("Advice only; nothing is changed.")}</p>}
      </section>

      <section aria-label={t("Overprint")} className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">{t("Overprint")}</h3>
        <p className="text-fg-subtle">{tn("{n} objects overprint. Written to the PDF; not shown on screen.", report.overprint)}</p>
        <div className="flex flex-wrap gap-2">
          {(["fill", "stroke", "both", "off"] as OverprintMode[]).map((m) => (
            <Button key={m} isDisabled={selection.length === 0} onPress={() => act(overprintOps(scene, selection, m), m === "off" ? t("Overprint cleared.") : t("Overprint {mode} set.", { mode: tx(m) }))}>{m === "off" ? t("Clear overprint") : t("Overprint {mode}", { mode: tx(m) })}</Button>
          ))}
        </div>
      </section>
    </Dialog>
  );
}

export function InkManagerDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  if (!scene || !isOpen) return null;
  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[90vh] w-full max-w-[560px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <div className="flex flex-col gap-3">
          <Form />
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </div>
      </Modal>
    </ModalOverlay>
  );
}
