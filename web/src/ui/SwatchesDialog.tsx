import { useRef, useState } from "react";
import { type Translator, useT } from "@/i18n";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useScene } from "@/store/store";
import { useCmykConverter } from "@/color/useCmykConverter";
import { loadProfile, MAX_ICC_BYTES, wrapIccFile } from "@/color/profileAsset";
import { uploadAsset } from "@/rpc/assets";
import {
  applyGradientSwatchOps, createGradientSwatchOps, deleteGradientSwatchOps, gradientCss, gradientSwatchesOf, gradientSwatchFromNodeOps, renameGradientSwatchOps,
} from "@/tools/gradientSwatches";
import { swatchCmyk, swatchColor, swatchesOf } from "@/store/graphics";
import { applySwatchOps, createSwatchOps, deleteSwatchOps, swatchFromColor, updateSwatchOps } from "@/tools/swatches";
import { makeSetDocSettingsOp } from "@/tools/ops";
import type { VariableLite } from "@/store/types";
import { Button, cls } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";

// SWATCHES (document menu): the document's palette. A swatch is a named color — RGB, CMYK process, spot, or a tint of
// another swatch — that fills and strokes can USE: change the swatch and everything that uses it follows. Also the
// document's colour mode (RGB for screens, CMYK for print) and the output profile it is meant for: a name, and an ICC
// profile file that, once loaded, the RGB <-> CMYK conversions go through and the PDF embeds as its output intent.
// Without a (readable) profile the conversions are the plain device ones. Gradient swatches are shared paint styles
// whose paint is a gradient. See docs/color-management.md and docs/graphics-colour.md.

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

function describe(t: Translator["t"], v: VariableLite, base?: VariableLite): string {
  if (v.tintOf) return t("{tint}% of {name}", { tint: v.tint ?? 100, name: base?.name ?? "?" });
  if (v.spotName) return t("Spot · {name}", { name: v.spotName });
  const k = swatchCmyk(v);
  return k ? `CMYK ${Math.round(k.c)} ${Math.round(k.m)} ${Math.round(k.y)} ${Math.round(k.k)}` : "RGB";
}

