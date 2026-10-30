import { useState } from "react";
import { useCmykConverter } from "@/color/useCmykConverter";
import { useT } from "@/i18n";
import type { RgbLite } from "@/shared/components/molecules/ColorField";
import { NumberField } from "@/shared/components/atoms/NumberField";

/**
 * CMYK read-out and entry for a color, under its hex field. Opens on demand. The conversion goes through the
 * document's ICC output profile when it has a readable one (color/activeProfile.ts), else it is the plain one
 * (color/cmyk.ts): either way it is for reading a color in print terms, not a soft proof.
 */
export function CmykField({ value, onCommit }: { value: RgbLite | null; onCommit: (rgb: RgbLite) => void }) {
  const [open, setOpen] = useState(false);
  const conv = useCmykConverter();
  const { t } = useT();
  const cmyk = value ? conv.rgbToCmyk(value) : null;
  const set = (key: "c" | "m" | "y" | "k") => (v: number) => {
    if (!cmyk) return;
    onCommit(conv.cmykToRgb({ ...cmyk, [key]: Math.min(100, Math.max(0, v)) }));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" aria-expanded={open} className="self-start rounded px-1.5 py-0.5 text-[11px] text-fg-subtle hover:bg-surface-hover" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide CMYK" : "CMYK"}
      </button>
      {open && (
        <div role="group" aria-label="CMYK" className="grid grid-cols-4 gap-1.5">
          {(["c", "m", "y", "k"] as const).map((key) => (
            <NumberField key={key} label={key.toUpperCase()} suffix="%" minValue={0} value={cmyk ? cmyk[key] : NaN} onCommit={set(key)} />
          ))}
        </div>
      )}
      {open && <p className="text-[11px] leading-snug text-fg-subtle">{conv.managed ? t("Converted from RGB through the document's ICC profile; the document stays RGB.") : t("Plain conversion from RGB; the document stays RGB. Load an ICC profile in Swatches to apply your printer's.")}</p>}
    </div>
  );
}
