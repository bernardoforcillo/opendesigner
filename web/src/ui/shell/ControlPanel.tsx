import { useMemo } from "react";
import { useScene } from "@/store/store";
import { MIXED, selectionSummary } from "@/store/selectors";
import { NumberField } from "@/ui/fields/NumberField";
import { POSITION_FIELDS, SIZE_FIELDS, numericOps } from "@/ui/PropertiesPanel";

// THE CONTROL PANEL (Publishing workspace): one strip under the document bar that always shows the
// geometry of what is selected -- position, size, rotation -- as a page-layout app does, so the
// numbers are one glance away without opening the right dock. It writes through the same ops as the
// Properties panel (numericOps), so a typed value or a label drag is ONE undo step either way.
//
// With nothing selected the fields stay in place, empty and disabled: the strip does not jump.
const FIELDS = [...POSITION_FIELDS, ...SIZE_FIELDS];

export function ControlPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const summary = useMemo(() => (scene ? selectionSummary(scene, selection) : null), [scene, selection]);
  // A group has no box of its own (store/groups.ts): W and H would be zeros that move nothing.
  const fields = summary?.kind === "group" ? POSITION_FIELDS : FIELDS;

  function commit(field: (typeof FIELDS)[number], value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    store.beginGesture();
    store.endGesture(numericOps(store.selection, field, value));
  }
  function scrub(field: (typeof FIELDS)[number], value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of numericOps(store.selection, field, value)) store.applyLocal(op);
  }
  function scrubEnd(field: (typeof FIELDS)[number], value: number) {
    const store = useScene.getState();
    if (!store.gesture) return;
    store.endGesture(numericOps(store.selection, field, value));
  }

  const kind = summary ? (summary.kind === MIXED ? "Mixed" : String(summary.kind).replace(/^./, (c) => c.toUpperCase())) : null;
  const what = !summary ? "Nothing selected" : summary.count > 1 ? `${summary.count} objects` : kind;

  return (
    <div role="group" aria-label="Control" className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
      <span className="w-28 shrink-0 truncate text-[12px] font-medium text-fg-muted">{what}</span>
      {fields.map((field) => {
        const v = summary ? summary[field.key as "x"] : NaN;
        return (
          <div key={field.key} className="w-[92px] shrink-0">
            <NumberField
              label={field.label}
              glyph={field.glyph}
              minValue={field.minValue}
              isDisabled={!summary}
              value={summary && v !== MIXED ? (v as number) : NaN}
              placeholder={summary && v === MIXED ? "Mixed" : undefined}
              onCommit={(n) => commit(field, n)}
              onScrub={(n) => scrub(field, n)}
              onScrubEnd={(n) => scrubEnd(field, n)}
            />
          </div>
        );
      })}
    </div>
  );
}
