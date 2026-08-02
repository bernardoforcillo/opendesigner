import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScene } from "../store/store";
import { worldToScreen } from "../canvas/camera";
import { worldTransformOf } from "../canvas/transform";
import { makeSetTextOp } from "../tools/ops";
import { cssColor } from "../renderer/canvasRenderer";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_WEIGHT,
  fontSizeOf,
  lineHeightOf,
} from "../renderer/text";
import type { NodeLite } from "../store/types";

// EDITING DEL TESTO — un <textarea> del DOM sovrapposto al nodo.
//
// Perché il DOM e non un caret disegnato sul canvas: accenti, tastiere morte,
// IME, selezione col mouse, taglia/incolla e lettori di schermo sono già
// risolti dal campo nativo, e riscriverli sopra un canvas significa riscriverli
// male. Il canvas resta il posto in cui il testo VIVE; il campo è solo il modo
// in cui lo si scrive.
//
// LA SCELTA (il brief ne offre due, vedi il report): il campo è OPACO e copre
// il nodo, invece di essere trasparente sopra i glifi disegnati dal canvas.
// La variante trasparente dà un cursore allineato al pixel solo se font,
// wrapping E baseline coincidono esattamente fra ctx.measureText e il layout
// CSS -- e non coincidono: renderer/text.ts colloca la baseline con
// un'approssimazione dichiarata (ASCENT_RATIO = 0.8em) mentre il browser usa le
// metriche vere del font. Con un campo trasparente quello scarto si vedrebbe
// come un cursore fuori asse dai glifi, cioè esattamente il difetto che la
// scelta doveva evitare. Coprendo, il testo che si legge mentre si scrive è
// quello del campo: il disallineamento diventa un piccolo salto al momento
// della conferma, invisibile durante la digitazione.
//
// "Coprire" invece di "nascondere il nodo nel renderer" è la stessa cosa vista
// dal lato giusto: drawScene resta una funzione pura di (scena, camera), senza
// un parametro "tranne questo nodo" che qualcuno deve ricordarsi di passare --
// e senza il quale il testo si vedrebbe DOPPIO. Il costo è che, per la durata
// dell'editing, il rettangolo del campo copre anche ciò che gli sta sotto.

export interface TextEditorOverlayProps {
  // Il nodo in editing. Lo decide lo store (editingNodeId): ce lo passa chi
  // monta l'overlay, così il componente resta pilotabile anche da un test.
  nodeId: string;
}

function contentOf(n: NodeLite | undefined): string {
  return n?.text?.content ?? "";
}

