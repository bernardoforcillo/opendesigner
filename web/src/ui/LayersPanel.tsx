import { useMemo, useRef } from "react";
import { Button, GridList, GridListItem } from "react-aria-components";
import type { Selection } from "react-aria-components";
import { useScene } from "../store/store";
import { layersInDrawOrder } from "../store/selectors";
import { makeDeleteOp, makeSetPropsOp } from "../tools/ops";
import type { NodeLite } from "../store/types";

// PANNELLO LIVELLI — elenco, selezione, visibilità, eliminazione (Task 7).
//
// La sincronizzazione bidirezionale con la selezione del canvas non è un
// meccanismo A PARTE: `selectedKeys` viene qui letto dallo STESSO store che
// selectTool scrive (store.selection), e `onSelectionChange` scrive lì con lo
// STESSO store.setSelection che selectTool chiama. Un solo stato, due
// scritture -- niente da tenere sincronizzato a mano fra canvas e pannello.

// Lunghezza massima del contenuto di un nodo testo usato come nome di
// ripiego (step 3): abbastanza per riconoscere la riga senza spingere il
// pannello in orizzontale. "…" segnala il taglio, non è decorativo.
const TEXT_FALLBACK_MAX = 30;

function fallbackName(n: NodeLite): string {
  if (n.kind === "rect") return "Rectangle";
  if (n.kind === "ellipse") return "Ellipse";
  // n.kind === "text": a-capo e spazi ripetuti collassati, così l'etichetta
  // resta su una riga sola anche per un testo multilinea.
  const flat = (n.text?.content ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "Text";
  return flat.length > TEXT_FALLBACK_MAX ? `${flat.slice(0, TEXT_FALLBACK_MAX)}…` : flat;
}

// Il nome mostrato per una riga: `name` se valorizzato, altrimenti il
// fallback per tipo (Task 7, step 3). Esportata perché il pannello proprietà
// (Task 8) mostra lo stesso identico nome per la stessa selezione -- due
// implementazioni indipendenti potrebbero divergere silenziosamente.
export function layerDisplayName(n: NodeLite): string {
  return n.name.trim() !== "" ? n.name : fallbackName(n);
}

// Stesso insieme di id, in un ordine qualunque -- confronta un Selection di
// react-aria-components (le chiavi che GridList ci ha appena dato) contro
// l'array piatto dello store.
function sameIds(keys: Exclude<Selection, "all">, ids: readonly string[]): boolean {
  if (keys.size !== ids.length) return false;
  for (const id of ids) if (!keys.has(id)) return false;
  return true;
}

export function LayersPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);

  // Identità STABILE finché `scene` non cambia davvero (una selezione da
  // sola non lo tocca): react-aria-components ricostruisce la propria
  // collezione interna -- ancora di selezione compresa, quella su cui si
  // basa un range shift-click -- quando l'identità di `items` cambia. Un
  // nuovo array ad OGNI render (Object.values+sort di layersInDrawOrder non
  // è mai la STESSA referenza) la romperebbe anche quando la scena non è
  // cambiata per niente, e un semplice click successivo si comporterebbe da
  // "aggiungi" invece che da "sostituisci" perché l'ancora è appena andata
  // perduta.
  const layers = useMemo(() => (scene ? layersInDrawOrder(scene) : []), [scene]);

  // L'ULTIMA Selection che GridList stesso ci ha consegnato via
  // onSelectionChange -- con l'ANCORA di uno shift-click (quale riga apre
  // l'intervallo), che store.selection non può portare: è un array piatto,
  // scritto anche da selectTool sul canvas, che di ancore non sa nulla.
  //
  // Se il prossimo render arriva con la STESSA selezione che abbiamo appena
  // emesso noi (l'utente ha cliccato una riga), la riusiamo COSÌ COM'ERA,
  // ancora compresa: ricostruire un Set nuovo da `selection` ad ogni giro
  // (identico nel contenuto, ma un oggetto NUOVO) è indistinguibile per
  // GridList da "la selezione è stata sostituita da fuori", e perderebbe
  // l'ancora dopo OGNI click -- uno shift-click dopo l'altro selezionerebbe
  // sempre e solo due righe, mai l'intervallo. Se invece la selezione arriva
  // da FUORI (il canvas, via store.setSelection), non coincide con quella
  // emessa e ricostruiamo un Set piatto: un'ancora persa in quel caso È
  // l'esito giusto, non un bug -- un nuovo punto di partenza per il prossimo
  // shift-click nel pannello.
  const lastEmitted = useRef<Selection | null>(null);
  const selectedKeys: Selection = useMemo(() => {
    const cached = lastEmitted.current;
    if (cached && cached !== "all" && sameIds(cached, selection)) return cached;
    return new Set(selection);
  }, [selection]);

  // GridList è CONTROLLATO da selection (sopra) e scrive qui: un click
  // rimpiazza la selezione (selectionBehavior="replace"), ctrl/cmd-click la
  // estende un nodo alla volta, shift-click la estende per intervallo -- la
  // stessa semantica desktop di selectTool sul canvas, gratis da
  // react-aria-components.
  function onSelectionChange(keys: Selection) {
    lastEmitted.current = keys;
    const ids = keys === "all" ? layers.map((n) => n.id) : [...keys].map(String);
    useScene.getState().setSelection(ids);
  }

  // Un op, un gesto: anche il singolo toggle passa da beginGesture/endGesture
  // (i pannelli obbediscono alla stessa regola di un tool, vedi il brief
  // M1b), così la visibilità resta annullabile con Ctrl+Z e viaggia sul filo
  // come qualunque altra modifica.
  function toggleVisible(n: NodeLite) {
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(n.id, { visible: !n.visible }, ["visible"])]);
  }

  // Un solo gesto per l'INTERA selezione, non un gesto per nodo: undoStack
  // guadagna UNA voce anche cancellando dieci livelli in un colpo solo --
  // stesso schema di selectTool.ts::onKeyDown per Delete/Backspace sul
  // canvas, qui applicato al pulsante del pannello.
  function deleteSelected() {
    const store = useScene.getState();
    const ids = store.selection;
    if (ids.length === 0) return;
    store.beginGesture();
    store.endGesture(ids.map((id) => makeDeleteOp(id)));
  }

  return (
    <div className="flex h-full flex-col text-sm text-neutral-700">
      <div className="flex items-center justify-between border-b border-neutral-200 px-2 py-1.5">
        <span className="font-medium text-neutral-500">Livelli</span>
        <Button
          aria-label="Elimina i livelli selezionati"
          isDisabled={selection.length === 0}
          onPress={deleteSelected}
          className="rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-100 data-[disabled]:opacity-40"
        >
          Elimina
        </Button>
      </div>
      <GridList
        aria-label="Livelli"
        items={layers}
        selectionMode="multiple"
        selectionBehavior="replace"
        selectedKeys={selectedKeys}
        onSelectionChange={onSelectionChange}
        renderEmptyState={() => <div className="px-2 py-4 text-neutral-400">Nessun livello</div>}
        className="flex-1 overflow-auto outline-none"
      >
        {(n) => {
          const label = layerDisplayName(n);
          return (
            <GridListItem
              id={n.id}
              textValue={label}
              className="flex items-center justify-between gap-2 px-2 py-1 outline-none data-[selected]:bg-sky-100 data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500"
            >
              <span className="truncate">{label}</span>
              {/* stopPropagation: un click qui è "nascondi/mostra QUESTA
                  riga", non "seleziona questa riga" -- senza, il pointerdown
                  del Button raggiungerebbe comunque la riga sottostante e la
                  selezione cambierebbe insieme alla visibilità. */}
              <Button
                aria-label={n.visible ? `Nascondi ${label}` : `Mostra ${label}`}
                onPress={() => toggleVisible(n)}
                onPointerDown={(e) => e.stopPropagation()}
                className="shrink-0 rounded px-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
              >
                {n.visible ? "\u{1F441}️" : "—"}
              </Button>
            </GridListItem>
          );
        }}
      </GridList>
    </div>
  );
}
