import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { convertSpotsOps, inkReport, mergeSpotsOps, overprintOps, type OverprintMode } from "@/tools/inks";
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
  const scene = useScene((s) => s.scene)!;
  const selection = useScene((s) => s.selection);
  const [status, setStatus] = useState("");
  const [alias, setAlias] = useState<Record<string, string>>({});
  const report = inkReport(scene);
  const act = (ops: Ops | string, done: string) => { if (typeof ops === "string") setStatus(ops); else { run(ops); setStatus(done); } };
  return (
    <Dialog aria-label="Ink manager" className="flex flex-col gap-3 outline-none">
      <h2 className="text-[14px] font-semibold">Ink manager</h2>
      <p role="status" aria-label="Status" className="min-h-[1.25rem] text-fg-subtle">{status}</p>

      <section aria-label="Process inks" className="flex flex-col gap-1">
        <h3 className="text-[12px] font-semibold">Process inks</h3>
        <p>{report.process.swatches} CMYK swatch{report.process.swatches === 1 ? "" : "es"}, {report.process.objects} object{report.process.objects === 1 ? "" : "s"} painted with them.</p>
        {report.overLimit.length > 0 && <p role="alert" className="text-danger">Over 300% total ink: {report.overLimit.map((o) => `${o.swatch} (${o.total}%)`).join(", ")}.</p>}
      </section>

      <section aria-label="Spot inks" className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">Spot inks</h3>
        {report.spots.length === 0 && <p className="text-fg-subtle">None. A swatch with a spot name prints on its own plate.</p>}
        {report.spots.map((s) => (
          <div key={s.name} className="flex items-center gap-2 rounded-md border border-line p-1.5">
            <span className="flex-1">{s.name} <span className="text-fg-subtle">· {s.swatches.length} swatch{s.swatches.length === 1 ? "" : "es"}, {s.objects} object{s.objects === 1 ? "" : "s"}</span></span>
            <Button aria-label={`Convert ${s.name} to process`} onPress={() => act(convertSpotsOps(scene, [s.name]), `${s.name} now prints as process colour.`)}>To process</Button>
            <select aria-label={`Alias ${s.name} to`} className={cls.select} value={alias[s.name] ?? ""} onChange={(e) => setAlias({ ...alias, [s.name]: e.target.value })}>
              <option value="">Alias to…</option>
              {report.spots.filter((o) => o.name !== s.name).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select>
            <Button aria-label={`Apply alias for ${s.name}`} isDisabled={!alias[s.name]} onPress={() => act(mergeSpotsOps(scene, s.name, alias[s.name]!), `${s.name} now prints as ${alias[s.name]}.`)}>Alias</Button>
          </div>
        ))}
        {report.spots.length > 1 && <div><Button onPress={() => act(convertSpotsOps(scene), "All spot inks converted to process.")}>Convert all to process</Button></div>}
      </section>

      <section aria-label="Overprint" className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold">Overprint</h3>
        <p className="text-fg-subtle">{report.overprint} object{report.overprint === 1 ? "" : "s"} overprint. Written to the PDF; not shown on screen.</p>
        <div className="flex flex-wrap gap-2">
          {(["fill", "stroke", "both", "off"] as OverprintMode[]).map((m) => (
            <Button key={m} isDisabled={selection.length === 0} onPress={() => act(overprintOps(scene, selection, m), m === "off" ? "Overprint cleared." : `Overprint ${m} set.`)}>{m === "off" ? "Clear overprint" : `Overprint ${m}`}</Button>
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
