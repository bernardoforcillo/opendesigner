import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "../store/store";
import { makeDeleteTextStyleDefOp, makeSetTextStyleDefOp, uuid } from "../tools/ops";
import type { TextStyleDefLite, TextStyleLite } from "../store/types";
import { Button, cls } from "./ds";
import { NumberField } from "./fields/NumberField";
import { familyChoices } from "./typographyOps";

// THE STYLES DIALOG (document menu → Styles…): create and edit PARAGRAPH styles (the look of whole
// paragraphs: font, size, spacing, indents, alignment, based-on and next style) and CHARACTER styles (a
// few fields over a range of characters). Applying them is done on the canvas: the style pickers in the
// text editor (selection) and in the properties panel (whole text). See docs/rich-text.md.
//
// Every edit is ONE absolute upsert of the whole style = one gesture = one undo step. A value the
// document refuses (a loop in "based on", for instance) leaves the style as it was and says so.

const WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
const BLANK: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" };

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

/** `d` without the optional fields that are at their default (the model keeps them absent). */
function tidy(d: TextStyleDefLite): TextStyleDefLite {
  const out: TextStyleDefLite = { id: d.id, name: d.name, style: d.style };
  if (d.kind) out.kind = d.kind;
  if (d.basedOn) out.basedOn = d.basedOn;
  if (d.nextStyleId) out.nextStyleId = d.nextStyleId;
  for (const k of ["spaceBefore", "spaceAfter", "indentFirst", "indentLeft"] as const) if (d[k]) out[k] = d[k];
  return out;
}

