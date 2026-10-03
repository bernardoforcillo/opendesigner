import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { LayoutAlignLite } from "../store/types";
import { wrapSelectionInFrame } from "../tools/wrapFrame";
import { IconButton, Section } from "./ds";
import { SegButtons, type SegOption } from "./ds/props-controls";
import { NumberField } from "./fields/NumberField";
import { autoLayoutOps } from "./autoLayoutOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

const DIRECTIONS: SegOption<"horizontal" | "vertical">[] = [
  { value: "horizontal", label: "Orizzontale", icon: "dirH" },
  { value: "vertical", label: "Verticale", icon: "dirV" },
];

// Gli allineamenti sono pittogrammi con una riga (il bordo o la mezzeria) e
// blocchi appoggiati: il disegno base vale per l'asse ORIZZONTALE, e `rotate`
// lo gira per quello verticale. L'asse principale è quello della direzione,
// il trasversale l'altro.
function aligns(rotate: boolean): SegOption<LayoutAlignLite>[] {
  return [
    { value: "start", label: "Inizio", icon: "alignStart", rotate },
    { value: "center", label: "Centro", icon: "alignCenter", rotate },
    { value: "end", label: "Fine", icon: "alignEnd", rotate },
    { value: "space-between", label: "Distribuito", icon: "alignBetween", rotate },
  ];
}

const checkbox = "size-3.5 shrink-0 cursor-pointer rounded accent-accent";

/**
 * La sezione AUTO LAYOUT del frame selezionato: acceso/spento (il "+" / "−"
 * nell'intestazione), direzione, spaziatura, padding, allineamenti e hug. Non
 * conosce gesti: emette op tramite `run`, lo stesso `runGesture` del pannello,
 * quindi ogni modifica è UN passo di undo. Ciò che ne risulta (le posizioni dei
 * figli) lo calcola il server.
 */
export function AutoLayoutControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const al = first?.autoLayout;
  const num = (key: "spacing" | "paddingLeft" | "paddingTop" | "paddingRight" | "paddingBottom", label: string) => (
    <NumberField
      label={label} value={al ? al[key] : 0} minValue={0}
      onCommit={(v) => run((ids) => autoLayoutOps(ids, lookup, { [key]: v }))}
    />
  );
  // Direzione orizzontale: l'asse principale è x, quello trasversale y.
  const horizontal = al?.direction !== "vertical";
  return (
    <Section
      title="Auto layout"
      bare={al === undefined}
      actions={
        al === undefined ? (
          <IconButton
            icon="plus" label="Aggiungi auto layout" size={24}
            onPress={() => run((ids) => autoLayoutOps(ids, lookup, { enabled: true }))}
          />
        ) : (
          <IconButton
            icon="minus" label="Rimuovi auto layout" size={24}
            onPress={() => run((ids) => autoLayoutOps(ids, lookup, { enabled: false }))}
          />
        )
      }
    >
      {al && (
        <div className="flex flex-col gap-2">
          <SegButtons
            label="Direzione" value={al.direction} options={DIRECTIONS}
            onPick={(direction) => run((ids) => autoLayoutOps(ids, lookup, { direction }))}
          />
          {num("spacing", "Spazio")}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-fg-subtle">Padding</span>
            <div className="grid grid-cols-2 gap-1.5">
              {num("paddingLeft", "Sx")}
              {num("paddingRight", "Dx")}
              {num("paddingTop", "Su")}
              {num("paddingBottom", "Giù")}
            </div>
          </div>
          <SegButtons
            label="Allineamento principale" showLabel value={al.mainAlign} options={aligns(!horizontal)}
            onPick={(mainAlign) => run((ids) => autoLayoutOps(ids, lookup, { mainAlign }))}
          />
          <SegButtons
            label="Allineamento trasversale" showLabel value={al.crossAlign}
            options={aligns(horizontal).filter((a) => a.value !== "space-between")}
            onPick={(crossAlign) => run((ids) => autoLayoutOps(ids, lookup, { crossAlign }))}
          />
          <div className="flex gap-4 text-[12px] text-fg-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox" className={checkbox} checked={al.hugWidth}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugWidth: e.target.checked }))}
              />
              Adatta largh.
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox" className={checkbox} checked={al.hugHeight}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugHeight: e.target.checked }))}
              />
              Adatta alt.
            </label>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * Per una selezione che NON è un frame: la stessa sezione, con il "+" che la
 * avvolge in un frame con auto layout (Shift+A). È lo stesso gesto della
 * scorciatoia.
 */
export function WrapInAutoLayoutButton() {
  return (
    <Section
      title="Auto layout"
      bare
      actions={
        <IconButton
          icon="plus" label="Aggiungi auto layout" shortcut="⇧A" size={24}
          onPress={() => wrapSelectionInFrame(true)}
        />
      }
    />
  );
}
