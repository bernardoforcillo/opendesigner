import { useContext, type ReactNode } from "react";
import { ColorField as AriaColorField, ColorFieldStateContext, Input, Label } from "react-aria-components";
import type { Color } from "react-aria-components";
import type { FillLite } from "../../store/types";
import { Swatch } from "../ds/props-controls";

// COLOR FIELD (Task 10). The model keeps tints as RGBA FLOAT 0..1 -- it is the
// form the .proto carries (opendesigner.v1.Color) and the one the renderer
// draws -- while the user reads and writes them in HEXADECIMAL. The
// conversion between the two forms lives HERE and nowhere else: it is the
// brief's "UI edge". No other module (neither the store, nor tools/ops.ts, nor
// the renderer) must ever see a "#RRGGBB" string.
//
// Like NumberField, it knows nothing of gestures, ops or masks: it emits ONE confirmed value and
// whoever uses it (PropertiesPanel) decides what to do with it.

/**
 * Only the CHROMATIC components of a tint. Alpha does not go through the field: a
 * 6-digit hex does not carry it, and sticking it on would make the field
 * the only place where two things can be changed together without saying so. Whoever
 * builds the op recomposes alpha from the node's tint (see
 * ui/PropertiesPanel.tsx::fillOps), so a multiple selection with different
 * alphas does not see them flattened by a color change.
 */
export type RgbLite = Pick<FillLite, "r" | "g" | "b">;

const MAX_CHANNEL = 255;

// 0..1 float -> 0..255 integer. The clamp is not defensiveness: a fill that arrives
// off the wire is any float whatsoever, and Number.toString(16) of an out-of-range value
// would produce a string that parseColor would reject (throw on every render).
function toByte(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * MAX_CHANNEL);
}

/** Model RGB (float 0..1) -> "#RRGGBB". */
export function rgbToHex(c: RgbLite): string {
  return `#${[c.r, c.g, c.b].map((v) => toByte(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * Inverse of rgbToHex, starting from react-aria-components' Color.
 *
 * `toFormat("rgb")` and not a direct read of the channels: a field without `channel`
 * works in hexadecimal, so the Color is already RGB, but the explicit conversion
 * keeps it true even if the field were one day configured in another
 * color space -- and costs nothing when it is already in the right format.
 */
export function colorToRgb(color: Color): RgbLite {
  const rgb = color.toFormat("rgb");
  return {
    r: rgb.getChannelValue("red") / MAX_CHANNEL,
    g: rgb.getChannelValue("green") / MAX_CHANNEL,
    b: rgb.getChannelValue("blue") / MAX_CHANNEL,
  };
}

export interface ColorFieldProps {
  /** VISIBLE label and accessible name of the field (e.g. "Fill"). */
  label: string;
  /**
   * Current color, or null for "no single value to show" (mixed
   * selection, node without tints). null and NOT undefined, for the same reason
   * NumberField uses NaN instead of undefined: null stays a VALUE, so
   * react-stately does not slip the field from controlled to uncontrolled
   * when the color becomes defined again.
   */
  value: RgbLite | null;
  /**
   * Confirmed color (Enter or blur, handled by react-aria-components itself).
   * An emptied or unparsable field does NOT invoke this callback, nor does
   * re-confirming the SAME color: react-stately compares the two values before
   * propagating (useColorFieldState::safelySetColorValue), so no change that
   * is not a change ever arrives here -- and the listener does not send a
   * useless op.
   */
  onCommit: (rgb: RgbLite) => void;
  /**
   * Shows the label above the field. Normally NO: in the inspector the row is
   * "swatch + hexadecimal" and its role is stated by the section that
   * contains it. The label stays in the DOM anyway (sr-only) as the accessible
   * name -- it is needed visible only where there is more than one row and they must be
   * told apart (instance overrides).
   */
  showLabel?: boolean;
  /** Controls to the right of the hexadecimal in the same rectangle (e.g. an opacity). */
  trailing?: ReactNode;
  isDisabled?: boolean;
  /**
   * Temporary text shown when the field is EMPTY (`value` null). Same
   * reason as the twin in NumberField -- see NumberFieldProps::placeholder.
   */
  placeholder?: string;
}

// The field's <Input>, separated ONLY so that ColorFieldStateContext can be read:
// the context is published by AriaColorField, so it must be consumed by a
// descendant of it.
//
// It exists because react-aria-components commits the color only on BLUR
// (useColorField: `onBlur: commit`, and no Enter handler anywhere
// -- unlike NumberField, which handles Enter on its own). In a
// properties panel that is the wrong behavior: you type a
// color, press Enter and expect to see it applied, not to have to
// leave the field. Without this line the typed color would stay in the field
// and would never become an op.
function HexInput({ placeholder }: { placeholder?: string }) {
  const state = useContext(ColorFieldStateContext);
  return (
    <Input
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        // The field may sit inside a <form> (today it does not, but it is the
        // reason this default exists): Enter must not submit it.
        e.preventDefault();
        state?.commit();
      }}
      className="h-full w-full min-w-0 bg-transparent px-2 text-[13px] uppercase tabular-nums text-fg outline-none placeholder:normal-case placeholder:text-fg-subtle focus-visible:shadow-none"
    />
  );
}

export function ColorField({ label, value, onCommit, showLabel = false, trailing, isDisabled, placeholder }: ColorFieldProps) {
  const hex = value ? rgbToHex(value) : null;
  return (
    <AriaColorField
      // Hexadecimal string and not an already built Color: react-aria-components
      // normalizes it on its own (useColorFieldState::useColor) and a new
      // but EQUAL string does not count as a new value, whereas a parseColor() on every
      // render would return a different object every time.
      value={hex}
      isDisabled={isDisabled}
      onChange={(color) => {
        // Emptied field: react-stately propagates null. It is the analog of NumberField's
        // NaN -- "no color" is not a color to write into the
        // document, so it does not become an op.
        if (!color) return;
        onCommit(colorToRgb(color));
      }}
      className="flex min-w-0 flex-col gap-1"
    >
      <Label className={showLabel ? "truncate text-[11px] font-medium text-fg-subtle" : "sr-only"}>{label}</Label>
      {/* ONE inset rectangle: swatch, hexadecimal and (optional) more.
          The swatch is aria-hidden and not a ColorSwatch: the value is already stated
          by the text field next to it (same accessible name), and announcing it twice
          would be noise for screen reader users. A real visual picker
          (wheel/area) is later work: here the EXACT channel is needed --
          the hexadecimal -- which is also how colors are copied between
          design tools. */}
      <div
        className={
          "flex h-7 min-w-0 items-center rounded-md border border-transparent bg-surface-2 pl-1.5 " +
          "hover:border-line-strong focus-within:border-accent focus-within:bg-surface " +
          (isDisabled ? "opacity-50" : "")
        }
      >
        <Swatch color={hex} />
        <HexInput placeholder={placeholder} />
        {trailing}
      </div>
    </AriaColorField>
  );
}
