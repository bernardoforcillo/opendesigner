import { useEffect, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "../store/store";
import { isValidPageSetup, PAGE_PRESETS, setupOf } from "../store/docSettings";
import { makeSetDocSettingsOp, makeUpdatePageOp } from "../tools/ops";
import type { GuideLite, NumberStyle, PageLite } from "../store/types";
import { Button, cls } from "./ds";
import { NumberField } from "./fields/NumberField";

// THE PAGE SETUP DIALOG (page list → Page setup…): the sheet of a page -- size, margins, columns, bleed --
// and the document's baseline grid. A page with a size is paper: the editor draws it with its margins,
// columns and bleed, objects snap to those guides, and PDF / EPUB export it as that sheet. Size 0 is the
// unbounded canvas page everything used to be. See docs/publishing.md.

type Setup = Required<Pick<PageLite, "width" | "height" | "marginTop" | "marginRight" | "marginBottom" | "marginLeft" | "columns" | "gutter" | "bleed" | "slug">>;
// What belongs to ONE page only: its numbering section and its ruler guides.
interface Structure { sectionStart: boolean; numberStart: number; numberStyle: NumberStyle | ""; vguides: string; hguides: string }

const toSetup = (p: PageLite | undefined): Setup => ({
  width: p?.width ?? 0, height: p?.height ?? 0,
  marginTop: p?.marginTop ?? 0, marginRight: p?.marginRight ?? 0, marginBottom: p?.marginBottom ?? 0, marginLeft: p?.marginLeft ?? 0,
  columns: p?.columns ?? 0, gutter: p?.gutter ?? 0, bleed: p?.bleed ?? 0, slug: p?.slug ?? 0,
});

const guideText = (p: PageLite | undefined, vertical: boolean) => (p?.guides ?? []).filter((g) => g.vertical === vertical).map((g) => g.position).join(", ");
const toStructure = (p: PageLite | undefined): Structure => ({
  sectionStart: p?.sectionStart === true, numberStart: p?.numberStart ?? 0, numberStyle: p?.numberStyle ?? "",
  vguides: guideText(p, true), hguides: guideText(p, false),
});
/** "40, 120.5" -> [40, 120.5]; anything that is not a number is left out. */
const parseGuides = (text: string, vertical: boolean): GuideLite[] =>
  text.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite).map((position) => ({ vertical, position }));

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

/** The preset whose size (either orientation) matches, or "custom". */
function presetOf(w: number, h: number): string {
  const hit = PAGE_PRESETS.find((p) => (p.width === w && p.height === h) || (p.width === h && p.height === w));
  return hit ? hit.id : "custom";
}

