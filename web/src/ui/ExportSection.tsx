import { useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { runExport, type ExportFormat, type ExportRequest } from "../export/exportScene";
import { EXPORT_SCALES, type ExportScale } from "../export/png";
import { Button } from "./ds";
import { SEGMENT, SEGMENTED_TRACK } from "./ds/flow-parts";

// LA SEZIONE EXPORT nel pannello proprietà.
//
// Vive solo dentro PropertiesPanel, che la monta già SOLO quando c'è una
// selezione (lo stesso ramo che regge `summary`): non serve quindi un
// controllo di "ambito" -- qui si esporta sempre la selezione, è la premessa
// sotto cui questo componente esiste.
//
// Due scelte sole: formato e scala. `onExport` è iniettabile per i test, come
// nel vecchio ExportButton.

const FORMATS: readonly { value: ExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
];

const ROW_CLASS = "flex items-center gap-2";
const ROW_LABEL_CLASS = "w-12 shrink-0 select-none text-[11px] font-medium text-fg-subtle";

export function ExportSection({
  onExport = runExport,
}: {
  onExport?: (req: ExportRequest) => Promise<boolean> | void;
}) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const [scale, setScale] = useState<ExportScale>(1);

  function submit() {
    void onExport({ format, scope: "selection", scale });
  }

  return (
    <div className="flex flex-col gap-2.5">
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

      {/* La scala è una proprietà dei PIXEL: un SVG è vettoriale, vedi il
          commento equivalente nel vecchio ExportButton. */}
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

      <Button variant="primary" icon="download" onPress={submit} className="h-8 w-full">
        Scarica
      </Button>
    </div>
  );
}