export function TextEditorOverlay({ nodeId }: TextEditorOverlayProps) {
  // Nodo e camera dallo store, con selettori: l'overlay si ridisegna quando si
  // sposta la camera (pan/zoom durante l'editing non devono scollare il campo
  // dal nodo) e quando cambia il nodo, non a ogni op del documento.
  const node = useScene((s) => s.scene?.nodes[nodeId]);
  const camera = useScene((s) => s.camera);
  // L'origine MONDO del nodo. Le sue x/y sono relative al PARENT (vedi
  // canvas/transform.ts), quindi per un nodo annidato non dicono da sole dove
  // il canvas lo disegna -- e il campo, che deve coprirlo, finirebbe altrove.
  // La traslazione della trasformazione mondo del nodo È la sua origine
  // (l'immagine del punto (0,0) del suo spazio locale).
  //
  // Due selettori che ritornano NUMERI e non un punto: un oggetto nuovo a ogni
  // chiamata farebbe ridisegnare l'overlay a ogni op del documento, mentre
  // così si ridisegna solo quando l'origine cambia davvero -- il nodo o un suo
  // antenato si è mosso.
  const worldX = useScene((s) => (s.scene ? worldTransformOf(s.scene, nodeId).e : 0));
  const worldY = useScene((s) => (s.scene ? worldTransformOf(s.scene, nodeId).f : 0));

  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Una sessione è chiusa UNA volta sola: Escape chiude, e il blur che arriva
  // subito dopo (il campo sta per essere smontato) non deve richiudere niente.
  const done = useRef(false);
  // C'è una composizione IME in corso? Serve solo a Escape: mentre l'IME è
  // aperto quel tasto è SUO (chiude la finestra dei candidati), non nostro.
  // Un ref e non uno stato: nessun ridisegno dipende da questo valore, e il
  // keydown lo deve leggere aggiornato nello stesso giro di eventi.
  const composing = useRef(false);

  // Il contenuto della sessione. La sorgente di verità mentre si scrive è il
  // CAMPO, non lo store: lo store riceve un'anteprima a ogni tasto, ma è il
  // campo a dire cosa verrà scritto davvero. `start` è il contenuto di
  // partenza -- fotografato all'ingresso e mai più riletto dallo store, che nel
  // frattempo contiene le anteprime.
  const [value, setValue] = useState(() => contentOf(node));
  const session = useRef({ id: nodeId, start: value, value });
  if (session.current.id !== nodeId) {
    // Il padre ha riusato l'overlay per un ALTRO nodo invece di rimontarlo.
    // Oggi non succede (il blur chiude sempre la sessione prima che una nuova
    // si apra), ma una sessione che continua con il testo di partenza di
    // un'altra scriverebbe il contenuto sbagliato sul nodo sbagliato.
    const start = contentOf(node);
    session.current = { id: nodeId, start, value: start };
    setValue(start);
  }

  // Chiude la sessione. `commit` = scrivi (uscita normale), altrimenti annulla
  // (Escape). In entrambi i casi il gesto si chiude ed è UNA voce di undo: gli
  // op di anteprima non sono mai stati sul filo, quello finale è uno solo.
  const finish = useCallback(
    (commit: boolean) => {
      if (done.current) return;
      done.current = true;
      const store = useScene.getState();
      const { start, value: text } = session.current;
      if (commit) {
        // Nessuna modifica = nessun op: entrare in un testo e uscirne senza
        // toccarlo non deve né viaggiare sulla rete né consumare un Ctrl+Z.
        store.endGesture(text === start ? [] : [makeSetTextOp(nodeId, text)]);
      } else {
        store.cancelGesture();
      }
      // La politica del nodo rimasto VUOTO (cancellarlo invece di lasciare un
      // fantasma) vive nello store e resta lì: l'overlay non la duplica, la
      // invoca. Vedi store.ts::endTextEditing.
      store.endTextEditing();
    },
    [nodeId],
  );

  // Ingresso: apre il gesto, prende il fuoco, cursore a fine testo.
  useEffect(() => {
    done.current = false;
    useScene.getState().beginGesture();
    const el = ref.current;
    if (el) {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
    return () => {
      // Smontaggio SENZA un'uscita esplicita: chiude il proprio gesto e basta.
      // Niente endTextEditing qui -- in StrictMode (main.tsx) React monta,
      // smonta e rimonta ogni effetto, e spegnere il flag lì dentro farebbe
      // sparire l'editor in sviluppo al primo frame.
      if (!done.current) {
        done.current = true;
        useScene.getState().cancelGesture();
      }
    };
  }, [nodeId]);

  // Il nodo è sparito sotto le dita (cancellato da un altro client, o dal
  // rollback della sua stessa creazione): la sessione non ha più un bersaglio.
  // Chiuderla annullando è l'unica uscita onesta -- un setText su un id che non
  // esiste sarebbe rifiutato dal server e, prima ancora, lascerebbe il gesto
  // aperto per sempre.
  const editable = node !== undefined && node.kind === "text" && node.text !== undefined;
  useEffect(() => {
    if (!editable) finish(false);
  }, [editable, finish]);

  // Il campo deve COPRIRE il testo che il canvas disegna: se il contenuto
  // cresce oltre il box del nodo, cresce anche lui. `height: 0` prima di
  // leggere scrollHeight, altrimenti l'altezza può solo salire.
  const minHeight = (node?.height ?? 0) * camera.zoom;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  });

  const change = (next: string) => {
    session.current.value = next;
    setValue(next);
    // Anteprima LIVE sul canvas (e in tutto ciò che legge la scena: pannelli,
    // maniglie). Non va sul filo: è il gesto a mandare l'op finale, uno solo.
    // Le anteprime di setText si coalescono per nodo (store.ts::previewKey),
    // quindi una sessione lunga non accumula un op per tasto.
    useScene.getState().applyLocal(makeSetTextOp(nodeId, next));
  };

  if (!node || !editable) return null;

  const style = node.text?.style;
  const origin = worldToScreen(camera, worldX, worldY);
  // Tutto in px SCHERMO: il modello resta in unità mondo, la conversione vive
  // qui come per il resto della UI.
  const fontSize = fontSizeOf(style) * camera.zoom;
  const lineHeight = lineHeightOf(style) * camera.zoom;

  return (
    <textarea
      ref={ref}
      aria-label="Contenuto del testo"
      value={value}
      spellCheck={false}
      onChange={(e) => change(e.target.value)}
      // Click fuori (il pointerdown sul canvas toglie il fuoco) e Tab: si
      // conferma. È anche la rete di sicurezza dei casi che nessuno gestisce --
      // la finestra che perde il fuoco non deve poter perdere quello che
      // l'utente ha scritto.
      onBlur={() => finish(true)}
      // Composizione IME (giapponese, cinese, coreano, ma anche le tastiere
      // predittive del mobile): fra compositionstart e compositionend i tasti
      // appartengono all'IME, non a noi. Vedi la guardia in onKeyDown.
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(e) => {
        // Escape MENTRE l'IME sta componendo chiude la finestra dei candidati:
        // è il modo standard di rifiutare una conversione, e buttare via
        // l'intera sessione di editing per quel tasto renderebbe l'editor
        // inusabile con un IME -- cioè con le lingue per cui l'overlay del DOM
        // esiste. Tre segnali per lo stesso stato perché i browser non
        // concordano: isComposing (lo standard), keyCode 229 (il tasto
        // "in lavorazione dall'IME", che vecchi WebKit mandano senza
        // isComposing) e il nostro ref, che copre l'ordine in cui il keydown
        // arriva prima che il browser marchi l'evento.
        if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
        // Escape annulla. Enter no: va a capo (è un editor multilinea) ed è
        // quindi affare del campo, non nostro.
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      className="absolute m-0 block resize-none overflow-hidden border-0 p-0 bg-white"
      style={{
        left: `${origin.x}px`,
        top: `${origin.y}px`,
        width: `${node.width * camera.zoom}px`,
        minHeight: `${minHeight}px`,
        fontFamily: style?.fontFamily || DEFAULT_FONT_FAMILY,
        fontWeight: style?.fontWeight || DEFAULT_FONT_WEIGHT,
        fontSize: `${fontSize}px`,
        lineHeight: `${lineHeight}px`,
        textAlign: style?.align ?? "left",
        color: cssColor(node),
        // L'OPACITÀ del nodo NON viene riportata qui: renderebbe
        // semitrasparente tutto il campo, sfondo compreso, e il testo disegnato
        // sotto trasparirebbe -- due testi sovrapposti e sfalsati, cioè il
        // difetto che la copertura esiste per evitare. Si scrive sempre al
        // 100%, e l'opacità torna alla conferma (fa parte del piccolo salto
        // visivo che questa scelta accetta).
        // Stesso wrapping del layout su canvas (renderer/text.ts): a capo sugli
        // spazi, e una parola più larga della riga viene spezzata invece di
        // sporgere.
        overflowWrap: "anywhere",
        // Il campo è un'affordance, non un rettangolo bianco comparso dal
        // nulla: il contorno dice dove si sta scrivendo e dove finisce la
        // larghezza di wrap. sky-500, come gli altri accenti dell'app.
        outline: "1px solid #0ea5e9",
        outlineOffset: "0px",
      }}
    />
  );
}