export function PageSetupDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  const currentPageId = useScene((s) => s.currentPageId);
  const page = isOpen ? scene?.pages?.find((p) => p.id === currentPageId) ?? scene?.pages?.[0] : undefined;
  const [setup, setSetup] = useState<Setup>(toSetup(page));
  const [baselineIncrement, setBaselineIncrement] = useState(0);
  const [baselineStart, setBaselineStart] = useState(0);
  const [facing, setFacing] = useState(false);
  const [structure, setStructure] = useState<Structure>(toStructure(page));
  const [scope, setScope] = useState<"page" | "all">("page");

  // Opening the dialog starts from the page on screen.
  useEffect(() => {
    if (!isOpen) return;
    setSetup(toSetup(page));
    setBaselineIncrement(scene?.settings?.baselineIncrement ?? 0);
    setBaselineStart(scene?.settings?.baselineStart ?? 0);
    setFacing(scene?.settings?.facingPages === true);
    setStructure(toStructure(page));
    setScope("page");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, page?.id]);

  if (!scene || !page) return null;
  const guides = [...parseGuides(structure.vguides, true), ...parseGuides(structure.hguides, false)];
  const valid = isValidPageSetup({ ...setup, numberStart: structure.numberStart, guides });
  const preset = presetOf(setup.width, setup.height);
  const landscape = setup.width > setup.height;
  const set = (patch: Partial<Setup>) => setSetup((s) => ({ ...s, ...patch }));

  function apply() {
    if (!scene || !page || !valid) return;
    const targets = scope === "all" ? scene.pages : [page];
    const ops = targets.map((p) => makeUpdatePageOp((() => {
      const next: PageLite = { ...p, ...clearSetup(), ...setupOf({ id: p.id, name: p.name, ...setup }) };
      if (p.id !== page.id || p.isMaster) return next;
      // The numbering section and the guides are the page on screen's alone.
      return {
        ...next, sectionStart: structure.sectionStart || undefined, numberStart: structure.numberStart || undefined,
        numberStyle: structure.numberStyle || undefined, guides: guides.length > 0 ? guides : undefined,
      };
    })()));
    const cur = scene.settings ?? {};
    if (baselineIncrement !== (cur.baselineIncrement ?? 0) || baselineStart !== (cur.baselineStart ?? 0) || facing !== (cur.facingPages === true)) {
      ops.push(makeSetDocSettingsOp({
        ...cur,
        baselineIncrement: baselineIncrement || undefined,
        baselineStart: baselineStart || undefined,
        facingPages: facing || undefined,
      }));
    }
    run(ops);
    onOpenChange(false);
  }

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[520px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Page setup" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Page setup · {page.name || "Page"}</h2>
          <p className="text-fg-subtle">
            A page with a size is a sheet of paper: it is drawn with its margins, columns and bleed, things snap to them, and PDF and EPUB
            export it as that sheet. Size 0 is an unbounded canvas. Units are points (1/72 in).
          </p>

          <div className="grid grid-cols-[1fr_auto] items-center gap-2">
            <select aria-label="Page size" className={cls.select} value={preset}
              onChange={(e) => {
                const p = PAGE_PRESETS.find((x) => x.id === e.target.value);
                if (e.target.value === "none") set({ width: 0, height: 0 });
                else if (p) set(landscape ? { width: p.height, height: p.width } : { width: p.width, height: p.height });
              }}>
              <option value="none">No size (unbounded canvas)</option>
              {preset === "custom" && setup.width > 0 && <option value="custom">Custom</option>}
              {PAGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.width} × {p.height})</option>)}
            </select>
            <Button aria-pressed={landscape} isDisabled={setup.width === 0 || setup.height === 0} onPress={() => set({ width: setup.height, height: setup.width })}>
              {landscape ? "Landscape" : "Portrait"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Width" minValue={0} value={setup.width} onCommit={(v) => set({ width: v })} />
            <NumberField label="Height" minValue={0} value={setup.height} onCommit={(v) => set({ height: v })} />
          </div>

          <span className={cls.label}>Margins</span>
          <div className="grid grid-cols-4 gap-2">
            <NumberField label="Top" minValue={0} value={setup.marginTop} onCommit={(v) => set({ marginTop: v })} />
            <NumberField label={facing ? "Outside" : "Right"} minValue={0} value={setup.marginRight} onCommit={(v) => set({ marginRight: v })} />
            <NumberField label="Bottom" minValue={0} value={setup.marginBottom} onCommit={(v) => set({ marginBottom: v })} />
            <NumberField label={facing ? "Inside" : "Left"} minValue={0} value={setup.marginLeft} onCommit={(v) => set({ marginLeft: v })} />
          </div>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={facing} onChange={(e) => setFacing(e.target.checked)} /> Facing pages (odd pages on the right, inside and outside margins)
          </label>

          <span className={cls.label}>Columns and bleed</span>
          <div className="grid grid-cols-3 gap-2">
            <NumberField label="Columns" minValue={0} value={setup.columns} onCommit={(v) => set({ columns: Math.round(v) })} />
            <NumberField label="Gutter" minValue={0} value={setup.gutter} onCommit={(v) => set({ gutter: v })} />
            <NumberField label="Bleed" minValue={0} value={setup.bleed} onCommit={(v) => set({ bleed: v })} />
          </div>
          <NumberField label="Slug" minValue={0} value={setup.slug} onCommit={(v) => set({ slug: v })} />

          {!page.isMaster && (
            <>
              <span className={cls.label}>Numbering (this page)</span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={structure.sectionStart} onChange={(e) => setStructure((x) => ({ ...x, sectionStart: e.target.checked }))} /> Start a new section here
              </label>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Start at" minValue={0} value={structure.numberStart} onCommit={(v) => setStructure((x) => ({ ...x, numberStart: Math.round(v) }))} />
                <select aria-label="Number style" className={cls.select} value={structure.numberStyle}
                  onChange={(e) => setStructure((x) => ({ ...x, numberStyle: e.target.value as NumberStyle | "" }))}>
                  <option value="">1, 2, 3</option><option value="i">i, ii, iii</option><option value="I">I, II, III</option>
                  <option value="a">a, b, c</option><option value="A">A, B, C</option>
                </select>
              </div>
            </>
          )}
          <span className={cls.label}>Guides (this page; in points, comma separated)</span>
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="Vertical guides" placeholder="Vertical: 40, 300" className={cls.input} value={structure.vguides} onChange={(e) => setStructure((x) => ({ ...x, vguides: e.target.value }))} />
            <input aria-label="Horizontal guides" placeholder="Horizontal: 80" className={cls.input} value={structure.hguides} onChange={(e) => setStructure((x) => ({ ...x, hguides: e.target.value }))} />
          </div>

          <span className={cls.label}>Baseline grid (the whole document)</span>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Every" minValue={0} value={baselineIncrement} onCommit={setBaselineIncrement} />
            <NumberField label="Start" minValue={0} value={baselineStart} onCommit={setBaselineStart} />
          </div>

          <div role="radiogroup" aria-label="Apply to" className="flex gap-4">
            {([["page", "This page"], ["all", `All ${scene.pages.length} pages (masters too)`]] as const).map(([id, label]) => (
              <label key={id} className="flex items-center gap-1.5">
                <input type="radio" name="scope" checked={scope === id} onChange={() => setScope(id)} /> {label}
              </label>
            ))}
          </div>

          {!valid && <p role="alert" className="text-danger">These values do not fit: margins must leave room on the sheet, and columns with their gutters must fit between the margins.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="primary" isDisabled={!valid} onPress={apply}>Apply</Button>
            <Button onPress={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// The setup fields of a page, all unset: spread first so a field the dialog sets to 0 really goes away.
function clearSetup(): Partial<PageLite> {
  return { width: undefined, height: undefined, marginTop: undefined, marginRight: undefined, marginBottom: undefined, marginLeft: undefined, columns: undefined, gutter: undefined, bleed: undefined, slug: undefined };
}