export function SwatchesDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useT();
  const conv = useCmykConverter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [profileError, setProfileError] = useState(false);
  const [gradFrom, setGradFrom] = useState("");
  const [gradTo, setGradTo] = useState("");
  const [gradSel, setGradSel] = useState<string | null>(null);
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
  // The profile file: checked as an ICC profile here, stored in the document's assets (wrapped, see color/profileAsset.ts),
  // and named by the document's settings; the name it carries fills the output condition when that is empty.
  async function loadFile(file: File | undefined) {
    if (!file || !scene) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loaded = bytes.length <= MAX_ICC_BYTES ? loadProfile(bytes) : null;
      if (!loaded) { setProfileError(true); return; }
      const ref = await uploadAsset(scene.id, new Blob([wrapIccFile(bytes) as BlobPart]));
      setProfileError(false);
      const current = useScene.getState().scene?.settings ?? {};
      run([makeSetDocSettingsOp({ ...current, iccProfileAsset: ref.hash, ...(!current.iccProfile && loaded.managed?.description ? { iccProfile: loaded.managed.description.slice(0, 64) } : {}) })]);
    } catch { setProfileError(true); }
  }
  const gradients = gradientSwatchesOf(scene);
  const curGrad = gradients.find((g) => g.id === gradSel) ?? null;
  const gradStart = gradFrom || swatches[0]?.id || "", gradEnd = gradTo || swatches[1]?.id || swatches[0]?.id || "";
  const selectedGradientNode = selection.map((id) => scene.nodes.get(id)).find((n) => n?.fills[0]?.gradient);
  function createGradient(made: { ops: Parameters<typeof run>[0]; id: string } | null) {
    if (!made) return;
    run(made.ops);
    setGradSel(made.id);
  }
  const firstFill = selection.map((id) => scene.nodes.get(id)).find((n) => n && n.fills[0])?.fills[0];

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={onOpenChange} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Modal className="max-h-[85vh] w-full max-w-[680px] overflow-auto rounded-xl bg-raised p-4 text-[13px] text-fg shadow-pop">
        <Dialog aria-label={t("Swatches")} className="flex flex-col gap-3 outline-none">
          <h2 className="text-[14px] font-semibold">{t("Swatches")}</h2>

          <div className="grid grid-cols-2 gap-2">
            <select aria-label={t("Colour mode")} className={cls.select} value={cmykMode ? "cmyk" : "rgb"}
              onChange={(e) => run([makeSetDocSettingsOp({ ...settings, colorMode: e.target.value === "cmyk" ? "cmyk" : undefined })])}>
              <option value="rgb">{t("RGB (screens)")}</option>
              <option value="cmyk">{t("CMYK (print)")}</option>
            </select>
            <input aria-label={t("Output profile")} list="icc-profiles" className={cls.input} placeholder={t("Output profile (e.g. FOGRA39)")} defaultValue={settings.iccProfile ?? ""} key={settings.iccProfile ?? ""}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (settings.iccProfile ?? "")) run([makeSetDocSettingsOp({ ...settings, iccProfile: v === "" ? undefined : v })]); }} />
            <datalist id="icc-profiles">{PROFILES.map((p) => <option key={p} value={p} />)}</datalist>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".icc,.icm" aria-label={t("Load ICC profile")} className="hidden" onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }} />
            <Button onPress={() => fileRef.current?.click()}>{t("Load ICC profile")}</Button>
            {settings.iccProfileAsset && <Button onPress={() => { setProfileError(false); run([makeSetDocSettingsOp({ ...settings, iccProfileAsset: undefined })]); }}>{t("Remove ICC profile")}</Button>}
            {profileError && <span role="alert" className="text-danger">{t("That file is not an ICC profile.")}</span>}
          </div>
          <p className="text-fg-subtle">
            {cmykMode ? t("New swatches are CMYK.") + " " : ""}
            {conv.managed ? t("RGB and CMYK are converted through the document's ICC profile.")
              : settings.iccProfileAsset ? t("The profile is embedded in the PDF, but its tables cannot be read here: the conversion stays the plain device one.")
              : t("The conversion between RGB and CMYK is the plain device one: load your printer's ICC profile to apply it.")}
          </p>

          <div className="grid grid-cols-[220px_1fr] gap-3">
            <div className="flex flex-col gap-2">
              <ul aria-label={t("Swatches")} className="flex max-h-[300px] flex-col gap-px overflow-auto">
                {swatches.map((v) => {
                  const c = swatchColor(scene, v.id);
                  return (
                    <li key={v.id}>
                      <button type="button" aria-current={v.id === selected ? "true" : undefined}
                        className={"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left " + (v.id === selected ? "bg-accent-soft" : "hover:bg-surface-3")}
                        onClick={() => setSelected(v.id)}>
                        <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-sm border border-line-strong" style={{ background: c ? hex(c) : "transparent" }} />
                        <span className="min-w-0 flex-1 truncate">{v.name}</span>
                        <span className="shrink-0 text-[10px] text-fg-subtle">{v.spotName ? t("spot") : v.tintOf ? `${v.tint}%` : swatchCmyk(v) ? "CMYK" : "RGB"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-col gap-1.5">
                <Button onPress={() => create(cmykMode ? { name: t("New swatch"), cmyk: { c: 0, m: 0, y: 0, k: 100 } } : { name: t("New swatch"), rgb: { r: 0.2, g: 0.4, b: 0.9 } })}>{t("New swatch")}</Button>
                <Button isDisabled={!firstFill} onPress={() => { if (firstFill) create({ ...swatchFromColor(firstFill), ...(cmykMode ? { cmyk: conv.rgbToCmyk(firstFill) } : {}) }); }}>{t("New from the selected fill")}</Button>
                <Button isDisabled={!cur || isTint} onPress={() => cur && create({ name: t("{name} 50%", { name: cur.name }), tintOf: cur.id, tint: 50 })}>{t("New tint of this swatch")}</Button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              {!cur || !curColor ? (
                <p className="text-fg-subtle">{t("Select a swatch to edit it, or make one. Swatches can be used for any fill or stroke.")}</p>
              ) : (
                <>
                  <input aria-label={t("Swatch name")} className={cls.input} defaultValue={cur.name} key={cur.id + ":name"} maxLength={80}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== cur.name) run(updateSwatchOps(scene, cur.id, { name: v })); }} />
                  {isTint ? (
                    <NumberField label={t("Tint")} suffix="%" minValue={1} value={cur.tint ?? 100}
                      onCommit={(v) => run(updateSwatchOps(scene, cur.id, { tint: Math.min(100, Math.max(1, Math.round(v))) }))} />
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <input type="color" aria-label={t("Swatch colour")} value={hex(curColor)}
                          onChange={(e) => { const rgb = fromHex(e.target.value); run(updateSwatchOps(scene, cur.id, curCmyk ? { cmyk: conv.rgbToCmyk(rgb) } : { rgb })); }} />
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" aria-label={t("Defined in CMYK")} checked={!!curCmyk}
                            onChange={(e) => run(e.target.checked ? updateSwatchOps(scene, cur.id, { cmyk: conv.rgbToCmyk(curColor) }) : [...updateSwatchOps(scene, cur.id, { rgb: curColor })])} /> {t("Defined in CMYK")}
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
                      <input aria-label={t("Spot ink name")} className={cls.input} placeholder={t("Spot ink (e.g. PANTONE 485 C) — empty for a process color")} defaultValue={cur.spotName ?? ""} key={cur.id + ":spot"} maxLength={64}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (cur.spotName ?? "")) run(updateSwatchOps(scene, cur.id, { spotName: v })); }} />
                    </>
                  )}
                  <p className="text-fg-subtle">{describe(t, cur, cur.tintOf ? scene.variables[cur.tintOf] : undefined)}{curCmyk && !isTint ? ` · ${t("prints as {color}", { color: hex(conv.cmykToRgb(curCmyk)) })}` : ""}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button isDisabled={selection.length === 0} onPress={() => run(applySwatchOps(scene, selection, "fill", cur.id))}>{t("Use for fill")}</Button>
                    <Button isDisabled={selection.length === 0} onPress={() => run(applySwatchOps(scene, selection, "stroke", cur.id))}>{t("Use for stroke")}</Button>
                    <Button variant="danger" onPress={() => { run(deleteSwatchOps(scene, cur.id)); setSelected(null); }}>{t("Delete")}</Button>
                  </div>
                </>
              )}
            </div>
          </div>
          <section aria-label={t("Gradient swatches")} className="flex flex-col gap-2 border-t border-line pt-3">
            <h3 className="text-[13px] font-semibold">{t("Gradient swatches")}</h3>
            {gradients.length === 0 ? <p className="text-fg-subtle">{t("No gradient swatches yet.")}</p> : (
              <ul aria-label={t("Gradient swatches")} className="flex max-h-[160px] flex-col gap-px overflow-auto">
                {gradients.map((g) => (
                  <li key={g.id}>
                    <button type="button" aria-current={g.id === gradSel ? "true" : undefined}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${g.id === gradSel ? "bg-accent-soft" : "hover:bg-surface-3"}`}
                      onClick={() => setGradSel(g.id)}>
                      <span aria-hidden="true" className="h-4 w-10 shrink-0 rounded-sm border border-line-strong" style={{ background: gradientCss(g) }} />
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label={t("Gradient start")} className={cls.select} value={gradStart} onChange={(e) => setGradFrom(e.target.value)}>
                {swatches.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <select aria-label={t("Gradient end")} className={cls.select} value={gradEnd} onChange={(e) => setGradTo(e.target.value)}>
                {swatches.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <Button isDisabled={swatches.length === 0}
                onPress={() => createGradient(createGradientSwatchOps(scene, { name: `${scene.variables[gradStart]?.name ?? ""} → ${scene.variables[gradEnd]?.name ?? ""}`, stops: [{ swatchId: gradStart }, { swatchId: gradEnd }] }))}>
                {t("New gradient")}
              </Button>
              <Button isDisabled={!selectedGradientNode} onPress={() => selectedGradientNode && createGradient(gradientSwatchFromNodeOps(selectedGradientNode, `${t("New gradient")} ${gradients.length + 1}`))}>
                {t("New gradient from the selected fill")}
              </Button>
            </div>
            {curGrad && (
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label={t("Gradient name")} className={cls.input} defaultValue={curGrad.name} key={curGrad.id + ":name"} maxLength={80}
                  onBlur={(e) => run(renameGradientSwatchOps(scene, curGrad.id, e.target.value))} />
                <Button isDisabled={selection.length === 0} onPress={() => run(applyGradientSwatchOps(scene, selection, "fill", curGrad.id))}>{t("Use for fill")}</Button>
                <Button isDisabled={selection.length === 0} onPress={() => run(applyGradientSwatchOps(scene, selection, "stroke", curGrad.id))}>{t("Use for stroke")}</Button>
                <Button variant="danger" onPress={() => { run(deleteGradientSwatchOps(scene, curGrad.id)); setGradSel(null); }}>{t("Delete")}</Button>
              </div>
            )}
          </section>
          <div className="flex justify-end"><Button onPress={() => onOpenChange(false)}>{t("Done")}</Button></div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
