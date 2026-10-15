import { useState } from "react";
import { cmykToRgb, rgbToCmyk } from "../../color/cmyk";
import type { RgbLite } from "./ColorField";
import { NumberField } from "./NumberField";

/**
 * CMYK read-out and entry for a color, under its hex field. Opens on demand. The conversion is the
 * plain one (see color/cmyk.ts): it is for reading a color in print terms, not a color-managed proof.
 */
export function CmykField({ value, onCommit }: { value: RgbLite | null; onCommit: (rgb: RgbLite) => void }) {
  const [open, setOpen] = useState(false);
  const cmyk = value ? rgbToCmyk(value) : null;
  const set = (key: "c" | "m" | "y" | "k") => (v: number) => {
    if (!cmyk) return;
    onCommit(cmykToRgb({ ...cmyk, [key]: Math.min(100, Math.max(0, v)) }));
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
      {open && <p className="text-[11px] leading-snug text-fg-subtle">Plain conversion from RGB; the document stays RGB. Your printer's profile is not applied.</p>}
    </div>
  );
}
