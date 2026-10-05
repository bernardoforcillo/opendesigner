import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { NumberField as AriaNumberField, Label, Input } from "react-aria-components";

// GENERIC NUMERIC FIELD (Task 9): a value that is committed by typing (Enter
// or blur, native behavior of react-aria-components) OR by dragging its
// LABEL -- expected behavior in a design editor (Figma, Sketch...),
// where a numeric field's label is itself a scrub handle.
//
// It knows nothing of gestures, ops or masks: whoever uses it (PropertiesPanel) decides WHAT to do
// with each commit. Here only three generic channels remain, all already cleaned of
// NaN before reaching the caller:
//   - onCommit   typing confirmed (Enter/blur) -- ONE final value;
//   - onScrub    CONTINUOUS preview while dragging the label;
//   - onScrubEnd release of the drag -- the final value of the SAME
//                gesture that onScrub anticipated.

// Below this threshold (SCREEN px) a pointerdown on the label stays a
// CLICK and not a drag: same idea as MARQUEE_SLOP_PX in
// tools/selectTool.ts, here applied to scrub. Without a threshold, a click
// that wobbles by a pixel would open/close an empty gesture.
const SCRUB_SLOP_PX = 2;

function clampMin(value: number, minValue: number | undefined): number {
  return minValue !== undefined && value < minValue ? minValue : value;
}

export interface NumberFieldProps {
  /** VISIBLE label and accessible name of the field (e.g. "X"). */
  label: string;
  /**
   * Current value. NaN represents "empty" (no single value to
   * show -- mixed selection, or no selection) and NOT "controlled vs
   * uncontrolled": passing `undefined` would make react-stately slip
   * out of control every time the value becomes defined again,
   * with the resulting development warning (see
   * react-stately/useControlledState). NaN is ALWAYS a value, so the
   * field stays ALWAYS controlled.
   */
  value: number;
  /**
   * Typing confirmed (Enter or blur, handled by react-aria-components
   * itself -- not per-key): the value is ALREADY a finite number. An empty
   * or unparsable input does NOT invoke this callback (see the comment
   * on onChange below): no NaN can reach the caller.
   */
  onCommit: (value: number) => void;
  /** Continuous preview while dragging the label. */
  onScrub?: (value: number) => void;
  /** Release of the drag: the FINAL value of the same gesture that onScrub anticipated. */
  onScrubEnd?: (value: number) => void;
  /**
   * Value units per dragged pixel. DELIBERATELY independent of the
   * `step` of react-aria-components (which would also round TYPED values
   * to the nearest step at commit -- see
   * useNumberFieldState::snapValue -- truncating fractional coordinates
   * the user never asked to round): here it only serves to scale
   * the scrub, the field never passes a `step` to react-aria-components.
   */
  dragSensitivity?: number;
  minValue?: number;
  /**
   * CSS classes for the label's WIDTH. It exists because the same field
   * serves one-letter labels (X/Y/W/H/R, the panel's compact grid)
   * and whole-word labels (Size, for text style): a fixed
   * width inside the component would be wrong for half of the use cases.
   * Without it, the prefix takes the width of its text.
   */
  labelWidth?: string;
  /**
   * The glyph shown in place of the label text (e.g. "°" for
   * rotation). The label stays in the DOM, just not visible (sr-only): it is the field's
   * accessible name, so "Rot" still reads "Rot".
   */
  glyph?: ReactNode;
  /** Unit after the value (e.g. "%", "px"): decorative, the value stays a number. */
  suffix?: string;
  isDisabled?: boolean;
  /**
   * Temporary text shown when the field is EMPTY (`value` NaN). The
   * properties panel uses it for "Mixed": a selection with different values
   * should read as "these nodes differ", not as a field
   * accidentally emptied -- see ui/PropertiesPanel.tsx::MIXED_LABEL.
   */
  placeholder?: string;
}

