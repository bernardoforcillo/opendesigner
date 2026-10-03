import { useState } from "react";
import { Dialog, DialogTrigger, Label, Popover, Radio, RadioGroup } from "react-aria-components";
import { useScene } from "../store/store";
import { runExport, type ExportFormat, type ExportRequest } from "../export/exportScene";
import { EXPORT_SCALES, type ExportScale } from "../export/png";
import type { ExportScope } from "../export/region";
import { Button } from "./ds";
import { SEGMENT, SEGMENTED_TRACK } from "./ds/flow-parts";

// IL PULSANTE DI EXPORT.
//
// Tre scelte e nient'altro: formato, ambito, scala. Sono le sole domande a cui
// l'utente deve rispondere -- il resto (regione, dimensione dell'immagine,
// nome del file) si deduce da ciò che sta nel documento, e chiederlo sarebbe
// chiedere all'utente di fare un conto che sappiamo fare noi.
//
// `onExport` è iniettabile per i test: il download vero apre un'ancora e
// scarica un file, cosa che in jsdom non ha senso -- ma la scelta dei tre
// valori e il loro viaggio fino al comando sì.

const FORMATS: readonly { value: ExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
];

const SCOPES: readonly { value: ExportScope; label: string }[] = [
  { value: "selection", label: "Selezione" },
  { value: "page", label: "Pagina" },
];

// Ogni scelta è un controllo SEGMENTATO (una traccia incassata, il segmento scelto
// "sollevato"): sono comunque dei Radio veri di react-aria, con la tastiera e i
// ruoli di sempre.
const ROW_CLASS = "flex items-center gap-2";
const ROW_LABEL_CLASS = "w-12 shrink-0 select-none text-[11px] font-medium text-fg-subtle";

export function ExportButton({
  onExport = runExport,
}: {
  onExport?: (req: ExportRequest) => Promise<boolean> | void;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [scope, setScope] = useState<ExportScope>("page");
  const [scale, setScale] = useState<ExportScale>(1);
  const hasSelection = useScene((s) => s.selection.length > 0);

  // Senza selezione l'ambito è la pagina, punto: il radio "Selezione" resta
  // visibile ma disabilitato (sparire e ricomparire farebbe saltare il
  // pannello), e lo stato non può restare fermo su un ambito che non esiste
  // più -- la selezione può svuotarsi mentre il pannello è aperto.
  const effectiveScope: ExportScope = hasSelection ? scope : "page";

  function onOpenChange(next: boolean) {
    // All'apertura, se c'è una selezione è quasi sempre quella che si vuole
    // esportare: è la convenzione di ogni editor di design.
    if (next) setScope(hasSelection ? "selection" : "page");
    setOpen(next);
  }

  function submit() {
    // Si chiude SUBITO, senza aspettare il download: il file lo consegna il
    // browser e l'attesa non è nostra. Tenere aperto il pannello finché la
    // promise non si risolve darebbe un'interfaccia bloccata per un'operazione
    // che non fallisce quasi mai -- e quando fallisce lo dice il banner.
    setOpen(false);
    void onExport({ format, scope: effectiveScope, scale });
  }

  return (
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button variant="secondary" icon="download">Esporta</Button>
      <Popover offset={8} placement="bottom end" className="w-[268px] rounded-xl bg-raised p-3 text-fg shadow-pop">
        <Dialog aria-label="Esporta" className="flex flex-col gap-2.5 text-[13px] outline-none">
          <RadioGroup
            value={format}
            onChange={(v) => setFormat(v as ExportFormat)}
            orientation="horizontal"
            className={ROW_CLASS}
          >
            <Label className={ROW_LABEL_CLASS}>Formato</Label>
            <div className={SEGMENTED_TRACK}>
              {FORMATS.map((f) => (
                <Radio key={f.value} value={f.value} className={SEGMENT}>{f.label}</Radio>
              ))}
            </div>
          </RadioGroup>

          <RadioGroup
            value={effectiveScope}
            onChange={(v) => setScope(v as ExportScope)}
            orientation="horizontal"
            className={ROW_CLASS}
          >
            <Label className={ROW_LABEL_CLASS}>Ambito</Label>
            <div className={SEGMENTED_TRACK}>
              {SCOPES.map((s) => (
                <Radio
                  key={s.value}
                  value={s.value}
                  isDisabled={s.value === "selection" && !hasSelection}
                  className={SEGMENT}
                >
                  {s.label}
                </Radio>
              ))}
            </div>
          </RadioGroup>

          {/* La scala è una proprietà dei PIXEL: un SVG è vettoriale e
              "esportarlo a 2x" non vuol dire niente. Il controllo non compare
              affatto invece di comparire disabilitato -- non è una scelta
              momentaneamente impossibile, è una scelta che non esiste. */}
          {format === "png" && (
            <RadioGroup
              value={String(scale)}
              onChange={(v) => setScale(Number(v) as ExportScale)}
              orientation="horizontal"
              className={ROW_CLASS}
            >
              <Label className={ROW_LABEL_CLASS}>Scala</Label>
              <div className={SEGMENTED_TRACK}>
                {EXPORT_SCALES.map((s) => (
                  <Radio key={s} value={String(s)} className={SEGMENT}>{`${s}x`}</Radio>
                ))}
              </div>
            </RadioGroup>
          )}

          <Button variant="primary" icon="download" onPress={submit} className="mt-0.5 h-8 w-full">
            Scarica
          </Button>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
