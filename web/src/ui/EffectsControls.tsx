import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import { blurOf, blurOps, shadowOf, shadowOps } from "./effectOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

/**
 * Ombra e sfocatura del nodo selezionato (il primo, se sono più d'uno: gli
 * effetti non si riassumono come `fills` perché sono una lista). Non conosce
 * gesti: emette op tramite `run`, lo stesso `runGesture` del pannello, quindi
 * ogni modifica è UN passo di undo.
 */
export function EffectsControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  // Selettori che restituiscono primitivi/riferimenti stabili: il pannello si
  // ridisegna solo quando cambiano gli effetti del primo nodo selezionato.
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const shadow = shadowOf(first);
  const blur = blurOf(first);

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={shadow !== undefined}
          onChange={(e) => run((ids) => shadowOps(ids, lookup, { enabled: e.target.checked }))}
        />
        Ombra
      </label>
      {shadow && (
        <>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            <NumberField
              label="X" value={shadow.offsetX}
              onCommit={(v) => run((ids) => shadowOps(ids, lookup, { offsetX: v }))}
            />
            <NumberField
              label="Y" value={shadow.offsetY}
              onCommit={(v) => run((ids) => shadowOps(ids, lookup, { offsetY: v }))}
            />
          </div>
          <NumberField
            label="Sfocatura" labelWidth="w-28" value={shadow.blur} minValue={0}
            onCommit={(v) => run((ids) => shadowOps(ids, lookup, { blur: v }))}
          />
          <NumberField
            label="Opacità ombra" labelWidth="w-28" value={Math.round(shadow.color.a * 100)} minValue={0}
            onCommit={(v) => run((ids) => shadowOps(ids, lookup, { alpha: v / 100 }))}
          />
          <ColorField
            label="Colore ombra" labelWidth="w-28" value={shadow.color}
            onCommit={(rgb) => run((ids) => shadowOps(ids, lookup, { rgb }))}
          />
        </>
      )}
      <NumberField
        label="Sfoca livello" labelWidth="w-28" value={blur?.radius ?? 0} minValue={0}
        onCommit={(v) => run((ids) => blurOps(ids, lookup, v))}
      />
    </div>
  );
}