export function StylesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = isOpen && scene ? Object.values(scene.textStyles).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const paragraphs = all.filter((d) => d.kind !== "character");
  const characters = all.filter((d) => d.kind === "character");
  const cur = all.find((d) => d.id === selected) ?? null;
  const isChar = cur?.kind === "character";

  function create(kind: "paragraph" | "character") {
    const list = kind === "paragraph" ? paragraphs : characters;
    const def: TextStyleDefLite = {
      id: uuid(),
      name: `${kind === "paragraph" ? "Paragraph" : "Character"} style ${list.length + 1}`,
      style: kind === "paragraph" ? { ...BLANK, fontSize: 16 } : { ...BLANK },
      ...(kind === "character" ? { kind: "character" as const } : {}),
    };
    run([makeSetTextStyleDefOp(def)]);
    setSelected(def.id);
    setError(null);
  }

  function save(next: TextStyleDefLite) {
    const fixed = tidy(next);
    run([makeSetTextStyleDefOp(fixed)]);
    const stored = useScene.getState().scene?.textStyles[fixed.id];
    setError(JSON.stringify(stored) === JSON.stringify(fixed) ? null : "The document did not accept this style (a loop in “Based on”, or a bad value).");
  }

  const patchStyle = (patch: Partial<TextStyleLite>) => cur && save({ ...cur, style: { ...cur.style, ...patch } });
  const patchDef = (patch: Partial<TextStyleDefLite>) => cur && save({ ...cur, ...patch });
  const choices = isOpen && scene ? familyChoices(scene) : [];
  const bases = all.filter((d) => cur && d.id !== cur.id && (d.kind === "character") === isChar);

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[680px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Styles" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Styles</h2>
          <p className="text-fg-subtle">
            A paragraph style sets whole paragraphs; a character style overrides a few fields over some characters. Apply them
            from the text editor (on the selection) or from the properties panel (on the whole text).
          </p>

          <div className="grid grid-cols-[200px_1fr] gap-3">
            <div className="flex flex-col gap-2">
              {([["Paragraph styles", paragraphs], ["Character styles", characters]] as const).map(([title, list]) => (
                <div key={title} className="flex flex-col gap-1">
                  <span className={cls.label}>{title}</span>
                  <ul aria-label={title} className="flex flex-col gap-px">
                    {list.map((d) => (
                      <li key={d.id}>
                        <button type="button" aria-current={d.id === selected ? "true" : undefined}
                          className={"w-full truncate rounded-md px-2 py-1 text-left " + (d.id === selected ? "bg-accent-soft text-accent" : "hover:bg-surface-3")}
                          onClick={() => { setSelected(d.id); setError(null); }}>{d.name}</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                <Button onPress={() => create("paragraph")}>New paragraph style</Button>
                <Button onPress={() => create("character")}>New character style</Button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              {!cur ? (
                <p className="text-fg-subtle">Select a style to edit it, or create one.</p>
              ) : (
                <>
                  <input aria-label="Style name" className={cls.input} defaultValue={cur.name} key={cur.id + ":name"} maxLength={80}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== cur.name) patchDef({ name: v }); }} />
                  <select aria-label="Font" className={cls.select} value={cur.style.fontFamily} onChange={(e) => patchStyle({ fontFamily: e.target.value })}>
                    <option value="">{isChar ? "Keep the font" : "From the text"}</option>
                    {cur.style.fontFamily !== "" && !choices.some((c) => c.value === cur.style.fontFamily) && <option value={cur.style.fontFamily}>{cur.style.fontFamily}</option>}
                    {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField label="Size" minValue={0} value={cur.style.fontSize} placeholder="Inherit" onCommit={(v) => patchStyle({ fontSize: v })} />
                    <select aria-label="Weight" className={cls.select} value={cur.style.fontWeight} onChange={(e) => patchStyle({ fontWeight: e.target.value })}>
                      <option value="">Keep the weight</option>
                      {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {([["Italic", "italic"], ["Underline", "underline"], ["Strikethrough", "strikethrough"]] as const).map(([label, key]) => (
                      <label key={key} className="flex items-center gap-1.5">
                        <input type="checkbox" aria-label={label} checked={cur.style[key] === true}
                          onChange={(e) => patchStyle({ [key]: e.target.checked ? true : undefined })} /> {label}
                      </label>
                    ))}
                  </div>
                  {!isChar && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <NumberField label="Line" minValue={0} suffix="×" value={cur.style.lineHeight} placeholder="Inherit" onCommit={(v) => patchStyle({ lineHeight: v })} />
                        <select aria-label="Alignment" className={cls.select} value={cur.style.align} onChange={(e) => patchStyle({ align: e.target.value as TextStyleLite["align"] })}>
                          <option value="left">Left (or inherit)</option>
                          <option value="center">Center</option>
                          <option value="right">Right</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <NumberField label="Space before" minValue={0} value={cur.spaceBefore ?? 0} onCommit={(v) => patchDef({ spaceBefore: v })} />
                        <NumberField label="Space after" minValue={0} value={cur.spaceAfter ?? 0} onCommit={(v) => patchDef({ spaceAfter: v })} />
                        <NumberField label="First line" minValue={0} value={cur.indentFirst ?? 0} onCommit={(v) => patchDef({ indentFirst: v })} />
                        <NumberField label="Left indent" minValue={0} value={cur.indentLeft ?? 0} onCommit={(v) => patchDef({ indentLeft: v })} />
                      </div>
                    </>
                  )}
                  <select aria-label="Based on" className={cls.select} value={cur.basedOn ?? ""} onChange={(e) => patchDef({ basedOn: e.target.value })}>
                    <option value="">Not based on another style</option>
                    {bases.map((d) => <option key={d.id} value={d.id}>Based on {d.name}</option>)}
                  </select>
                  {!isChar && (
                    <select aria-label="Next style" className={cls.select} value={cur.nextStyleId ?? ""} onChange={(e) => patchDef({ nextStyleId: e.target.value })}>
                      <option value="">Next paragraph: same style</option>
                      {paragraphs.filter((d) => d.id !== cur.id).map((d) => <option key={d.id} value={d.id}>Next paragraph: {d.name}</option>)}
                    </select>
                  )}
                  {error && <p role="alert" className="text-danger">{error}</p>}
                  <div className="flex justify-between">
                    <Button variant="danger" onPress={() => { run([makeDeleteTextStyleDefOp(cur.id)]); setSelected(null); }}>Delete style</Button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>Done</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
