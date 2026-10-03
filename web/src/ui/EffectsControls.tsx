import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { IconButton, Section } from "./ds";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import { blurOf, blurOps, shadowOf, shadowOps } from "./effectOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

/**
 * La sezione EFFETTI: ombra e sfocatura del nodo selezionato (il primo, se sono
 * più d'uno: gli effetti non si riassumono come `fills` perché sono una lista).
 * Non conosce gesti: emette op tramite `run`, lo stesso `runGesture` del
 * pannello, quindi ogni modifica è UN passo di undo.
 *
 * L'ombra è una LISTA di (al più) un elemento: il "+" nell'intestazione la
 * aggiunge, il cestino sulla sua scheda la toglie -- le stesse due op di prima
 * (`enabled: true/false`), solo non più dietro una casella.
 */
export function EffectsControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  // Selettori che restituiscono primitivi/riferimenti stabili: il pannello si
  // ridisegna solo quando cambiano gli effetti del primo nodo selezionato.
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const shadow = shadowOf(first);
  const blur = blurOf(first);

  return (
    <Section
      title="Effetti"
      actions={
        shadow === undefined && (
          <IconButton
            icon="plus" label="Aggiungi ombra" size={24}
            onPress={() => run((ids) => shadowOps(ids, lookup, { enabled: true }))}
          />
        )
      }
    >
      <div className="flex flex-col gap-2">
        {shadow && (
          // La scheda dell'ombra: un riquadro a bordo sottile con il suo nome e
          // il cestino, come una riga di lista di un editor di design.
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
            <div className="flex h-6 items-center justify-between">
              <span className="text-[12px] font-medium text-fg">Ombra esterna</span>
              <IconButton
                icon="trash" label="Rimuovi ombra" size={24}
                onPress={() => run((ids) => shadowOps(ids, lookup, { enabled: false }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberField
                label="X" value={shadow.offsetX}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { offsetX: v }))}
              />
              <NumberField
                label="Y" value={shadow.offsetY}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { offsetY: v }))}
              />
              <NumberField
                label="Sfocatura" value={shadow.blur} minValue={0}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { blur: v }))}
              />
              <NumberField
                label="Opacità ombra" glyph="α" suffix="%" value={Math.round(shadow.color.a * 100)} minValue={0}
                onCommit={(v) => run((ids) => shadowOps(ids, lookup, { alpha: v / 100 }))}
              />
            </div>
            <ColorField
              label="Colore ombra" value={shadow.color}
              onCommit={(rgb) => run((ids) => shadowOps(ids, lookup, { rgb }))}
            />
          </div>
        )}
        <NumberField
          label="Sfoca livello" value={blur?.radius ?? 0} minValue={0}
          onCommit={(v) => run((ids) => blurOps(ids, lookup, v))}
        />
      </div>
    </Section>
  );
}
