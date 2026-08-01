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

// Elementi per cui lo spazio è affare loro: campi di testo (deve scrivere uno
// spazio) e controlli attivabili come i bottoni della toolbar (lo spazio li
// preme). Rubarglielo per il pan darebbe doppia attivazione o testo mangiato.
// Duck-typing invece di instanceof: i test girano in Node, senza HTMLElement.
function swallowsSpace(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A";
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
  let spaceDown = false;
  let middlePan = false;
  let captured: number | null = null;

  // Risolve il tool effettivo e, se è cambiato dall'ultima volta, abbandona il
  // gesto del precedente e aggiorna il cursore.
  function active(): Tool {
    const next = temp ?? getActive();
    if (seen !== next) {
      seen?.onDeactivate?.(ctx);
      seen = next;
      const style = (canvas as { style?: { cursor: string } }).style;
      if (style) style.cursor = next.cursor;
    }
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
    seen = null;
  };
}
