import { useMemo } from "react";
import { useScene } from "@/store/store";
import { MIXED, selectionSummary } from "@/store/selectors";
import { NumberField } from "@/ui/fields/NumberField";
import { POSITION_FIELDS, SIZE_FIELDS, numericOps } from "@/ui/PropertiesPanel";
import { applyStyle } from "@/ui/shell/StylesPanel";
import { characterStyleOf, effectiveStyle, paragraphStyleOf, styleOps } from "@/ui/typographyOps";
import type { SceneState, TextAlignLite } from "@/store/types";

// THE CONTROL PANEL (Publishing workspace): one strip under the document bar that always shows the
// geometry of what is selected -- position, size, rotation -- as a page-layout app does, so the
// numbers are one glance away without opening the right dock. It writes through the same ops as the
// Properties panel (numericOps), so a typed value or a label drag is ONE undo step either way.
//
// With nothing selected the fields stay in place, empty and disabled: the strip does not jump.
const FIELDS = [...POSITION_FIELDS, ...SIZE_FIELDS];

const SELECT_CLS = "h-7 min-w-0 rounded-md border border-line bg-surface px-1.5 text-[12px] text-fg outline-none focus-visible:shadow-[var(--ring)] disabled:opacity-50";
const ALIGNS: readonly TextAlignLite[] = ["left", "center", "right", "justify"];

// What a text selection adds to the strip: the paragraph and character style, the size and the alignment
// of the selected frames (the type controls of a layout app's control panel). Styles go through the same
// ops as the Styles panel, size and alignment through `styleOps`, so each change is one undo step.
function TextControls({ scene, ids }: { scene: SceneState; ids: readonly string[] }) {
  const defs = Object.values(scene.textStyles).sort((a, b) => a.name.localeCompare(b.name));
  const para = paragraphStyleOf(scene, ids);
  const char = characterStyleOf(scene, ids);
  const nodes = ids.flatMap((id) => { const n = scene.nodes.at(id); return n ? [n] : []; });
  // A paragraph style decides the size of its paragraphs: the field shows it, and leaves it to the style.
  const styled = para !== undefined && para !== "" ? scene.textStyles[para]?.style.fontSize : undefined;
  const sizes = new Set(nodes.map((n) => styled ?? effectiveStyle(scene, n)?.fontSize));
  const aligns = new Set(nodes.map((n) => effectiveStyle(scene, n)?.align));
  const patch = (p: Parameters<typeof styleOps>[2]) => {
    const store = useScene.getState();
    if (!store.scene) return;
    const ops = styleOps(store.scene, ids, p);
    if (ops.length === 0) return;
    store.beginGesture();
    store.endGesture(ops);
  };
  const styleSelect = (label: string, value: string | undefined, kind: "paragraph" | "character") => (
    <select
      aria-label={label}
      className={`${SELECT_CLS} w-36`}
      value={value ?? "__mixed"}
      onChange={(e) => applyStyle(ids, { [kind]: e.target.value })}
    >
      {value === undefined && <option value="__mixed" disabled>Mixed</option>}
      <option value="">{kind === "paragraph" ? "No paragraph style" : "No character style"}</option>
      {defs.filter((d) => (kind === "character") === (d.kind === "character")).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
  return (
    <>
      <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      {styleSelect("Paragraph style", para, "paragraph")}
      {styleSelect("Character style", char, "character")}
      <div className="w-[104px] shrink-0">
        <NumberField
          label="Size"
          labelWidth="w-8"
          minValue={1}
          isDisabled={styled !== undefined}
          value={sizes.size === 1 ? (sizes.values().next().value as number) : NaN}
          placeholder={sizes.size > 1 ? "Mixed" : undefined}
          onCommit={(n) => patch({ fontSize: n })}
        />
      </div>
      <select
        aria-label="Alignment"
        className={`${SELECT_CLS} w-24`}
        value={aligns.size === 1 ? (aligns.values().next().value as string) : "__mixed"}
        onChange={(e) => patch({ align: e.target.value as TextAlignLite })}
      >
        {aligns.size !== 1 && <option value="__mixed" disabled>Mixed</option>}
        {ALIGNS.map((a) => <option key={a} value={a}>{a[0].toUpperCase() + a.slice(1)}</option>)}
      </select>
    </>
  );
}

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
    <div role="group" aria-label="Control" className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-surface px-3">
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
      {scene && summary && summary.kind === "text" && <TextControls scene={scene} ids={selection} />}
    </div>
  );
}
