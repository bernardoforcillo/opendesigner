import { useScene } from "../store/store";
import type { FillLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import {
  fillKindOf, fillKindOps, gradientAngleOf, gradientAngleOps, gradientStopOps, type FillKind,
} from "./gradientOps";

const KINDS: { kind: FillKind; label: string }[] = [
  { kind: "solid", label: "Solido" },
  { kind: "linear", label: "Lineare" },
  { kind: "radial", label: "Radiale" },
];

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

/**
 * Il tipo del riempimento (solido / lineare / radiale) e, per un gradiente, i
 * due colori agli estremi e l'angolo. Non conosce gesti: emette op tramite
 * `run`, lo stesso `runGesture` del pannello, così un cambio di tipo è UN passo
 * di undo come ogni altra modifica.
 */
export function GradientControls({
  fill, run,
}: {
  fill: FillLite | null;
  run: (build: (ids: readonly string[]) => Op[]) => void;
}) {
  const kind = fillKindOf(fill);
  const g = fill?.gradient;
  const last = g ? g.stops.length - 1 : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label="Tipo di riempimento" className="flex gap-1">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            aria-pressed={kind === k.kind}
            onClick={() => run((ids) => fillKindOps(ids, lookup, k.kind))}
            className={
              "flex-1 rounded border px-1 py-0.5 text-xs " +
              (kind === k.kind
                ? "border-sky-500 bg-sky-50 text-sky-700"
                : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50")
            }
          >
            {k.label}
          </button>
        ))}
      </div>
      {g && (
        <>
          <ColorField
            label="Da"
            value={g.stops[0].color}
            onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, 0, rgb))}
          />
          <ColorField
            label="A"
            value={g.stops[last].color}
            onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, last, rgb))}
          />
          {g.kind === "linear" && (
            <NumberField
              label="Angolo"
              labelWidth="w-20"
              value={gradientAngleOf(fill)}
              onCommit={(v) => run((ids) => gradientAngleOps(ids, lookup, v))}
            />
          )}
        </>
      )}
    </div>
  );
}
