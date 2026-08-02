import { useEffect, useMemo, useRef, useState } from "react";
import { Button, GridList, GridListItem } from "react-aria-components";
import type { Selection } from "react-aria-components";
import { useScene } from "../store/store";
import { layersInDrawOrder } from "../store/selectors";
import { orderKeyBetween } from "../store/orderKey";
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
  if (n.kind === "vector") return "Vector";
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

/**
 * La order key da dare alla riga `from` per portarla in posizione `to`.
 *
 * `layers` è la lista COM'È MOSTRATA -- primo piano in cima, quindi order key
 * DECRESCENTE (vedi selectors.ts::layersInDrawOrder). Il riordino è quello di
 * una lista qualunque: si toglie la riga dalla posizione di partenza e la si
 * infila in quella d'arrivo; la chiave nuova è poi una qualunque strettamente
 * compresa fra i due VICINI che la riga si ritrova lì -- e l'indice frazionario
 * (store/orderKey.ts) ne trova sempre una, anche fra due chiavi consecutive,
 * anche mille volte nello stesso punto.
 *
 * NESSUN'ALTRA riga viene toccata: un solo op per un riordino, invece di
 * rinumerare l'intera lista. È tutto il motivo per cui le order key sono un
 * indice frazionario e non degli interi.
 *
 * Gli estremi sono APERTI: in cima non c'è vicino sopra (`null` = "sopra a
 * tutte"), in fondo non c'è vicino sotto.
 *
 * null quando non c'è niente da fare (la riga non si muove, indici fuori
 * lista) o quando la chiave non esiste -- due vicini con la STESSA order key
 * non lasciano spazio in mezzo. In quel caso orderKeyBetween lancerebbe, e
 * lanciare dentro il gestore di un pointerup vorrebbe dire rompere l'app a
 * metà trascinamento: meglio un riordino che non avviene.
 */
export function reorderKey(layers: readonly NodeLite[], from: number, to: number): string | null {
  if (from === to) return null;
  if (from < 0 || from >= layers.length || to < 0 || to >= layers.length) return null;

  const moved = [...layers];
  moved.splice(to, 0, ...moved.splice(from, 1));
  // Sopra = order key PIÙ ALTA (la lista è decrescente), sotto = più bassa.
  const above = moved[to - 1]?.orderKey ?? null;
  const below = moved[to + 1]?.orderKey ?? null;
  if (above !== null && below !== null && below >= above) return null;
  return orderKeyBetween(below, above);
}

// Etichetta del campo di rinomina. Costante e non "Rinomina {nome}": ne esiste
// UNO alla volta (renamingId è un id solo), e un'etichetta che cambia con il
// contenuto del campo non è un nome stabile per chi usa uno screen reader.
const RENAME_LABEL = "Nome del livello";

// CAMPO DI RINOMINA INLINE (Task 8, step 1). Un componente a parte, e non un
// <input> inline dentro la riga, per una ragione precisa: la sessione di
// modifica ha uno STATO SUO (il testo digitato finora, e il fatto di essere già
// stata chiusa) che deve nascere e morire con il campo. Montandolo/smontandolo
// quando `renamingId` cambia, quello stato non può sopravvivere alla riga
// sbagliata.
function RenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  // Una sessione si chiude UNA volta sola: Enter/Escape chiudono, e il blur che
  // arriva subito dopo (il campo sta per essere smontato) non deve confermare
  // una seconda volta -- men che meno dopo un annullamento. Stessa guardia di
  // ui/TextEditorOverlay.tsx::done, per lo stesso motivo.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Tutto selezionato: scrivere SOSTITUISCE il nome, che è quello che ci si
    // aspetta da una rinomina (e resta possibile posizionare il cursore).
    el.select();
  }, []);

  function settle(commit: boolean) {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  }

  return (
    <input
      ref={ref}
      aria-label={RENAME_LABEL}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      // Uscire dal campo (click altrove, Tab) conferma: è la rete di sicurezza
      // dei casi che nessuno gestisce -- perdere il fuoco non deve poter far
      // perdere quello che l'utente ha scritto.
      onBlur={() => settle(true)}
      // Un click DENTRO il campo (per posizionare il cursore) non deve
      // diventare un click sulla riga: senza, GridList cambierebbe la selezione
      // sotto le dita di chi sta rinominando. Servono ENTRAMBI gli eventi:
      // react-aria apre la pressione sul pointerdown, ma per i click
      // "virtuali" -- quelli di uno screen reader, e quelli che user-event
      // sintetizza nei test, riconosciuti da pressure/width/height (vedi il
      // commento di press() in LayersPanel.test.tsx) -- passa dal solo click.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // NIENTE tasto esce da questo campo. Le scorciatoie globali dell'app
        // ascoltano sulla FINESTRA (undo/redo in ui/App.tsx, Escape/Canc in
        // tools/toolManager.ts) e GridList ha le sue sulla lista (frecce,
        // typeahead): senza questo stop, Canc cancellerebbe il nodo che si sta
        // rinominando e scrivere "Beta" sposterebbe la selezione sulla riga che
        // comincia per B. Le due guardie isTextField esistenti coprono solo il
        // canale della finestra, non quello di GridList -- che è React e
        // arriverebbe comunque.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          settle(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      // select-text: la lista intorno è select-none (perché trascinare una
      // maniglia non deve evidenziare i nomi delle righe che si attraversano),
      // ma DENTRO un campo di testo la selezione serve.
      className="min-w-0 flex-1 select-text rounded border border-sky-500 bg-white px-1 py-0 text-sm outline-none"
    />
  );
}

