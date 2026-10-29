import { useScene } from "@/store/store";
import { currentT } from "@/i18n";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { NoiseModeLite } from "@/store/types";
import { cls } from "@/ui/ds";
import { ColorField } from "@/ui/fields/ColorField";
import { NumberField } from "@/ui/fields/NumberField";
import {
  DEFAULT_NOISE, RAMP_DIRECTIONS, fxOf, glassOps, noiseOps, progressiveOf, progressiveOps, progressiveTargetOps, rampDirectionOf, textureOps,
  type RampDirection,
} from "@/ui/effectFxOps";

// Names the shared controls cannot translate on their own (options, text nodes). See docs/localization.md.
const tr = (key: string, vars?: Record<string, string | number>) => currentT().tx(key, vars);

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

type Run = (build: (ids: readonly string[]) => Op[]) => void;

const pct = (v: number) => Math.round(v * 100);

/**
 * Progressive blur, noise, texture and glass of the selected node (docs/effects.md). Part of
 * the Effects section; like the rest, every change is ONE undo step through `run`.
 */
export function EffectsFxControls({ run }: { run: Run }) {
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const layerRamp = progressiveOf(first, false);
  const backdropRamp = progressiveOf(first, true);
  // The panel shows one ramp at a time: the layer's if there is one, else the backdrop's.
  const ramp = layerRamp ?? backdropRamp;
  const rampBackground = layerRamp ? false : backdropRamp ? true : false;
  const noise = fxOf(first, "noise");
  const texture = fxOf(first, "texture");
  const glass = fxOf(first, "glass");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
        <select
          aria-label="Progressive blur"
          className={cls.select}
          value={ramp ? (rampBackground ? "background" : "layer") : ""}
          // Switching the target moves the ramp (same values) in one step.
          onChange={(e) => run((ids) => progressiveTargetOps(ids, lookup, (e.target.value || "none") as "none" | "layer" | "background"))}
        >
          <option value="">No progressive blur</option>
          <option value="layer">Progressive layer blur</option>
          <option value="background">Progressive background blur</option>
        </select>
        {ramp && (
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label="Start" value={ramp.startRadius} minValue={0}
              onCommit={(v) => run((ids) => progressiveOps(ids, lookup, rampBackground, { startRadius: v }))} />
            <NumberField label="End" value={ramp.endRadius} minValue={0}
              onCommit={(v) => run((ids) => progressiveOps(ids, lookup, rampBackground, { endRadius: v }))} />
            <select aria-label="Blur direction" className={`${cls.select} col-span-2`} value={rampDirectionOf(ramp)}
              onChange={(e) => {
                const d = RAMP_DIRECTIONS[e.target.value as RampDirection];
                if (d) run((ids) => progressiveOps(ids, lookup, rampBackground, d));
              }}>
              {rampDirectionOf(ramp) === "custom" && <option value="custom" disabled>{tr("Custom")}</option>}
              <option value="down">Top to bottom</option>
              <option value="up">Bottom to top</option>
              <option value="right">Left to right</option>
              <option value="left">Right to left</option>
            </select>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
        <select
          aria-label="Noise"
          className={cls.select}
          value={noise?.mode ?? ""}
          onChange={(e) => run((ids) => e.target.value === ""
            ? noiseOps(ids, lookup, { enabled: false })
            : noiseOps(ids, lookup, { mode: e.target.value as NoiseModeLite }))}
        >
          <option value="">No noise</option>
          <option value="mono">Mono noise</option>
          <option value="duo">Duo noise</option>
          <option value="multi">Multi noise</option>
        </select>
        {noise && (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField label="Grain" value={noise.size} minValue={0}
                onCommit={(v) => run((ids) => noiseOps(ids, lookup, { size: v }))} />
              <NumberField label="Density" glyph="%" suffix="%" value={pct(noise.density)} minValue={0}
                onCommit={(v) => run((ids) => noiseOps(ids, lookup, { density: v / 100 }))} />
              <NumberField label="Noise opacity" glyph="α" suffix="%" value={pct(noise.opacity)} minValue={0}
                onCommit={(v) => run((ids) => noiseOps(ids, lookup, { opacity: v / 100 }))} />
              <NumberField label="Seed" value={noise.seed} minValue={0}
                onCommit={(v) => run((ids) => noiseOps(ids, lookup, { seed: Math.max(0, Math.round(v)) }))} />
            </div>
            {noise.mode === "duo" && (
              <>
                <ColorField label="Noise color" value={noise.color}
                  onCommit={(rgb) => run((ids) => noiseOps(ids, lookup, { color: { ...rgb, a: 1 } }))} />
                <ColorField label="Noise color 2" value={noise.color2 ?? DEFAULT_NOISE.color2}
                  onCommit={(rgb) => run((ids) => noiseOps(ids, lookup, { color2: { ...rgb, a: 1 } }))} />
              </>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
        <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
          <input type="checkbox" aria-label="Texture" checked={texture !== undefined}
            onChange={(e) => run((ids) => textureOps(ids, lookup, { enabled: e.target.checked }))} />
          Texture
        </label>
        {texture && (
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label="Texture scale" value={texture.scale} minValue={0}
              onCommit={(v) => run((ids) => textureOps(ids, lookup, { scale: v }))} />
            <NumberField label="Texture intensity" suffix="%" value={pct(texture.intensity)} minValue={0}
              onCommit={(v) => run((ids) => textureOps(ids, lookup, { intensity: v / 100 }))} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
        <label className="flex items-center gap-2 text-[11px] text-fg-subtle">
          <input type="checkbox" aria-label="Glass" checked={glass !== undefined}
            onChange={(e) => run((ids) => glassOps(ids, lookup, { enabled: e.target.checked }))} />
          Glass
        </label>
        {glass && (
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label="Frost" value={glass.frost} minValue={0}
              onCommit={(v) => run((ids) => glassOps(ids, lookup, { frost: v }))} />
            <NumberField label="Light" suffix="%" value={pct(glass.light)} minValue={0}
              onCommit={(v) => run((ids) => glassOps(ids, lookup, { light: v / 100 }))} />
            <NumberField label="Light angle" suffix="°" value={glass.lightAngle}
              onCommit={(v) => run((ids) => glassOps(ids, lookup, { lightAngle: v }))} />
            <NumberField label="Grain" suffix="%" value={pct(glass.noise)} minValue={0}
              onCommit={(v) => run((ids) => glassOps(ids, lookup, { noise: v / 100 }))} />
          </div>
        )}
      </div>
    </div>
  );
}
