import type { ReactNode } from "react";
import { useScene } from "../store/store";
import type { FillLite } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { CHECKER, SegButtons } from "./ds/props-controls";
import { ColorField } from "./fields/ColorField";
import { NumberField } from "./fields/NumberField";
import {
  fillKindOf, fillKindOps, gradientAngleOf, gradientAngleOps, gradientStopOps, type FillKind,
} from "./gradientOps";

const KINDS: { value: FillKind; label: string }[] = [
  { value: "solid", label: "Solido" },
  { value: "linear", label: "Lineare" },
  { value: "radial", label: "Radiale" },
];

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

// Un colore del modello (float 0..1, alfa compresa) come valore CSS. Qui e non
// in ColorField perché serve SOLO a disegnare la striscia: il campo esadecimale
// resta l'unico "bordo UI" per i valori che l'utente legge e scrive.
function css(c: { r: number; g: number; b: number; a: number }): string {
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${ch(c.r)} ${ch(c.g)} ${ch(c.b)} / ${c.a})`;
}

/**
 * Il tipo del riempimento (solido / lineare / radiale) e, per un gradiente,
 * l'anteprima, i due colori agli estremi e l'angolo. Non conosce gesti: emette
 * op tramite `run`, lo stesso `runGesture` del pannello, così un cambio di tipo
 * è UN passo di undo come ogni altra modifica.
 *
 * La STRISCIA è un'anteprima vera: gli stessi stop del modello, in ordine di
 * posizione, sopra la scacchiera (si legge anche la trasparenza). Le maniglie
 * sotto la striscia sono i punti degli stop, colorati come lo stop -- sono
 * decorative: i colori si cambiano dai campi sotto, che portano anche il nome
 * accessibile.
 */
export function GradientControls({
  fill, run, solid,
}: {
  fill: FillLite | null;
  run: (build: (ids: readonly string[]) => Op[]) => void;
  /** Il campo colore del riempimento SOLIDO: sta sotto i segmenti, e c'è solo senza gradiente. */
  solid?: ReactNode;
}) {
  const kind = fillKindOf(fill);
  const g = fill?.gradient;
  const last = g ? g.stops.length - 1 : 0;
  const ordered = g ? [...g.stops].sort((a, b) => a.position - b.position) : [];
  return (
    <div className="flex flex-col gap-2">
      <SegButtons
        label="Tipo di riempimento"
        value={kind}
        options={KINDS}
        onPick={(k) => run((ids) => fillKindOps(ids, lookup, k))}
      />
      {!g && solid}
      {g && (
        <>
          {/* Il padding laterale lascia spazio alle maniglie ai due estremi. */}
          <div className="px-1.5 pb-2 pt-0.5" aria-hidden="true">
            <div className="relative h-6">
              <div className="absolute inset-0 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--line-strong)]">
                <div className="absolute inset-0" style={{ background: CHECKER }} />
                <div
                  className="absolute inset-0"
                  style={{ background: `linear-gradient(90deg, ${ordered.map((s) => `${css(s.color)} ${s.position * 100}%`).join(", ")})` }}
                />
              </div>
              {ordered.map((s, i) => (
                <span
                  key={i}
                  style={{ left: `${s.position * 100}%` }}
                  className="absolute top-full size-3.5 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-surface shadow-[0_0_0_2px_var(--surface),0_0_0_3px_var(--line-strong),0_1px_3px_rgb(0_0_0/0.3)]"
                >
                  <span className="absolute inset-0" style={{ background: CHECKER }} />
                  <span className="absolute inset-0" style={{ background: css({ ...s.color, a: 1 }) }} />
                </span>
              ))}
            </div>
          </div>
          <StopRow label="Da" position={g.stops[0].position}>
            <ColorField
              label="Da"
              value={g.stops[0].color}
              onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, 0, rgb))}
            />
          </StopRow>
          <StopRow label="A" position={g.stops[last].position}>
            <ColorField
              label="A"
              value={g.stops[last].color}
              onCommit={(rgb) => run((ids) => gradientStopOps(ids, lookup, last, rgb))}
            />
          </StopRow>
          {g.kind === "linear" && (
            <NumberField
              label="Angolo"
              suffix="°"
              value={gradientAngleOf(fill)}
              onCommit={(v) => run((ids) => gradientAngleOps(ids, lookup, v))}
            />
          )}
        </>
      )}
    </div>
  );
}

// Una riga di stop: la posizione (in %, di sola lettura) a sinistra e il colore.
// `label` non si ripete qui come testo accessibile -- lo porta già il campo
// colore -- ma serve a chi guarda per capire QUALE estremo è.
function StopRow({ label, position, children }: { label: string; position: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11px] tabular-nums text-fg-subtle" title={`${label}: ${Math.round(position * 100)}%`}>
        {Math.round(position * 100)}%
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