export function LayersPanel() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  // Il nodo la cui riga sta mostrando il campo di rinomina, o null. Uno solo
  // alla volta, per costruzione.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Il trascinamento in corso: quale riga si sta spostando e su quale si trova
  // adesso il puntatore (`over` parte dalla riga stessa, cioè "non si è ancora
  // mosso"). null = nessun riordino in corso.
  const [drag, setDrag] = useState<{ from: string; over: string } | null>(null);

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
  // Chiude la rinomina scrivendo il nuovo nome. Come il toggle di visibilità è
  // un gesto intero (una voce di undo, un op sul filo).
  //
  // Due casi non producono NIENTE: il nome invariato e -- per lo stesso motivo
  // -- il nome che differisce solo per spazi ai bordi, che vengono tolti. Un op
  // "che non cambia niente" costerebbe comunque un giro di rete e un Ctrl+Z.
  function commitRename(n: NodeLite, raw: string) {
    setRenamingId(null);
    const name = raw.trim();
    if (name === n.name) return;
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(n.id, { name }, ["name"])]);
  }

  // Porta la riga `id` alla posizione `to` della lista mostrata. Un op solo (la
  // order key della riga spostata) dentro un gesto solo: i vicini non si
  // toccano, quindi anche il riordino resta una voce di undo e un solo giro di
  // rete, come il toggle di visibilità e la rinomina.
  function moveTo(id: string, to: number) {
    const key = reorderKey(layers, layers.findIndex((n) => n.id === id), to);
    if (key === null) return;
    const store = useScene.getState();
    store.beginGesture();
    store.endGesture([makeSetPropsOp(id, { orderKey: key }, ["order_key"])]);
  }

  // Il rilascio arriva sulla FINESTRA e non sulla riga: il puntatore può
  // benissimo essere lasciato andare fuori dalla lista (o fuori dalla finestra),
  // e un trascinamento che resta "attaccato" perché il pointerup è andato altrove
  // è il difetto classico di un drag fatto a mano. Registrato solo mentre un
  // trascinamento è in corso.
  useEffect(() => {
    if (!drag) return;
    const { from, over } = drag;
    const drop = () => {
      setDrag(null);
      moveTo(from, layers.findIndex((n) => n.id === over));
    };
    // Il browser ha annullato il gesto (gesture di sistema, capture perso):
    // si abbandona senza riordinare, come fa onPointerCancel dei tool
    // (tools/toolManager.ts).
    const abort = () => setDrag(null);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", abort);
    return () => {
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", abort);
    };
    // moveTo dipende solo da `layers`, che è già qui: la closure catturata è
    // sempre quella del render in cui il trascinamento è cambiato.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, layers]);

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
        // La CACHE degli item di react-aria-components. Con una collezione
        // dinamica (`items` + render function) RAC ricostruisce le righe solo
        // quando cambia `items` -- non a ogni render del pannello: `renamingId`
        // vive nello STATO di questo componente, e senza dichiararlo qui il
        // doppio click aggiornerebbe lo stato senza che la riga cambi mai (il
        // campo non comparirebbe proprio). Vale per ogni stato locale che la
        // riga legge.
        dependencies={[renamingId, drag]}
        selectionMode="multiple"
        selectionBehavior="replace"
        selectedKeys={selectedKeys}
        onSelectionChange={onSelectionChange}
        renderEmptyState={() => <div className="px-2 py-4 text-neutral-400">Nessun livello</div>}
        className="flex-1 select-none overflow-auto outline-none"
      >
        {(n) => {
          const label = layerDisplayName(n);
          // La riga sotto il puntatore durante un trascinamento: è QUI che la
          // riga trascinata andrà a finire. Non si evidenzia la riga trascinata
          // stessa (lasciarla lì è un no-op, non una destinazione).
          const isDropTarget = drag !== null && drag.over === n.id && drag.from !== n.id;
          return (
            <GridListItem
              id={n.id}
              textValue={label}
              // Il bersaglio del rilascio si decide dalla riga SOTTO IL
              // PUNTATORE, non da un calcolo su coordinate e altezze: il
              // pointermove arriva già sulla riga giusta, che è l'unica
              // informazione che serve. (Nessun setPointerCapture, per questo:
              // catturando, i move tornerebbero tutti alla maniglia.)
              onPointerMove={() => {
                if (drag && drag.over !== n.id) setDrag({ from: drag.from, over: n.id });
              }}
              className={[
                "flex items-center gap-2 px-2 py-1 outline-none",
                "data-[selected]:bg-sky-100 data-[focus-visible]:ring-1 data-[focus-visible]:ring-inset data-[focus-visible]:ring-sky-500",
                drag?.from === n.id ? "opacity-50" : "",
                isDropTarget ? "bg-sky-50 ring-1 ring-inset ring-sky-400" : "",
              ].join(" ")}
            >
              {/* MANIGLIA di trascinamento. Il riordino parte da qui e non da
                  tutta la riga: un pointerdown sulla riga è già "seleziona
                  questa riga" (e con shift/ctrl, "estendi la selezione"), e
                  farlo valere anche come inizio di un riordino vorrebbe dire
                  decidere a posteriori -- con una soglia in pixel -- quale
                  delle due cose l'utente intendeva. Un <button> vero, non un
                  <div> decorativo: è raggiungibile da tastiera e Alt+frecce lo
                  spostano, altrimenti il riordino sarebbe l'unica funzione del
                  pannello impossibile senza mouse. */}
              <button
                type="button"
                aria-label={`Riordina ${label}`}
                title="Trascina per riordinare (Alt+↑ / Alt+↓)"
                // Come per il campo di rinomina: pointerdown per il percorso
                // normale, click per quello "virtuale" (screen reader), così la
                // presa della maniglia non diventa anche un click sulla riga.
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDrag({ from: n.id, over: n.id });
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // ALT + freccia, non la freccia da sola, e non è una
                  // preferenza: react-aria RISERVA ArrowUp/ArrowDown alla
                  // navigazione fra le righe e le intercetta in fase di
                  // CAPTURE prima che arrivino ai figli della riga
                  // (useGridListItem.mjs: "Prevent this event from reaching row
                  // children"), rilanciandole dal genitore. L'unica combinazione
                  // che lascia passare è con altKey -- ed è la stessa che
                  // react-aria usa per il proprio riordino da tastiera
                  // (useDraggableItem.mjs). Una freccia liscia qui non
                  // arriverebbe mai: sarebbe codice morto.
                  if (!e.altKey) return;
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
                  e.stopPropagation();
                  const i = layers.findIndex((l) => l.id === n.id);
                  moveTo(n.id, e.key === "ArrowUp" ? i - 1 : i + 1);
                }}
                // touch-none: su schermo tattile il trascinamento della maniglia
                // non deve diventare uno scroll del pannello.
                className="shrink-0 cursor-grab touch-none px-0.5 text-neutral-300 outline-none hover:text-neutral-600 focus-visible:text-sky-600"
              >
                {"⁙"}
              </button>
              {renamingId === n.id ? (
                <RenameField
                  // Seminato con il nome VERO, non con quello mostrato: per un
                  // nodo senza nome il campo parte vuoto e il fallback resta il
                  // placeholder. Confermare senza scrivere niente non deve
                  // persistere "Rectangle" come nome esplicito -- sarebbe una
                  // modifica che l'utente non ha chiesto, per giunta annullabile.
                  initial={n.name}
                  placeholder={label}
                  onCommit={(value) => commitRename(n, value)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setRenamingId(n.id)}>
                  {label}
                </span>
              )}
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