export function NumberField({
  label,
  value,
  onCommit,
  onScrub,
  onScrubEnd,
  dragSensitivity = 1,
  minValue,
  labelWidth,
  glyph,
  suffix,
  isDisabled,
  placeholder,
}: NumberFieldProps) {
  // State of the drag in progress. A ref and not a state: every pixel of
  // move must not re-render THIS component (the caller already does,
  // its own way, when onScrub updates the store). `started`
  // distinguishes a simple click on the label (threshold never exceeded) from a
  // real drag -- only the latter opens/closes a gesture on the
  // caller's side: see the comment on dragStarted in tools/selectTool.ts, same
  // idea here applied to scrubbing a label instead of a node.
  const drag = useRef<{ pointerId: number; startX: number; startValue: number; started: boolean } | null>(null);

  function onLabelPointerDown(e: ReactPointerEvent<HTMLLabelElement>) {
    // An undefined value (NaN, mixed selection) has no sensible
    // starting point to scrub from: better no drag than one
    // starting at 0 without the user asking for it.
    if (isDisabled || e.button !== 0 || !Number.isFinite(value)) return;
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startValue: value, started: false };
    // BEST-EFFORT capture: in real browsers it keeps receiving moves
    // even when the pointer leaves the label. jsdom (the tests) does not
    // really implement it -- hence the try/catch, same pattern as
    // tools/toolManager.ts.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no real capture (jsdom, or already lost) */
    }
  }

  function onLabelPointerMove(e: ReactPointerEvent<HTMLLabelElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.started) {
      if (Math.abs(dx) < SCRUB_SLOP_PX) return; // wobble: stays a click
      d.started = true;
    }
    onScrub?.(clampMin(d.startValue + dx * dragSensitivity, minValue));
  }

  // pointerup AND pointercancel: the browser can cancel the gesture (system
  // gesture, lost capture) just as much as release it normally, and in
  // BOTH cases the drag must close -- without it, the next
  // pointerdown would find drag.current still set with a pointerId
  // that will never arrive again.
  function endDrag(e: ReactPointerEvent<HTMLLabelElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!d.started) return; // simple click: no gesture to close
    const dx = e.clientX - d.startX;
    onScrubEnd?.(clampMin(d.startValue + dx * dragSensitivity, minValue));
  }

  return (
    <AriaNumberField
      value={value}
      minValue={minValue}
      isDisabled={isDisabled}
      // No thousands separators in a coordinate field: "1,234" for
      // x=1234 is noise, not readability, in a design editor.
      formatOptions={{ useGrouping: false, maximumFractionDigits: 2 }}
      onChange={(v) => {
        // An emptied and committed input commits NaN (react-stately::
        // commit, "Set to empty state if input value is empty"): without
        // this check an emptied field would send the caller a
        // value that, shipped as-is in a SetProperties, would make the
        // node invisible and unrecoverable from the UI (x/y NaN) -- see the
        // brief. An input that does not parse at all (e.g. "-" alone) does not
        // even get here: react-stately intercepts it first and does not call
        // onChange.
        if (!Number.isFinite(v)) return;
        onCommit(v);
      }}
      // The label is a PREFIX inside the field (X, Y, W, H, °): a single
      // inset rectangle that lights up on focus, as in design
      // editors. focus-within and not the input's focus, because the border belongs to
      // the container.
      className={
        "group flex h-7 min-w-0 items-center rounded-md border border-transparent bg-surface-2 " +
        "hover:border-line-strong focus-within:border-accent focus-within:bg-surface " +
        (isDisabled ? "opacity-50" : "")
      }
    >
      <Label
        onPointerDown={onLabelPointerDown}
        onPointerMove={onLabelPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // touch-none: dragging the label on a touch screen must not
        // scroll the panel (same reason as the reorder handle in
        // ui/LayersPanel.tsx). select-none: a scrub must not select the
        // label text while the pointer moves.
        className={
          `${labelWidth ?? "min-w-6"} flex h-full shrink-0 cursor-ew-resize touch-none select-none items-center ` +
          "justify-center pl-2 pr-1 text-[11px] font-medium text-fg-subtle group-focus-within:text-accent hover:text-fg"
        }
      >
        {glyph !== undefined ? (
          <>
            <span aria-hidden="true">{glyph}</span>
            <span className="sr-only">{label}</span>
          </>
        ) : (
          label
        )}
      </Label>
      <Input
        placeholder={placeholder}
        className={
          "h-full w-full min-w-0 bg-transparent pr-2 text-left text-[13px] tabular-nums text-fg outline-none " +
          "placeholder:text-fg-subtle focus-visible:shadow-none disabled:cursor-not-allowed"
        }
      />
      {suffix && <span aria-hidden="true" className="select-none pr-2 text-[12px] text-fg-subtle">{suffix}</span>}
    </AriaNumberField>
  );
}
