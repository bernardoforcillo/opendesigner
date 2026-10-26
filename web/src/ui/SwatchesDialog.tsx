import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { cmykToRgb, rgbToCmyk } from "@/color/cmyk";
import { swatchCmyk, swatchColor, swatchesOf } from "@/store/graphics";
import { applySwatchOps, createSwatchOps, deleteSwatchOps, swatchFromColor, updateSwatchOps } from "@/tools/swatches";
import { makeSetDocSettingsOp } from "@/tools/ops";
import type { VariableLite } from "@/store/types";
import { Button, cls } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";

// SWATCHES (document menu): the document's palette. A swatch is a named color — RGB, CMYK process, spot, or a tint of
// another swatch — that fills and strokes can USE: change the swatch and everything that uses it follows. Also the
// document's colour mode (RGB for screens, CMYK for print) and the output profile it is meant for. The conversions
// between RGB and CMYK are the plain device ones, not profile-managed: the profile is recorded (as the PDF output
// intent) but not applied. See docs/graphics-colour.md.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const PROFILES = ["FOGRA39", "FOGRA51", "SWOP v2", "GRACoL 2006", "Japan Color 2001 Coated", "sRGB IEC61966-2.1"];
const hex = (c: { r: number; g: number; b: number }) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });

function describe(v: VariableLite, base?: VariableLite): string {
  if (v.tintOf) return `${v.tint}% of ${base?.name ?? "?"}`;
  if (v.spotName) return `Spot · ${v.spotName}`;
  const k = swatchCmyk(v);
  return k ? `CMYK ${Math.round(k.c)} ${Math.round(k.m)} ${Math.round(k.y)} ${Math.round(k.k)}` : "RGB";
}

