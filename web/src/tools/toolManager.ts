import { zoomAt } from "../canvas/camera";
import { handTool } from "./handTool";
import type { Tool, ToolContext } from "./types";

// client -> px CANVAS (CSS). È l'unico posto che toglie l'origine del canvas;
// da lì in poi si passa sempre da canvas/camera.ts per andare nel mondo.
export function eventToCanvasPoint(
  canvas: HTMLCanvasElement,
  e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// Normalizzazione della rotella: deltaMode dice se il delta è in pixel (0),
// righe (1) o pagine (2) -- Firefox usa le righe. Il pinch del trackpad arriva
// come wheel con ctrlKey=true e delta molto piccoli, quindi ha un guadagno più
// alto. La mappa delta -> fattore è esponenziale così N notch danno lo stesso
// rapporto di zoom indipendentemente dal punto di partenza.
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 400;
const WHEEL_GAIN = 0.0015;
const PINCH_GAIN = 0.01;
const MAX_FACTOR = 4;

export function wheelZoomFactor(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? PIXELS_PER_LINE : e.deltaMode === 2 ? PIXELS_PER_PAGE : 1;
  const gain = e.ctrlKey ? PINCH_GAIN : WHEEL_GAIN;
  const factor = Math.exp(-e.deltaY * unit * gain);
  // Un singolo evento non deve poter bruciare tutto il range di zoom (certi
  // driver/OS emettono delta enormi).
  return Math.min(MAX_FACTOR, Math.max(1 / MAX_FACTOR, factor));
}

// Un campo di testo: input, textarea, select, contentEditable. Duck-typing
// invece di instanceof: i test girano senza HTMLElement, e il target di un
// evento sintetico non è mai un vero elemento.
// Esportata perché ogni canale di tasti globali ha bisogno della STESSA
// guardia (le scorciatoie della clipboard, tools/clipboard.ts): due copie che
// divergono vorrebbero dire una scorciatoia che ruba i tasti a un campo di
// testo e l'altra no.
export function isTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Elementi per cui lo spazio è affare loro: i campi di testo (deve scrivere uno
// spazio) e i controlli attivabili come i bottoni della toolbar (lo spazio li
// preme). Rubarglielo per il pan darebbe doppia attivazione o testo mangiato.
// I primi sono già coperti dalla guardia generale di onKeyDown; questi due tag
// no -- un pulsante non è un campo di testo, ma lo spazio resta suo.
function swallowsSpace(target: EventTarget | null): boolean {
  if (isTextField(target)) return true;
  const el = target as { tagName?: string } | null;
  const tag = el?.tagName?.toUpperCase();
  return tag === "BUTTON" || tag === "A";
}

const MOUSE_LEFT = 0;
const MOUSE_MIDDLE = 1;

// Collega gli eventi del canvas al tool attivo. Il tool attivo è letto da
// getActive a ogni evento (non catturato una volta sola), così la toolbar può
// cambiarlo senza ri-agganciare i listener.
export function attachTools(ctx: ToolContext, getActive: () => Tool): () => void {
  const { canvas } = ctx;
  // Sostituisce temporaneamente il tool attivo: spazio premuto o tasto
  // centrale del mouse => mano.
  let temp: Tool | null = null;
  let seen: Tool | null = null;
  // Il tool messo da parte dal pan TEMPORANEO, non disattivato: riprenderà il
  // suo posto (col suo gesto intatto) appena il pan finisce. Vedi Tool.onSuspend.
  let suspended: Tool | null = null;
  let spaceDown = false;
  let middlePan = false;
  let captured: number | null = null;

  // Risolve il tool effettivo e, se è cambiato dall'ultima volta, chiude il
  // gesto del precedente e aggiorna il cursore.
  //
  // "Chiude" ha due forme, e la differenza conta da quando esiste uno strumento
  // (il pen tool) il cui gesto dura più click invece di un drag solo:
  //  - SOSTITUZIONE TEMPORANEA (spazio o tasto centrale => mano): il tool
  //    tornerà tra un istante, quindi se dichiara onSuspend lo si sospende e
  //    basta. Panare mentre si disegna è routine in qualunque editor
  //    vettoriale, e trattarlo come un cambio di strumento butterebbe via il
  //    lavoro in corso senza avviso.
  //  - CAMBIO VERO (toolbar, pointercancel, smontaggio): onDeactivate come
  //    sempre, il gesto a metà si abbandona.
  function active(): Tool {
    const next = temp ?? getActive();
    if (seen === next) return next;
    const prev = seen;
    seen = next;
    if (prev && next === temp && prev.onSuspend) {
      suspended = prev;
      prev.onSuspend(ctx);
    } else {
      prev?.onDeactivate?.(ctx);
      // Il pan è FINITO (temp è tornato null): il tool sospeso riprende il suo
      // posto in silenzio se è lui a tornare attivo; se nel frattempo la
      // toolbar è passata a un altro strumento, quello sospeso va invece
      // abbandonato -- altrimenti resterebbe per sempre con un gesto a metà e
      // un'anteprima che nessuno spegne. Finché temp c'è ancora si sta ancora
      // panando (es. un pointercancel a metà pan) e non si decide niente.
      if (suspended && temp === null) {
        const s = suspended;
        suspended = null;
        if (s !== next) s.onDeactivate?.(ctx);
      }
    }
    const style = (canvas as { style?: { cursor: string } }).style;
    if (style) style.cursor = next.cursor;
    return next;
  }

  function release() {
    if (captured === null) return;
    // releasePointerCapture lancia se il capture è già stato perso: un drag
    // interrotto dal browser non deve rompere il resto del gesto.
    try {
      canvas.releasePointerCapture?.(captured);
    } catch {
      /* capture già rilasciato */
    }
    captured = null;
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === MOUSE_MIDDLE) {
      e.preventDefault(); // niente autoscroll del browser
      middlePan = true;
      temp = handTool;
    } else if (e.button !== MOUSE_LEFT) {
      return; // tasto destro & co: nessun gesto
    }
    const tool = active();
    // Pointer capture: un drag che esce dal canvas (o dalla finestra) continua
    // a consegnare i move qui, invece di sparire a metà gesto.
    try {
      canvas.setPointerCapture?.(e.pointerId);
      captured = e.pointerId;
    } catch {
      captured = null;
    }
    tool.onPointerDown?.(e, ctx);
  };

  const onPointerMove = (e: PointerEvent) => {
    active().onPointerMove?.(e, ctx);
  };

  const onPointerUp = (e: PointerEvent) => {
    const tool = active();
    tool.onPointerUp?.(e, ctx);
    release();
    if (middlePan) {
      middlePan = false;
      if (!spaceDown) temp = null;
      active(); // ripristina subito tool e cursore
    }
  };

  // Il browser ha annullato il gesto (gesture di sistema, perdita del capture):
  // si abbandona invece di emettere l'op finale.
  const onPointerCancel = () => {
    const tool = active();
    tool.onDeactivate?.(ctx);
    release();
    if (middlePan) {
      middlePan = false;
      if (!spaceDown) temp = null;
    }
    seen = null; // il prossimo evento riparte pulito (e riapplica il cursore)
    active();
  };

  const onWheel = (e: WheelEvent) => {
    // Sempre preventDefault: senza, ctrl+rotella zooma la PAGINA e la rotella
    // liscia la scrolla.
    e.preventDefault();
    const p = eventToCanvasPoint(canvas, e);
    ctx.setCamera(zoomAt(ctx.getCamera(), wheelZoomFactor(e), p.x, p.y));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Un campo di testo ha la precedenza su OGNI scorciatoia del canvas. Questi
    // listener stanno sulla FINESTRA (il canvas non è focusabile), quindi
    // ricevono anche i tasti battuti nel textarea di editing
    // (ui/TextEditorOverlay.tsx) e nei campi del pannello proprietà: senza la
    // guardia, Backspace mentre si scrive cancella il NODO selezionato -- cioè
    // proprio quello che si sta editando -- ed Escape abbandona il gesto del
    // tool invece di uscire dall'editing. È lo stesso principio della guardia
    // isTextField di ui/App.tsx sulle scorciatoie di undo/redo, applicato
    // all'altro canale di tasti globali.
    if (isTextField(e.target)) return;
    if (e.code === "Space" && !swallowsSpace(e.target)) {
      e.preventDefault(); // niente scroll della pagina
      if (!spaceDown) {
        spaceDown = true;
        temp = handTool;
        active();
      }
      return;
    }
    active().onKeyDown?.(e, ctx);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== "Space" || !spaceDown) return;
    spaceDown = false;
    if (!middlePan) temp = null;
    active();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // I tasti arrivano sulla finestra: il canvas non è focusabile, quindi
  // ascoltarli su di lui significherebbe non riceverli mai.
  const view = canvas.ownerDocument?.defaultView ?? null;
  view?.addEventListener("keydown", onKeyDown);
  view?.addEventListener("keyup", onKeyUp);

  // Aggancia subito il tool attivo (e il suo cursore): così un cambio tool
  // successivo trova sempre un precedente da disattivare, anche se quel tool
  // non aveva ancora ricevuto nessun evento.
  active();

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("wheel", onWheel);
    view?.removeEventListener("keydown", onKeyDown);
    view?.removeEventListener("keyup", onKeyUp);
    release();
    seen?.onDeactivate?.(ctx);
    // Anche il sospeso: smontare non è una pausa, e un tool sospeso durante il
    // pan (spazio ancora premuto) non deve restare col suo gesto appeso.
    if (suspended !== seen) suspended?.onDeactivate?.(ctx);
    seen = null;
    suspended = null;
  };
}
