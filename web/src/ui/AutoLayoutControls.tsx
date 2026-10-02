import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { LayoutAlignLite } from "../store/types";
import { wrapSelectionInFrame } from "../tools/wrapFrame";
import { NumberField } from "./fields/NumberField";
import { autoLayoutOps } from "./autoLayoutOps";

const lookup = (id: string) => useScene.getState().scene?.nodes[id];

const MAIN_ALIGNS: { v: LayoutAlignLite; label: string }[] = [
  { v: "start", label: "Inizio" }, { v: "center", label: "Centro" },
  { v: "end", label: "Fine" }, { v: "space-between", label: "Distribuito" },
];
const CROSS_ALIGNS = MAIN_ALIGNS.filter((a) => a.v !== "space-between");

function Segmented<T extends string>({
  label, value, options, onPick,
}: {
  label: string;
  value: T | undefined;
  options: { v: T; label: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={value === o.v}
          onClick={() => onPick(o.v)}
          className={
            "flex-1 rounded border px-1 py-0.5 text-xs " +
            (value === o.v
              ? "border-sky-500 bg-sky-50 text-sky-700"
              : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * L'auto layout del frame selezionato: acceso/spento, direzione, spaziatura,
 * padding, allineamenti e hug. Non conosce gesti: emette op tramite `run`, lo
 * stesso `runGesture` del pannello, quindi ogni modifica è UN passo di undo.
 * Ciò che ne risulta (le posizioni dei figli) lo calcola il server.
 */
export function AutoLayoutControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes[s.selection[0]] : undefined));
  const al = first?.autoLayout;
  const num = (key: "spacing" | "paddingLeft" | "paddingTop" | "paddingRight" | "paddingBottom", label: string, w?: string) => (
    <NumberField
      label={label} labelWidth={w} value={al ? al[key] : 0} minValue={0}
      onCommit={(v) => run((ids) => autoLayoutOps(ids, lookup, { [key]: v }))}
    />
  );
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={al !== undefined}
          onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { enabled: e.target.checked }))}
        />
        Auto layout
      </label>
      {al && (
        <>
          <Segmented
            label="Direzione" value={al.direction}
            options={[{ v: "horizontal", label: "Orizzontale" }, { v: "vertical", label: "Verticale" }]}
            onPick={(direction) => run((ids) => autoLayoutOps(ids, lookup, { direction }))}
          />
          {num("spacing", "Spazio", "w-20")}
          <div className="text-xs text-neutral-500">Padding</div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            {num("paddingLeft", "Sx")}
            {num("paddingRight", "Dx")}
            {num("paddingTop", "Su")}
            {num("paddingBottom", "Giù")}
          </div>
          <Segmented
            label="Allineamento principale" value={al.mainAlign} options={MAIN_ALIGNS}
            onPick={(mainAlign) => run((ids) => autoLayoutOps(ids, lookup, { mainAlign }))}
          />
          <Segmented
            label="Allineamento trasversale" value={al.crossAlign} options={CROSS_ALIGNS}
            onPick={(crossAlign) => run((ids) => autoLayoutOps(ids, lookup, { crossAlign }))}
          />
          <div className="flex gap-3 text-sm text-neutral-700">
            <label className="flex items-center gap-1">
              <input
                type="checkbox" checked={al.hugWidth}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugWidth: e.target.checked }))}
              />
              Adatta largh.
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox" checked={al.hugHeight}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugHeight: e.target.checked }))}
              />
              Adatta alt.
            </label>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Per una selezione che NON è un frame: avvolgila in un frame con auto layout
 * (Shift+A). È lo stesso gesto della scorciatoia.
 */
export function WrapInAutoLayoutButton() {
  return (
    <button
      type="button"
      onClick={() => wrapSelectionInFrame(true)}
      className="w-full rounded border border-neutral-200 px-2 py-1 text-sm hover:bg-neutral-50"
    >
      Aggiungi auto layout
    </button>
  );
}
