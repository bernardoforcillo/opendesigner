import { useState } from "react";
import { useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { makeDeleteTextStyleDefOp, makeSetTextStyleDefOp, uuid } from "@/tools/ops";
import type { NestedStyleLite, NumberStyle, TabStopLite, TextStyleDefLite, TextStyleLite } from "@/store/types";
import { Button, cls } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";
import { familyChoices } from "@/ui/typographyOps";
import { isValidFontFeatures } from "@/store/typography";

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

// JSON with sorted keys: the stored style lists its fields in the converter's order, not the edit's.
const canon = (v: unknown) => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/** `d` without the optional fields that are at their default (the model keeps them absent). */
function tidy(d: TextStyleDefLite): TextStyleDefLite {
  const out: TextStyleDefLite = { id: d.id, name: d.name, style: d.style };
  if (d.kind) out.kind = d.kind;
  if (d.basedOn) out.basedOn = d.basedOn;
  if (d.nextStyleId) out.nextStyleId = d.nextStyleId;
  for (const k of ["spaceBefore", "spaceAfter", "indentFirst", "indentLeft"] as const) if (d[k]) out[k] = d[k];
  if (d.alignToGrid) out.alignToGrid = true;
  if (d.hyphenate) out.hyphenate = true;
  if (d.listKind) out.listKind = d.listKind;
  if (d.listMarker) out.listMarker = d.listMarker;
  if (d.listNumberStyle) out.listNumberStyle = d.listNumberStyle;
  if (d.listIndent) out.listIndent = d.listIndent;
  if (d.tabStops && d.tabStops.length > 0) out.tabStops = d.tabStops;
  if (d.dropCapLines) out.dropCapLines = d.dropCapLines;
  if (d.dropCapChars) out.dropCapChars = d.dropCapChars;
  if (d.outlineLevel) out.outlineLevel = d.outlineLevel;
  if (d.keepWithNext) out.keepWithNext = true;
  if (d.keepLinesTogether) out.keepLinesTogether = true;
  if (d.keepFirstLines) out.keepFirstLines = d.keepFirstLines;
  if (d.keepLastLines) out.keepLastLines = d.keepLastLines;
  if (d.ruleAbove) out.ruleAbove = d.ruleAbove;
  if (d.ruleBelow) out.ruleBelow = d.ruleBelow;
  if (d.shading) out.shading = d.shading;
  if (d.shadingOffset) out.shadingOffset = d.shadingOffset;
  if (d.borderColor) out.borderColor = d.borderColor;
  if (d.borderWeight) out.borderWeight = d.borderWeight;
  if (d.opticalMargin) out.opticalMargin = true;
  if (d.nestedStyles && d.nestedStyles.length > 0) out.nestedStyles = d.nestedStyles;
  return out;
}

const hexOf = (c: { r: number; g: number; b: number }) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const colorOf = (h: string) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

// Tab stops as text: "40, 200 right ., 300 center" -- a position, then left/center/right, then a leader character.
export function formatTabs(tabs: readonly TabStopLite[] | undefined): string {
  return (tabs ?? []).map((t) => [t.position, t.align ?? "", t.leader ?? ""].filter((x) => x !== "").join(" ")).join(", ");
}
export function parseTabs(text: string): TabStopLite[] {
  const out: TabStopLite[] = [];
  for (const part of text.split(",")) {
    const [pos, a, leader] = part.trim().split(/\s+/);
    const position = Number(pos);
    if (pos === undefined || pos === "" || !Number.isFinite(position)) continue;
    out.push({ position, ...(a === "center" || a === "right" ? { align: a } : {}), ...(leader ? { leader: Array.from(leader)[0] } : a && a !== "left" && a !== "center" && a !== "right" ? { leader: Array.from(a)[0] } : {}) });
  }
  return out.sort((x, y) => x.position - y.position).filter((t, i, all) => i === 0 || t.position > all[i - 1].position);
}

const hex = (c: { r: number; g: number; b: number }) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });

