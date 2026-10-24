import { useScene } from "../store/store";
import type { NodeLite, TextStyleLite } from "../store/types";
import { Button, cls } from "./ds";
import { NumberField } from "./fields/NumberField";
import { DEFAULT_LINE_HEIGHT } from "../renderer/text";
import {
  applyStyleOps, characterStyleOf, createStyleOps, effectiveStyle, familyChoices, formatOps, paragraphStyleOf, sharedStyleOf, styleOps, updateStyleOps,
} from "./typographyOps";
import { makeDeleteTextStyleDefOp } from "../tools/ops";

// THE TYPOGRAPHY CONTROLS of the properties panel's Text section: font family
// (built-in stacks and the document's uploaded fonts), italic, line height and the
// shared text style. Size, weight and alignment stay in PropertiesPanel.
//
// Every choice is ONE gesture = one undo step. Editing a value of a text that has a
// shared style detaches it first (typographyOps.styleOps): the node keeps what it
// was drawn with, because a value the shared style overrides would change nothing.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const MIXED = "__mixed";

function same<T>(values: readonly T[]): T | typeof MIXED {
  return values.every((v) => Object.is(v, values[0])) ? values[0] : MIXED;
}

export function TypographyControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined);
  if (nodes.length === 0 || nodes.length !== selection.length || nodes.some((n) => n.kind !== "text" || !n.text)) return null;
  const styles = nodes.map((n) => effectiveStyle(scene, n)).filter((s): s is TextStyleLite => s !== undefined);
  if (styles.length !== nodes.length) return null;

  const choices = familyChoices(scene);
  const family = same(styles.map((s) => s.fontFamily === "" ? choices[0].value : s.fontFamily));
  const italic = same(styles.map((s) => s.italic === true));
  const lineHeight = same(styles.map((s) => (s.lineHeight > 0 ? s.lineHeight : DEFAULT_LINE_HEIGHT)));
  const shared = sharedStyleOf(scene, selection);
  const allStyles = Object.values(scene.textStyles).sort((a, b) => a.name.localeCompare(b.name));
  // The node-wide "Text style" and the paragraph styles are the same kind; character styles are separate.
  const styleList = allStyles.filter((d) => d.kind !== "character");
  const characterList = allStyles.filter((d) => d.kind === "character");
  const underline = same(styles.map((s) => s.underline === true));
  const strike = same(styles.map((s) => s.strikethrough === true));
  const tracking = same(styles.map((s) => s.letterSpacing ?? 0));
  const smallCaps = same(styles.map((s) => s.smallCaps === true));
  const script = same(styles.map((s) => s.script ?? ""));
  const hscale = same(styles.map((s) => Math.round((s.horizontalScale ?? 1) * 100)));
  const noKerning = same(styles.map((s) => s.noKerning === true));
  const features = same(styles.map((s) => s.fontFeatures ?? ""));
  const paragraphValue = paragraphStyleOf(scene, selection);
  const characterValue = characterStyleOf(scene, selection);
  const single = nodes.length === 1 ? nodes[0] : null;
  // A family that is neither built in nor uploaded (set by an agent or imported): still shown, so it is not lost.
  const known = family === MIXED || choices.some((c) => c.value === family);

  return (
    <div className="flex flex-col gap-2">
      <select aria-label="Font" className={cls.select} value={family}
        onChange={(e) => run(styleOps(scene, selection, { fontFamily: e.target.value }))}>
        {family === MIXED && <option value={MIXED} disabled>Mixed</option>}
        {!known && <option value={family}>{String(family)}</option>}
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      <div className="grid grid-cols-[auto_1fr] items-center gap-1.5">
        <Button aria-label="Italic" aria-pressed={italic === true} variant={italic === true ? "primary" : "secondary"}
          onPress={() => run(styleOps(scene, selection, { italic: italic !== true }))}>
          <span className="italic">I</span>
        </Button>
        <div className="col-span-2 flex gap-1.5">
          <Button aria-label="Underline" aria-pressed={underline === true} variant={underline === true ? "primary" : "secondary"}
            onPress={() => run(styleOps(scene, selection, { underline: underline !== true }))}>
            <span className="underline">U</span>
          </Button>
          <Button aria-label="Strikethrough" aria-pressed={strike === true} variant={strike === true ? "primary" : "secondary"}
            onPress={() => run(styleOps(scene, selection, { strikethrough: strike !== true }))}>
            <span className="line-through">S</span>
          </Button>
        </div>
        <div className="col-span-2 flex gap-1.5">
          <Button aria-label="Small caps" aria-pressed={smallCaps === true} variant={smallCaps === true ? "primary" : "secondary"}
            onPress={() => run(styleOps(scene, selection, { smallCaps: smallCaps !== true ? true : undefined }))}>
            <span className="text-[10px] font-semibold">Aa</span>
          </Button>
          <Button aria-label="Superscript" aria-pressed={script === "super"} variant={script === "super" ? "primary" : "secondary"}
            onPress={() => run(styleOps(scene, selection, { script: script === "super" ? undefined : "super" }))}>
            <span>x<sup className="text-[9px]">2</sup></span>
          </Button>
          <Button aria-label="Subscript" aria-pressed={script === "sub"} variant={script === "sub" ? "primary" : "secondary"}
            onPress={() => run(styleOps(scene, selection, { script: script === "sub" ? undefined : "sub" }))}>
            <span>x<sub className="text-[9px]">2</sub></span>
          </Button>
          <Button aria-label="Kerning off" aria-pressed={noKerning === true} variant={noKerning === true ? "primary" : "secondary"}
            onPress={() => run(styleOps(scene, selection, { noKerning: noKerning !== true ? true : undefined }))}>
            <span className="text-[10px]">AV</span>
          </Button>
        </div>
        <NumberField
          label="Width" minValue={10} suffix="%"
          value={hscale === MIXED ? NaN : hscale}
          placeholder={hscale === MIXED ? "Mixed" : undefined}
          onCommit={(v) => run(styleOps(scene, selection, { horizontalScale: v === 100 ? undefined : v / 100 }))}
        />
        <NumberField
          label="Tracking" suffix="px"
          value={tracking === MIXED ? NaN : tracking}
          placeholder={tracking === MIXED ? "Mixed" : undefined}
          onCommit={(v) => run(styleOps(scene, selection, { letterSpacing: v === 0 ? undefined : v }))}
        />
        <NumberField
          label="Line" minValue={0.5} suffix="×"
          value={lineHeight === MIXED ? NaN : lineHeight}
          placeholder={lineHeight === MIXED ? "Mixed" : undefined}
          onCommit={(v) => run(styleOps(scene, selection, { lineHeight: v }))}
        />
      </div>
      <input aria-label="OpenType features" className={cls.input} placeholder={features === MIXED ? "Mixed" : "OpenType: liga off, onum"} maxLength={128}
        key={String(features)} defaultValue={features === MIXED ? "" : features}
        onBlur={(e) => { const v = e.target.value.trim(); if (features !== MIXED && v !== features) run(styleOps(scene, selection, { fontFeatures: v === "" ? undefined : v })); }} />
      <div className="flex flex-col gap-1.5">
        <select aria-label="Text style" className={cls.select}
          value={shared === undefined ? MIXED : (shared ?? "")}
          onChange={(e) => run(applyStyleOps(scene, selection, e.target.value === "" ? null : e.target.value))}>
          {shared === undefined && <option value={MIXED} disabled>Mixed</option>}
          <option value="">No text style</option>
          {styleList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {(styleList.length > 0 || characterList.length > 0) && (
          <>
            <select aria-label="Paragraph style" className={cls.select}
              value={paragraphValue === undefined ? MIXED : paragraphValue}
              onChange={(e) => run(formatOps(scene, selection, { paragraph: e.target.value }))}>
              {paragraphValue === undefined && <option value={MIXED} disabled>Mixed</option>}
              <option value="">No paragraph style</option>
              {styleList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select aria-label="Character style" className={cls.select}
              value={characterValue === undefined ? MIXED : characterValue}
              onChange={(e) => run(formatOps(scene, selection, { character: e.target.value }))}>
              {characterValue === undefined && <option value={MIXED} disabled>Mixed</option>}
              <option value="">No character style</option>
              {characterList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </>
        )}
        <div className="flex flex-wrap gap-1.5">
          {single && !single.textStyleId && (
            <Button onPress={() => {
              const made = createStyleOps(scene, single, `Style ${styleList.length + 1}`);
              if (made) run(made.ops);
            }}>New style</Button>
          )}
          {single && single.textStyleId && scene.textStyles[single.textStyleId] && (
            <>
              <Button onPress={() => run(updateStyleOps(scene, single.textStyleId!, single))}>Update style</Button>
              <Button variant="danger" onPress={() => run([makeDeleteTextStyleDefOp(single.textStyleId!)])}>Delete style</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