export function SwatchesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const [selected, setSelected] = useState<string | null>(null);
  if (!scene || !isOpen) return null;
  const swatches = isOpen ? swatchesOf(scene) : [];
  const cur = swatches.find((v) => v.id === selected) ?? null;
  const settings = scene.settings ?? {};
  const cmykMode = settings.colorMode === "cmyk";
  const curColor = cur ? swatchColor(scene, cur.id) : null;
  const curCmyk = cur ? swatchCmyk(cur) : null;
  const isTint = !!cur?.tintOf;

  function create(spec: Parameters<typeof createSwatchOps>[1]) {
    const made = createSwatchOps(scene!, spec);
    if (!made) return;
    run(made.ops);
    setSelected(made.id);
  }
  const firstFill = selection.map((id) => scene.nodes.get(id)).find((n) => n && n.fills[0])?.fills[0];

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[680px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label="Swatches" className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">Swatches</h2>

          <div className="grid grid-cols-2 gap-2">
            <select aria-label="Colour mode" className={cls.select} value={cmykMode ? "cmyk" : "rgb"}
              onChange={(e) => run([makeSetDocSettingsOp({ ...settings, colorMode: e.target.value === "cmyk" ? "cmyk" : undefined })])}>
              <option value="rgb">RGB (screens)</option>
              <option value="cmyk">CMYK (print)</option>
            </select>
            <input aria-label="Output profile" list="icc-profiles" className={cls.input} placeholder="Output profile (e.g. FOGRA39)" defaultValue={settings.iccProfile ?? ""} key={settings.iccProfile ?? ""}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (settings.iccProfile ?? "")) run([makeSetDocSettingsOp({ ...settings, iccProfile: v === "" ? undefined : v })]); }} />
            <datalist id="icc-profiles">{PROFILES.map((p) => <option key={p} value={p} />)}</datalist>
          </div>
          <p className="text-fg-subtle">
            {cmykMode ? "New swatches are CMYK. " : ""}The conversion between RGB and CMYK is the plain device one: the profile is recorded as the output condition, not applied.
          </p>

          <div className="grid grid-cols-[220px_1fr] gap-3">
            <div className="flex flex-col gap-2">
              <ul aria-label="Swatches" className="flex max-h-[300px] flex-col gap-px overflow-auto">
                {swatches.map((v) => {
                  const c = swatchColor(scene, v.id);
                  return (
                    <li key={v.id}>
                      <button type="button" aria-current={v.id === selected ? "true" : undefined}
                        className={"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left " + (v.id === selected ? "bg-accent-soft" : "hover:bg-surface-3")}
                        onClick={() => setSelected(v.id)}>
                        <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-sm border border-line-strong" style={{ background: c ? hex(c) : "transparent" }} />
                        <span className="min-w-0 flex-1 truncate">{v.name}</span>
                        <span className="shrink-0 text-[10px] text-fg-subtle">{v.spotName ? "spot" : v.tintOf ? `${v.tint}%` : swatchCmyk(v) ? "CMYK" : "RGB"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-col gap-1.5">
                <Button onPress={() => create(cmykMode ? { name: "New swatch", cmyk: { c: 0, m: 0, y: 0, k: 100 } } : { name: "New swatch", rgb: { r: 0.2, g: 0.4, b: 0.9 } })}>New swatch</Button>
                <Button isDisabled={!firstFill} onPress={() => { if (firstFill) create({ ...swatchFromColor(firstFill), ...(cmykMode ? { cmyk: rgbToCmyk(firstFill) } : {}) }); }}>New from the selected fill</Button>
                <Button isDisabled={!cur || isTint} onPress={() => cur && create({ name: `${cur.name} 50%`, tintOf: cur.id, tint: 50 })}>New tint of this swatch</Button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              {!cur || !curColor ? (
                <p className="text-fg-subtle">Select a swatch to edit it, or make one. Swatches can be used for any fill or stroke.</p>
              ) : (
                <>
                  <input aria-label="Swatch name" className={cls.input} defaultValue={cur.name} key={cur.id + ":name"} maxLength={80}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== cur.name) run(updateSwatchOps(scene, cur.id, { name: v })); }} />
                  {isTint ? (
                    <NumberField label="Tint" suffix="%" minValue={1} value={cur.tint ?? 100}
                      onCommit={(v) => run(updateSwatchOps(scene, cur.id, { tint: Math.min(100, Math.max(1, Math.round(v))) }))} />
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <input type="color" aria-label="Swatch colour" value={hex(curColor)}
                          onChange={(e) => { const rgb = fromHex(e.target.value); run(updateSwatchOps(scene, cur.id, curCmyk ? { cmyk: rgbToCmyk(rgb) } : { rgb })); }} />
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" aria-label="Defined in CMYK" checked={!!curCmyk}
                            onChange={(e) => run(e.target.checked ? updateSwatchOps(scene, cur.id, { cmyk: rgbToCmyk(curColor) }) : [...updateSwatchOps(scene, cur.id, { rgb: curColor })])} /> Defined in CMYK
                        </label>
                      </div>
                      {curCmyk && (
                        <div role="group" aria-label="CMYK" className="grid grid-cols-4 gap-1.5">
                          {(["c", "m", "y", "k"] as const).map((key) => (
                            <NumberField key={key} label={key.toUpperCase()} suffix="%" minValue={0} value={Math.round(curCmyk[key])}
                              onCommit={(v) => run(updateSwatchOps(scene, cur.id, { cmyk: { ...curCmyk, [key]: Math.min(100, Math.max(0, v)) } }))} />
                          ))}
                        </div>
                      )}
                      <input aria-label="Spot ink name" className={cls.input} placeholder="Spot ink (e.g. PANTONE 485 C) — empty for a process color" defaultValue={cur.spotName ?? ""} key={cur.id + ":spot"} maxLength={64}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (cur.spotName ?? "")) run(updateSwatchOps(scene, cur.id, { spotName: v })); }} />
                    </>
                  )}
                  <p className="text-fg-subtle">{describe(cur, cur.tintOf ? scene.variables[cur.tintOf] : undefined)}{curCmyk && !isTint ? ` · prints as ${hex(cmykToRgb(curCmyk))}` : ""}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button isDisabled={selection.length === 0} onPress={() => run(applySwatchOps(scene, selection, "fill", cur.id))}>Use for fill</Button>
                    <Button isDisabled={selection.length === 0} onPress={() => run(applySwatchOps(scene, selection, "stroke", cur.id))}>Use for stroke</Button>
                    <Button variant="danger" onPress={() => { run(deleteSwatchOps(scene, cur.id)); setSelected(null); }}>Delete</Button>
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