export function StylesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useT();
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
    setError(canon(stored) === canon(fixed) ? null : t("The document did not accept this style (a loop in “Based on”, or a bad value)."));
  }

  const patchStyle = (patch: Partial<TextStyleLite>) => cur && save({ ...cur, style: { ...cur.style, ...patch } });
  const patchDef = (patch: Partial<TextStyleDefLite>) => cur && save({ ...cur, ...patch });
  const patchNested = (i: number, patch: Partial<NestedStyleLite>) => cur && patchDef({ nestedStyles: (cur.nestedStyles ?? []).map((n, k) => (k === i ? { ...n, ...patch } : n)) });
  const choices = isOpen && scene ? familyChoices(scene) : [];
  const bases = all.filter((d) => cur && d.id !== cur.id && (d.kind === "character") === isChar);

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[680px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Styles")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Styles")}</h2>
          <p className="text-fg-subtle">
            {t("A paragraph style sets whole paragraphs; a character style overrides a few fields over some characters. Apply them from the text editor (on the selection) or from the properties panel (on the whole text).")}
          </p>

          <div className="grid grid-cols-[200px_1fr] gap-3">
            <div className="flex flex-col gap-2">
              {([[t("Paragraph styles"), paragraphs], [t("Character styles"), characters]] as const).map(([title, list]) => (
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
                <Button onPress={() => create("paragraph")}>{t("New paragraph style")}</Button>
                <Button onPress={() => create("character")}>{t("New character style")}</Button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              {!cur ? (
                <p className="text-fg-subtle">{t("Select a style to edit it, or create one.")}</p>
              ) : (
                <>
                  <input aria-label={t("Style name")} className={cls.input} defaultValue={cur.name} key={cur.id + ":name"} maxLength={80}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== cur.name) patchDef({ name: v }); }} />
                  <select aria-label={t("Font")} className={cls.select} value={cur.style.fontFamily} onChange={(e) => patchStyle({ fontFamily: e.target.value })}>
                    <option value="">{isChar ? t("Keep the font") : t("From the text")}</option>
                    {cur.style.fontFamily !== "" && !choices.some((c) => c.value === cur.style.fontFamily) && <option value={cur.style.fontFamily}>{cur.style.fontFamily}</option>}
                    {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberField label={t("Size")} minValue={0} value={cur.style.fontSize} placeholder={t("Inherit")} onCommit={(v) => patchStyle({ fontSize: v })} />
                    <select aria-label={t("Weight")} className={cls.select} value={cur.style.fontWeight} onChange={(e) => patchStyle({ fontWeight: e.target.value })}>
                      <option value="">{t("Keep the weight")}</option>
                      {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {([[t("Italic"), "italic"], [t("Underline"), "underline"], [t("Strikethrough"), "strikethrough"]] as const).map(([label, key]) => (
                      <label key={key} className="flex items-center gap-1.5">
                        <input type="checkbox" aria-label={label} checked={cur.style[key] === true}
                          onChange={(e) => patchStyle({ [key]: e.target.checked ? true : undefined })} /> {label}
                      </label>
                    ))}
                  </div>
                  <NumberField label={t("Tracking")} suffix="px" value={cur.style.letterSpacing ?? 0}
                    onCommit={(v) => patchStyle({ letterSpacing: v === 0 ? undefined : v })} />
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" aria-label={t("Small caps")} checked={cur.style.smallCaps === true}
                        onChange={(e) => patchStyle({ smallCaps: e.target.checked ? true : undefined })} /> {t("Small caps")}
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" aria-label={t("Kerning off")} checked={cur.style.noKerning === true}
                        onChange={(e) => patchStyle({ noKerning: e.target.checked ? true : undefined })} /> {t("Kerning off")}
                    </label>
                    <select aria-label={t("Text case")} className={cls.select} value={cur.style.textCase ?? ""}
                      onChange={(e) => patchStyle({ textCase: e.target.value === "" ? undefined : e.target.value as TextStyleLite["textCase"] })}>
                      <option value="">{t("Case as typed")}</option>
                      <option value="upper">{t("UPPER")}</option>
                      <option value="lower">{t("lower")}</option>
                      <option value="title">{t("Title Case")}</option>
                      <option value="smallCaps">{t("Small caps")}</option>
                    </select>
                    <select aria-label={t("Position")} className={cls.select} value={cur.style.textScript ?? ""}
                      onChange={(e) => patchStyle({ textScript: e.target.value === "" ? undefined : (e.target.value as "super" | "sub") })}>
                      <option value="">{t("Normal position")}</option>
                      <option value="super">{t("Superscript")}</option>
                      <option value="sub">{t("Subscript")}</option>
                    </select>
                  </div>
                  <NumberField label={t("Scale %")} minValue={1} value={cur.style.textScale ?? 100}
                    onCommit={(v) => patchStyle({ textScale: v > 0 && v !== 100 ? Math.min(1000, v) : undefined })} />
                  <input aria-label={t("OpenType features")} className={cls.input} placeholder={'"ss01", "cv05" 1'} key={cur.id + ":features"}
                    defaultValue={cur.style.fontFeatures ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (isValidFontFeatures(v) && v !== (cur.style.fontFeatures ?? "")) patchStyle({ fontFeatures: v === "" ? undefined : v });
                    }} />
                  <input aria-label={t("Variable font axes")} className={cls.input} placeholder={t("Variable axes: wght 650, wdth 90")} defaultValue={cur.style.fontVariations ?? ""} key={cur.id + ":variations"} maxLength={128}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (cur.style.fontVariations ?? "")) patchStyle({ fontVariations: v === "" ? undefined : v }); }} />
                  <div className="grid grid-cols-2 items-end gap-2">
                    <NumberField label={t("Width")} minValue={10} suffix="%" value={Math.round((cur.style.horizontalScale ?? 1) * 100)}
                      onCommit={(v) => patchStyle({ horizontalScale: v === 100 ? undefined : v / 100 })} />
                    <div className="flex items-center gap-2">
                      <input type="color" aria-label={t("Text colour")} value={cur.style.color ? hex(cur.style.color) : "#000000"}
                        onChange={(e) => patchStyle({ color: fromHex(e.target.value) })} />
                      <Button isDisabled={!cur.style.color} onPress={() => patchStyle({ color: undefined })}>{t("Use the fill")}</Button>
                    </div>
                  </div>
                  {!isChar && (
                    <>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" aria-label={t("Align to baseline grid")} checked={cur.alignToGrid === true}
                          onChange={(e) => patchDef({ alignToGrid: e.target.checked ? true : undefined })} /> {t("Align to baseline grid")}
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <select aria-label={t("Text list")} className={cls.select} value={cur.style.listKind ?? ""}
                          onChange={(e) => patchStyle({ listKind: e.target.value === "" ? undefined : e.target.value as TextStyleLite["listKind"] })}>
                          <option value="">{t("No list")}</option>
                          <option value="bullet">{t("Bulleted")}</option>
                          <option value="numbered">{t("Numbered")}</option>
                        </select>
                        <NumberField label={t("Indent")} minValue={0} value={cur.style.indent ?? 0}
                          onCommit={(v) => patchStyle({ indent: v > 0 ? v : undefined })} />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <NumberField label={t("Line")} minValue={0} suffix="×" value={cur.style.lineHeight} placeholder={t("Inherit")} onCommit={(v) => patchStyle({ lineHeight: v })} />
                        <select aria-label={t("Alignment")} className={cls.select} value={cur.style.align} onChange={(e) => patchStyle({ align: e.target.value as TextStyleLite["align"] })}>
                          <option value="left">{t("Left (or inherit)")}</option>
                          <option value="center">{t("Center")}</option>
                          <option value="right">{t("Right")}</option>
                          <option value="justify">{t("Justify")}</option>
                        </select>
                      </div>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" aria-label={t("Hyphenate")} checked={cur.hyphenate === true}
                          onChange={(e) => patchDef({ hyphenate: e.target.checked ? true : undefined })} /> {t("Hyphenate")}
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <NumberField label={t("Space before")} minValue={0} value={cur.spaceBefore ?? 0} onCommit={(v) => patchDef({ spaceBefore: v })} />
                        <NumberField label={t("Space after")} minValue={0} value={cur.spaceAfter ?? 0} onCommit={(v) => patchDef({ spaceAfter: v })} />
                        <NumberField label={t("First line")} minValue={0} value={cur.indentFirst ?? 0} onCommit={(v) => patchDef({ indentFirst: v })} />
                        <NumberField label={t("Left indent")} minValue={0} value={cur.indentLeft ?? 0} onCommit={(v) => patchDef({ indentLeft: v })} />
                      </div>
                      <NumberField label={t("Heading level (contents, running heads)")} minValue={0} value={cur.outlineLevel ?? 0}
                        onCommit={(v) => patchDef({ outlineLevel: v === 0 ? undefined : Math.min(9, Math.round(v)) })} />
                      <span className={cls.label}>{t("List")}</span>
                      <div className="grid grid-cols-2 gap-2">
                        <select aria-label={t("List")} className={cls.select} value={cur.listKind ?? ""}
                          onChange={(e) => patchDef({ listKind: e.target.value === "" ? undefined : (e.target.value as "bullet" | "number") })}>
                          <option value="">{t("No list")}</option>
                          <option value="bullet">{t("Bullets")}</option>
                          <option value="number">{t("Numbers")}</option>
                        </select>
                        <input aria-label={t("List marker")} className={cls.input} defaultValue={cur.listMarker ?? ""} key={cur.id + ":marker"} maxLength={16}
                          placeholder={cur.listKind === "number" ? t("# . (the # is the number)") : t("• (the bullet)")}
                          onBlur={(e) => { if (e.target.value !== (cur.listMarker ?? "")) patchDef({ listMarker: e.target.value || undefined }); }} />
                        {cur.listKind === "number" && (
                          <select aria-label={t("Number style")} className={cls.select} value={cur.listNumberStyle ?? ""}
                            onChange={(e) => patchDef({ listNumberStyle: (e.target.value || undefined) as NumberStyle | undefined })}>
                            <option value="">1, 2, 3</option><option value="i">i, ii, iii</option><option value="I">I, II, III</option>
                            <option value="a">a, b, c</option><option value="A">A, B, C</option>
                          </select>
                        )}
                        {cur.listKind && <NumberField label={t("Text indent")} minValue={0} value={cur.listIndent ?? 0} placeholder="18" onCommit={(v) => patchDef({ listIndent: v })} />}
                      </div>
                      <span className={cls.label}>{t("Breaks between frames")}</span>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={t("Keep with next")} checked={cur.keepWithNext === true}
                          onChange={(e) => patchDef({ keepWithNext: e.target.checked ? true : undefined })} /> {t("Keep with next")}</label>
                        <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={t("Keep lines together")} checked={cur.keepLinesTogether === true}
                          onChange={(e) => patchDef({ keepLinesTogether: e.target.checked ? true : undefined })} /> {t("Keep lines together")}</label>
                        <NumberField label={t("Orphans (lines at the bottom)")} minValue={0} value={cur.keepFirstLines ?? 0} onCommit={(v) => patchDef({ keepFirstLines: v === 0 ? undefined : Math.min(6, Math.round(v)) })} />
                        <NumberField label={t("Widows (lines at the top)")} minValue={0} value={cur.keepLastLines ?? 0} onCommit={(v) => patchDef({ keepLastLines: v === 0 ? undefined : Math.min(6, Math.round(v)) })} />
                      </div>
                      <span className={cls.label}>{t("Rules, shading and border")}</span>
                      {(["ruleAbove", "ruleBelow"] as const).map((key) => {
                        const r = cur[key];
                        const name = key === "ruleAbove" ? t("Rule above") : t("Rule below");
                        return (
                          <div key={key} className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-2">
                            <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={name} checked={!!r}
                              onChange={(e) => patchDef({ [key]: e.target.checked ? { weight: 1, color: BLACK } : undefined })} /> {name}</label>
                            {r && <NumberField label={t("Weight")} minValue={0.25} value={r.weight} onCommit={(v) => patchDef({ [key]: { ...r, weight: v } })} />}
                            {r && <NumberField label={t("Offset")} value={r.offset ?? 0} onCommit={(v) => patchDef({ [key]: { ...r, offset: v || undefined } })} />}
                            {r && <input type="color" aria-label={t("{name} colour", { name })} value={hexOf(r.color ?? BLACK)} onChange={(e) => patchDef({ [key]: { ...r, color: colorOf(e.target.value) } })} />}
                          </div>
                        );
                      })}
                      <div className="grid grid-cols-[auto_auto_1fr] items-end gap-2">
                        <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={t("Shading")} checked={!!cur.shading}
                          onChange={(e) => patchDef({ shading: e.target.checked ? { r: 0.9, g: 0.9, b: 0.9, a: 1 } : undefined })} /> {t("Shading")}</label>
                        {cur.shading ? <input type="color" aria-label={t("Shading colour")} value={hexOf(cur.shading)} onChange={(e) => patchDef({ shading: colorOf(e.target.value) })} /> : <span />}
                        <NumberField label={t("Extends past the text by")} minValue={0} value={cur.shadingOffset ?? 0} onCommit={(v) => patchDef({ shadingOffset: v || undefined })} />
                      </div>
                      <div className="grid grid-cols-[auto_1fr_auto] items-end gap-2">
                        <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={t("Border")} checked={!!cur.borderColor && !!cur.borderWeight}
                          onChange={(e) => patchDef(e.target.checked ? { borderColor: BLACK, borderWeight: 1 } : { borderColor: undefined, borderWeight: undefined })} /> {t("Border")}</label>
                        {cur.borderColor ? <NumberField label={t("Weight")} minValue={0.25} value={cur.borderWeight ?? 1} onCommit={(v) => patchDef({ borderWeight: v })} /> : <span />}
                        {cur.borderColor ? <input type="color" aria-label={t("Border colour")} value={hexOf(cur.borderColor)} onChange={(e) => patchDef({ borderColor: colorOf(e.target.value) })} /> : <span />}
                      </div>
                      <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={t("Optical margin alignment")} checked={cur.opticalMargin === true}
                        onChange={(e) => patchDef({ opticalMargin: e.target.checked ? true : undefined })} /> {t("Optical margin alignment (hanging punctuation)")}</label>
                      <span className={cls.label}>{t("Tabs and drop cap")}</span>
                      <input aria-label={t("Tab stops")} className={cls.input} defaultValue={formatTabs(cur.tabStops)} key={cur.id + ":tabs"}
                        placeholder="40, 300 right ."
                        onBlur={(e) => { const tabs = parseTabs(e.target.value); if (formatTabs(tabs) !== formatTabs(cur.tabStops)) patchDef({ tabStops: tabs.length > 0 ? tabs : undefined }); }} />
                      <div className="grid grid-cols-2 gap-2">
                        <NumberField label={t("Drop cap lines")} minValue={0} value={cur.dropCapLines ?? 0} onCommit={(v) => patchDef({ dropCapLines: v === 0 ? undefined : Math.round(v) })} />
                        <NumberField label={t("Drop cap letters")} minValue={0} value={cur.dropCapChars ?? 0} placeholder="1" onCommit={(v) => patchDef({ dropCapChars: v === 0 ? undefined : Math.round(v) })} />
                      </div>
                      <span className={cls.label}>{t("Nested styles (the start of each paragraph)")}</span>
                      {(cur.nestedStyles ?? []).map((n, i) => (
                        <div key={i} className="grid grid-cols-[1fr_60px_60px_auto_auto] items-center gap-1.5">
                          <select aria-label={t("Nested style {n}", { n: i + 1 })} className={cls.select} value={n.styleId}
                            onChange={(e) => patchNested(i, { styleId: e.target.value })}>
                            {characters.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                          <input aria-label={t("Nested delimiter {n}", { n: i + 1 })} className={cls.input} defaultValue={n.delimiter} maxLength={8}
                            onBlur={(e) => { if (e.target.value !== "" && e.target.value !== n.delimiter) patchNested(i, { delimiter: e.target.value }); }} />
                          <NumberField label={t("Count")} minValue={1} value={n.count} onCommit={(v) => patchNested(i, { count: Math.max(1, Math.round(v)) })} />
                          <label className="flex items-center gap-1"><input type="checkbox" aria-label={t("Include delimiter {n}", { n: i + 1 })} checked={n.inclusive === true}
                            onChange={(e) => patchNested(i, { inclusive: e.target.checked ? true : undefined })} /> {t("incl.")}</label>
                          <Button aria-label={t("Remove nested style {n}", { n: i + 1 })} onPress={() => patchDef({ nestedStyles: (cur.nestedStyles ?? []).filter((_, k) => k !== i) })}>×</Button>
                        </div>
                      ))}
                      <Button isDisabled={characters.length === 0} onPress={() => patchDef({ nestedStyles: [...(cur.nestedStyles ?? []), { styleId: characters[0].id, delimiter: ":", count: 1, inclusive: true }] })}>{t("Add a nested style")}</Button>
                    </>
                  )}
                  <select aria-label={t("Based on")} className={cls.select} value={cur.basedOn ?? ""} onChange={(e) => patchDef({ basedOn: e.target.value })}>
                    <option value="">{t("Not based on another style")}</option>
                    {bases.map((d) => <option key={d.id} value={d.id}>{t("Based on {name}", { name: d.name })}</option>)}
                  </select>
                  {!isChar && (
                    <select aria-label={t("Next style")} className={cls.select} value={cur.nextStyleId ?? ""} onChange={(e) => patchDef({ nextStyleId: e.target.value })}>
                      <option value="">{t("Next paragraph: same style")}</option>
                      {paragraphs.filter((d) => d.id !== cur.id).map((d) => <option key={d.id} value={d.id}>{t("Next paragraph: {name}", { name: d.name })}</option>)}
                    </select>
                  )}
                  {error && <p role="alert" className="text-danger">{error}</p>}
                  <div className="flex justify-between">
                    <Button variant="danger" onPress={() => { run([makeDeleteTextStyleDefOp(cur.id)]); setSelected(null); }}>{t("Delete style")}</Button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>{t("Done")}</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
