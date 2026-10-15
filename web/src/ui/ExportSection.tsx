import { useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { runExport, type ExportFormat, type ExportRequest } from "../export/exportScene";
import { EXPORT_SCALES, type ExportScale } from "../export/png";
import { Button } from "./ds";
import { SEGMENT, SEGMENTED_TRACK } from "./ds/flow-parts";

// THE EXPORT SECTION in the properties panel.
//
// It lives only inside PropertiesPanel, which already mounts it ONLY when there is a
// selection (the same branch that carries `summary`): so no
// "scope" control is needed -- here the selection is always exported, it is the premise
// under which this component exists.
//
// Only two choices: format and scale. `onExport` is injectable for tests, as
// in the old ExportButton.

const FORMATS: readonly { value: ExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "svg", label: "SVG" },
  { value: "pdf", label: "PDF" },
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
        <Label className={ROW_LABEL_CLASS}>Format</Label>
        <div className={SEGMENTED_TRACK}>
          {FORMATS.map((f) => (
            <Radio key={f.value} value={f.value} className={SEGMENT}>{f.label}</Radio>
          ))}
        </div>
      </RadioGroup>

      {/* Scale is a property of PIXELS: an SVG is vectorial, see the
          equivalent comment in the old ExportButton. */}
      {format === "png" && (
        <RadioGroup
          value={String(scale)}
          onChange={(v) => setScale(Number(v) as ExportScale)}
          orientation="horizontal"
          className={ROW_CLASS}
        >
          <Label className={ROW_LABEL_CLASS}>Scale</Label>
          <div className={SEGMENTED_TRACK}>
            {EXPORT_SCALES.map((s) => (
              <Radio key={s} value={String(s)} className={SEGMENT}>{`${s}x`}</Radio>
            ))}
          </div>
        </RadioGroup>
      )}

      <Button variant="primary" icon="download" onPress={submit} className="h-8 w-full">
        {format === "pdf" ? "Print / Save as PDF" : "Download"}
      </Button>
    </div>
  );
}
