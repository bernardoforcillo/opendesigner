import { useScene } from "../store/store";
import { selectionSummary, MIXED } from "../store/selectors";
import { makeSetPropsOp } from "../tools/ops";
import { NumberField } from "./fields/NumberField";
import type { MaskPath } from "../store/maskPaths";
import type { Op } from "../gen/brawt/v1/brawt_pb";

// PANNELLO PROPRIETÀ — geometria (Task 9). Un solo pezzo per adesso (X/Y/W/H);
// il resto (opacità, rotazione, riempimenti...) arriva con task successivi
// dello stesso M1b, sullo stesso schema.
//
// Come il pannello livelli (ui/LayersPanel.tsx), obbedisce alla regola dei
// gesti: un op, un gesto -- anche il singolo campo digitato passa da
// beginGesture/endGesture, così resta annullabile con Ctrl+Z e viaggia sul
// filo come qualunque altra modifica.

// La chiave che legge NodeLite/SelectionSummary E il path di FieldMask che la
// indirizza sul filo, insieme: aggiungere un campo geometrico è aggiungere
// UNA voce qui, non toccare la logica sotto. `minValue` è opzionale e vive
// qui e non nel campo stesso: è una proprietà del CAMPO (larghezza/altezza
// non hanno senso negative), non del widget generico.
interface GeometryField {
  key: "x" | "y" | "width" | "height";
  label: string;
  mask: MaskPath;
  minValue?: number;
}

const GEOMETRY_FIELDS: readonly GeometryField[] = [
  { key: "x", label: "X", mask: "x" },
  { key: "y", label: "Y", mask: "y" },
  { key: "width", label: "W", mask: "width", minValue: 0 },
  { key: "height", label: "H", mask: "height", minValue: 0 },
];

// Il patch da un valore letterale: uno switch e non un oggetto calcolato con
// una chiave dinamica (`{ [field.key]: value }`) perché il tipo di
// makeSetPropsOp è il MessageInitShape generato da NodeSchema -- una chiave
// dinamica su un'unione lo renderebbe non verificabile a compile-time, ed è
// proprio il controllo che MaskPath (store/maskPaths.ts) esiste per dare.
function patchFor(key: GeometryField["key"], value: number) {
  switch (key) {
    case "x":
      return { x: value };
    case "y":
      return { y: value };
    case "width":
      return { width: value };
    case "height":
      return { height: value };
  }
}

// Op di scrittura di UN campo geometrico su OGNI nodo selezionato: come il
// toggle di visibilità e la rinomina del pannello livelli, lo stesso valore
// ASSOLUTO va a tutti i nodi selezionati -- non una traslazione relativa.
// Per la selezione singola testata dal brief è comunque un solo op.
function geometryOps(ids: readonly string[], field: GeometryField, value: number): Op[] {
  return ids.map((id) => makeSetPropsOp(id, patchFor(field.key, value), [field.mask]));
}

export function PropertiesPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  const summary = scene ? selectionSummary(scene, selection) : null;

  // Digitare + confermare (Invio o blur, dentro NumberField): UN gesto i cui
  // op finali assegnano lo stesso valore a ogni nodo selezionato -- una sola
  // voce di undo anche per una selezione multipla.
  function commit(field: GeometryField, value: number) {
    const store = useScene.getState();
    const ids = store.selection;
    if (ids.length === 0) return;
    store.beginGesture();
    store.endGesture(geometryOps(ids, field, value));
  }

  // Trascinamento dell'etichetta: la PRIMA chiamata apre il gesto (pigro,
  // come dragStarted in tools/selectTool.ts -- un click che NumberField non
  // ha promosso a trascinamento non arriva mai qui), le successive sono solo
  // anteprima locale -- niente sul filo finché il puntatore non si rilascia.
  function scrub(field: GeometryField, value: number) {
    const store = useScene.getState();
    if (store.selection.length === 0) return;
    if (!store.gesture) store.beginGesture();
    for (const op of geometryOps(store.selection, field, value)) store.applyLocal(op);
  }

  // Rilascio del trascinamento: chiude lo STESSO gesto aperto da scrub con
  // gli op FINALI -- stessa forma di selectTool.ts::onPointerUp per il drag
  // di spostamento (un solo invio, non uno per pixel di anteprima).
  function scrubEnd(field: GeometryField, value: number) {
    const store = useScene.getState();
    if (!store.gesture) return; // scrub non partito (selezione svuotata a metà drag)
    store.endGesture(geometryOps(store.selection, field, value));
  }

  return (
    <div className="flex h-full flex-col text-sm text-neutral-700">
      <div className="border-b border-neutral-200 px-2 py-1.5 font-medium text-neutral-500">Proprietà</div>
      {summary ? (
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 p-2">
          {GEOMETRY_FIELDS.map((field) => (
            <NumberField
              key={field.key}
              label={field.label}
              minValue={field.minValue}
              // MIXED (selezione multipla con valori diversi) diventa NaN:
              // NumberField lo mostra vuoto e non ne fa un cambio di
              // controllato/non controllato (vedi il commento sulla sua
              // prop `value`).
              value={summary[field.key] === MIXED ? NaN : (summary[field.key] as number)}
              onCommit={(v) => commit(field, v)}
              onScrub={(v) => scrub(field, v)}
              onScrubEnd={(v) => scrubEnd(field, v)}
            />
          ))}
        </div>
      ) : (
        <div className="px-2 py-4 text-neutral-400">Nessuna selezione</div>
      )}
    </div>
  );
}
