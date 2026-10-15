import type { ReactNode } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";

// INSPECTOR PRIMITIVES ("props" area).
//
// They live here and not in ds/index.tsx because they were born for the properties panel:
// if another panel needed them they would be promoted. Like the rest of the
// design system they do not hand-write a color -- only tokens.

// --- SEGMENT ICONS ----------------------------------------------------------
//
// Small pictograms on a 16 grid, made of rectangles (like the alignment
// ones): they are colored with `currentColor`, so they follow the state and
// theme of the segment that contains them. Decorative: the name comes from the button.
type R = [x: number, y: number, w: number, h: number];

export const SEG_ICONS: Record<string, R[]> = {
  // text: three lines aligned left / center / right
  textLeft: [[2, 3, 12, 1.6], [2, 7.2, 8, 1.6], [2, 11.4, 10, 1.6]],
  textCenter: [[2, 3, 12, 1.6], [4, 7.2, 8, 1.6], [3, 11.4, 10, 1.6]],
  textRight: [[2, 3, 12, 1.6], [6, 7.2, 8, 1.6], [4, 11.4, 10, 1.6]],
  // auto layout: two blocks in a row / in a column
  dirH: [[2.4, 4, 4.6, 8], [9, 4, 4.6, 8]],
  dirV: [[4, 2.4, 8, 4.6], [4, 9, 8, 4.6]],
  // axis alignment: start / center / end / distributed (three bars on an
  // imaginary line; the line is the edge or the midline)
  alignStart: [[2, 2, 1.4, 12], [4.6, 4, 8, 3], [4.6, 9, 5, 3]],
  alignCenter: [[7.3, 2, 1.4, 12], [3, 4, 10, 3], [4.5, 9, 7, 3]],
  alignEnd: [[12.6, 2, 1.4, 12], [3.4, 4, 8, 3], [6.4, 9, 5, 3]],
  alignBetween: [[2, 2, 1.4, 12], [12.6, 2, 1.4, 12], [5.4, 5, 5.2, 6]],
};

export function SegIcon({ name, rotate }: { name: keyof typeof SEG_ICONS; rotate?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${rotate ? "rotate-90" : ""}`} aria-hidden="true" fill="currentColor">
      {SEG_ICONS[name].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={0.7} />
      ))}
    </svg>
  );
}

// --- SEGMENTS ---------------------------------------------------------------
//
// An inset pill with the active segment "raised" -- the design editors'
// language for every enum with few values.
const SEG_WRAP = "flex h-7 w-full gap-0.5 rounded-md bg-surface-2 p-0.5";
const SEG_ITEM =
  "flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center rounded px-1.5 text-[12px] font-medium " +
  "text-fg-muted outline-none transition-colors hover:text-fg " +
  "focus-visible:shadow-[var(--ring)]";
const SEG_ON = "bg-raised text-fg shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.08)]";

export interface SegOption<T extends string> {
  value: T;
  /** Accessible name (also tooltip) and, without an icon, the segment's text. */
  label: string;
  icon?: keyof typeof SEG_ICONS;
  /** Rotates the icon by 90 degrees: alignments apply to the vertical axis. */
  rotate?: boolean;
}

function SegContent<T extends string>({ o }: { o: SegOption<T> }) {
  // With the icon the text stays in the DOM, just not visible: the previous accessible name
  // (e.g. "Left") does not change.
  return o.icon ? (
    <>
      <SegIcon name={o.icon} rotate={o.rotate} />
      <span className="sr-only">{o.label}</span>
    </>
  ) : (
    <span className="truncate">{o.label}</span>
  );
}

/**
 * EXCLUSIVE segments as a RadioGroup (`radiogroup`/`radio` role). `value` null
 * = no choice (mixed selection): the group stays controlled and highlights
 * nothing. The group's label is the accessible name and, with
 * `showLabel`, also a visible line above.
 */
export function SegRadio<T extends string>({
  label, value, options, onChange, showLabel = true,
}: {
  label: string;
  value: T | null;
  options: readonly SegOption<T>[];
  onChange: (v: T) => void;
  showLabel?: boolean;
}) {
  return (
    <RadioGroup
      value={value}
      onChange={(v) => onChange(v as T)}
      orientation="horizontal"
      className="flex flex-col gap-1"
    >
      <Label className={showLabel ? "text-[11px] font-medium text-fg-subtle" : "sr-only"}>{label}</Label>
      <div className={SEG_WRAP}>
        {options.map((o) => (
          <Radio
            key={o.value}
            value={o.value}
            aria-label={o.icon ? o.label : undefined}
            className={({ isSelected }) => `${SEG_ITEM} ${isSelected ? SEG_ON : ""}`}
          >
            <SegContent o={o} />
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

/**
 * Segments as stateful BUTTONS (`aria-pressed`): for choices that used to be
 * buttons and not radios (fill type, direction and alignments
 * of auto layout). Same look as SegRadio.
 */
export function SegButtons<T extends string>({
  label, value, options, onPick, showLabel = false, wrap = false,
}: {
  label: string;
  value: T | undefined;
  options: readonly SegOption<T>[];
  onPick: (v: T) => void;
  showLabel?: boolean;
  /** Lays the options out in rows of three instead of one row (for five or more). */
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {showLabel && <span className="text-[11px] font-medium text-fg-subtle">{label}</span>}
      <div role="group" aria-label={label} className={wrap ? "grid w-full grid-cols-3 gap-0.5 rounded-md bg-surface-2 p-0.5" : SEG_WRAP}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            aria-label={o.icon ? o.label : undefined}
            title={o.label}
            onClick={() => onPick(o.value)}
            className={`${SEG_ITEM} ${wrap ? "h-6" : ""} ${value === o.value ? SEG_ON : ""}`}
          >
            <SegContent o={o} />
          </button>
        ))}
      </div>
    </div>
  );
}

// --- SWATCH -----------------------------------------------------------------

// The checkerboard that sits UNDER colors with alpha, made with tokens (it adapts to the
// theme) and not with two hand-picked grays.
export const CHECKER =
  "conic-gradient(var(--line-strong) 25%, var(--surface) 0 50%, var(--line-strong) 0 75%, var(--surface) 0) 0 0 / 8px 8px";

/** Color preview pill, with the checkerboard underneath for transparency. */
export function Swatch({ color, size = 16, className = "" }: { color: string | null; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`relative inline-block shrink-0 overflow-hidden rounded-[4px] shadow-[inset_0_0_0_1px_var(--line-strong)] ${className}`}
    >
      <span className="absolute inset-0" style={{ background: CHECKER }} />
      <span className="absolute inset-0" style={{ background: color ?? "transparent" }} />
      <span className="absolute inset-0 rounded-[4px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]" />
    </span>
  );
}

/** Row label, for controls that do not carry a prefix in the field. */
export function PropLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-medium text-fg-subtle">{children}</span>;
}
