import { describe, it, expect, beforeEach, vi } from "vitest";
import { attachTools, eventToCanvasPoint, wheelZoomFactor } from "./toolManager";
import type { Tool, ToolContext, ToolId } from "./types";
import type { Camera } from "../canvas/camera";
import { screenToWorld } from "../canvas/camera";

// --- doppi DOM ------------------------------------------------------------
// I test girano in Node senza jsdom (come il resto del progetto): questi
// doppi implementano solo la superficie che attachTools usa davvero.
class FakeTarget {
  listeners = new Map<string, { fn: (e: unknown) => void; options?: unknown }[]>();

  addEventListener(type: string, fn: (e: unknown) => void, options?: unknown) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, options });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (e: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((l) => l.fn !== fn));
  }

  dispatch(type: string, event: unknown) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l.fn(event);
  }

  optionsFor(type: string): unknown {
    return this.listeners.get(type)?.[0]?.options;
  }

  total(): number {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
}

class FakeCanvas extends FakeTarget {
  style = { cursor: "" };
  captured: number[] = [];
  released: number[] = [];
  view = new FakeTarget();
  ownerDocument = { defaultView: this.view };

  setPointerCapture(id: number) { this.captured.push(id); }
  releasePointerCapture(id: number) { this.released.push(id); }
  getBoundingClientRect() { return { left: 10, top: 20, width: 800, height: 600 }; }
}

function pointer(x: number, y: number, extra: Record<string, unknown> = {}) {
  return { pointerId: 7, button: 0, clientX: x, clientY: y, preventDefault: vi.fn(), ...extra };
}

function key(code: string, extra: Record<string, unknown> = {}) {
  return { code, key: code === "Space" ? " " : code, repeat: false, target: null, preventDefault: vi.fn(), ...extra };
}

function wheel(deltaY: number, extra: Record<string, unknown> = {}) {
  return { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, clientX: 110, clientY: 220, preventDefault: vi.fn(), ...extra };
}

// --- doppi di dominio -----------------------------------------------------
function spyTool(id: ToolId, cursor = "default") {
  return {
    id, cursor,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onKeyDown: vi.fn(),
    onDeactivate: vi.fn(),
  } satisfies Tool;
}

// Un tool che dichiara di sopravvivere al pan temporaneo: il suo gesto dura
// più di un drag (è il caso del pen tool, che disegna in più click).
function suspendableTool(id: ToolId, cursor = "crosshair") {
  return { ...spyTool(id, cursor), onSuspend: vi.fn() } satisfies Tool;
}

function setup(camera: Camera = { x: 0, y: 0, zoom: 1 }) {
  const canvas = new FakeCanvas();
  let cam = camera;
  const ctx = {
    sync: { submit: vi.fn() },
    getScene: () => null,
    getCamera: () => cam,
    setCamera: (c: Camera) => { cam = c; },
    canvas: canvas as unknown as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => screenToWorld(cam, e.clientX - 10, e.clientY - 20),
  } as unknown as ToolContext;
  return { canvas, ctx, camera: () => cam };
}

let active: Tool;
const getActive = () => active;

beforeEach(() => {
  active = spyTool("select");
});

describe("attachTools routing", () => {
  it("routes pointer events to the active tool with the context", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);

    const down = pointer(100, 100);
    canvas.dispatch("pointerdown", down);
    canvas.dispatch("pointermove", pointer(140, 160));
    canvas.dispatch("pointerup", pointer(140, 160));

    expect(active.onPointerDown).toHaveBeenCalledWith(down, ctx);
    expect(active.onPointerMove).toHaveBeenCalledTimes(1);
    expect(active.onPointerUp).toHaveBeenCalledTimes(1);
    detach();
  });

  it("captures the pointer on down and releases it on up", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);

    canvas.dispatch("pointerdown", pointer(0, 0));
    expect(canvas.captured).toEqual([7]);
    canvas.dispatch("pointerup", pointer(0, 0));
    expect(canvas.released).toEqual([7]);
    detach();
  });

  it("ignores non-primary buttons other than the middle one", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);

    canvas.dispatch("pointerdown", pointer(0, 0, { button: 2 })); // tasto destro
    expect(active.onPointerDown).not.toHaveBeenCalled();
    expect(canvas.captured).toEqual([]);
    detach();
  });

  it("deactivates the previous tool when the active tool changes", () => {
    const { canvas, ctx } = setup();
    const first = active;
    const detach = attachTools(ctx, getActive);

    canvas.dispatch("pointerdown", pointer(0, 0));
    const second = spyTool("rect", "crosshair");
    active = second;
    canvas.dispatch("pointermove", pointer(10, 10));

    expect(first.onDeactivate).toHaveBeenCalledTimes(1);
    expect(second.onPointerMove).toHaveBeenCalledTimes(1);
    expect(canvas.style.cursor).toBe("crosshair");
    detach();
  });

  it("abandons the gesture on pointercancel", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);

    canvas.dispatch("pointerdown", pointer(0, 0));
    canvas.dispatch("pointercancel", pointer(0, 0));
    expect(active.onDeactivate).toHaveBeenCalledTimes(1);
    expect(active.onPointerUp).not.toHaveBeenCalled();
    expect(canvas.released).toEqual([7]);
    detach();
  });

  it("forwards key events to the active tool", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);
    const e = key("Escape");
    canvas.view.dispatch("keydown", e);
    expect(active.onKeyDown).toHaveBeenCalledWith(e, ctx);
    detach();
  });

  // Le scorciatoie del canvas ascoltano sulla FINESTRA (il canvas non è
  // focusabile), quindi ricevono anche i tasti battuti dentro un campo di
  // testo: il textarea di editing (ui/TextEditorOverlay.tsx) e i campi del
  // pannello proprietà. Senza guardia, Backspace mentre si scrive cancella il
  // NODO selezionato -- cioè proprio quello che si sta editando -- ed Escape
  // abbandona il gesto del tool invece di uscire dall'editing.
  it.each([["Backspace"], ["Delete"], ["Escape"]])(
    "non inoltra %s al tool quando il focus è in un campo di testo",
    (k) => {
      const { canvas, ctx } = setup();
      const detach = attachTools(ctx, getActive);
      canvas.view.dispatch("keydown", key(k, { target: { tagName: "TEXTAREA" } }));
      expect(active.onKeyDown).not.toHaveBeenCalled();
      detach();
    },
  );

  it.each([["INPUT"], ["SELECT"]])("non inoltra i tasti battuti dentro un %s", (tagName) => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);
    canvas.view.dispatch("keydown", key("Delete", { target: { tagName } }));
    expect(active.onKeyDown).not.toHaveBeenCalled();
    detach();
  });

  it("non inoltra i tasti battuti dentro un contentEditable", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);
    canvas.view.dispatch("keydown", key("Delete", { target: { tagName: "DIV", isContentEditable: true } }));
    expect(active.onKeyDown).not.toHaveBeenCalled();
    detach();
  });

  it("removes every listener on detach and deactivates the current tool", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);
    canvas.dispatch("pointerdown", pointer(0, 0));
    expect(canvas.total()).toBeGreaterThan(0);
    expect(canvas.view.total()).toBeGreaterThan(0);

    detach();
    expect(canvas.total()).toBe(0);
    expect(canvas.view.total()).toBe(0);
    expect(active.onDeactivate).toHaveBeenCalledTimes(1);
  });
});

describe("temporary hand tool", () => {
  it("space engages the hand tool and keyup restores the previous one", () => {
    const { canvas, ctx, camera } = setup();
    const detach = attachTools(ctx, getActive);

    canvas.view.dispatch("keydown", key("Space"));
    expect(active.onDeactivate).toHaveBeenCalledTimes(1); // il gesto in corso viene abbandonato
    expect(canvas.style.cursor).toBe("grab");

    canvas.dispatch("pointerdown", pointer(100, 100));
    canvas.dispatch("pointermove", pointer(130, 150));
    canvas.dispatch("pointerup", pointer(130, 150));
    expect(camera()).toEqual({ x: 30, y: 50, zoom: 1 });
    expect(active.onPointerDown).not.toHaveBeenCalled();

    canvas.view.dispatch("keyup", key("Space"));
    expect(canvas.style.cursor).toBe("default");
    canvas.dispatch("pointerdown", pointer(0, 0));
    expect(active.onPointerDown).toHaveBeenCalledTimes(1);
    detach();
  });

  it("space is not forwarded to the tool and does not scroll the page", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);
    const e = key("Space");
    canvas.view.dispatch("keydown", e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(active.onKeyDown).not.toHaveBeenCalled();
    detach();
  });

  it.each([["INPUT"], ["TEXTAREA"], ["BUTTON"]])(
    "ignores space when the focus is on a %s (it belongs to that control)",
    (tagName) => {
      const { canvas, ctx, camera } = setup();
      const detach = attachTools(ctx, getActive);

      canvas.view.dispatch("keydown", key("Space", { target: { tagName } }));
      canvas.dispatch("pointerdown", pointer(100, 100));
      canvas.dispatch("pointermove", pointer(130, 150));
      expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(active.onPointerDown).toHaveBeenCalledTimes(1);
      detach();
    },
  );

  // Un tool il cui gesto dura più click (il pen tool) non può perdere il
  // lavoro perché l'utente ha spostato la vista: panare a metà disegno è
  // routine in qualunque editor vettoriale, e il pan temporaneo NON è un cambio
  // di strumento -- la mano restituisce il posto tra un istante.
  it("il pan con lo spazio SOSPENDE un tool che lo dichiara, non lo disattiva", () => {
    const { canvas, ctx } = setup();
    const pen = suspendableTool("pen");
    active = pen;
    const detach = attachTools(ctx, getActive);

    canvas.view.dispatch("keydown", key("Space"));
    expect(pen.onSuspend).toHaveBeenCalledTimes(1);
    expect(pen.onDeactivate).not.toHaveBeenCalled();
    expect(canvas.style.cursor).toBe("grab");

    canvas.view.dispatch("keyup", key("Space"));
    expect(canvas.style.cursor).toBe("crosshair");
    canvas.dispatch("pointerdown", pointer(0, 0));
    // Ripreso senza essere mai stato disattivato: il path a metà è ancora suo.
    expect(pen.onPointerDown).toHaveBeenCalledTimes(1);
    expect(pen.onDeactivate).not.toHaveBeenCalled();
    detach();
  });

  it("anche il pan col tasto CENTRALE sospende invece di disattivare", () => {
    const { canvas, ctx } = setup();
    const pen = suspendableTool("pen");
    active = pen;
    const detach = attachTools(ctx, getActive);

    canvas.dispatch("pointerdown", pointer(100, 100, { button: 1 }));
    canvas.dispatch("pointermove", pointer(120, 100));
    canvas.dispatch("pointerup", pointer(120, 100, { button: 1 }));
    expect(pen.onSuspend).toHaveBeenCalledTimes(1);
    expect(pen.onDeactivate).not.toHaveBeenCalled();
    expect(pen.onPointerDown).not.toHaveBeenCalled(); // il down era della mano
    detach();
  });

  it("un tool SENZA onSuspend continua a essere disattivato dal pan (gesto col pulsante premuto)", () => {
    const { canvas, ctx } = setup();
    const shape = active; // spyTool, nessun onSuspend
    const detach = attachTools(ctx, getActive);

    canvas.view.dispatch("keydown", key("Space"));
    expect(shape.onDeactivate).toHaveBeenCalledTimes(1);
    detach();
  });

  // Sospendere non è tenere in vita per sempre: se durante il pan la toolbar
  // passa a un altro strumento, il sospeso va abbandonato come qualunque tool
  // che perde il posto -- altrimenti resterebbe con un gesto a metà e
  // un'anteprima che nessuno spegne.
  it("cambiare strumento mentre si pana abbandona il tool sospeso", () => {
    const { canvas, ctx } = setup();
    const pen = suspendableTool("pen");
    active = pen;
    const detach = attachTools(ctx, getActive);

    canvas.view.dispatch("keydown", key("Space"));
    const select = spyTool("select");
    active = select;
    canvas.view.dispatch("keyup", key("Space"));

    expect(pen.onDeactivate).toHaveBeenCalledTimes(1);
    expect(select.onDeactivate).not.toHaveBeenCalled();
    detach();
  });

  it("smontare mentre si pana disattiva anche il tool sospeso", () => {
    const { canvas, ctx } = setup();
    const pen = suspendableTool("pen");
    active = pen;
    const detach = attachTools(ctx, getActive);

    canvas.view.dispatch("keydown", key("Space"));
    detach();
    expect(pen.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("the middle button pans for the duration of the drag", () => {
    const { canvas, ctx, camera } = setup();
    const detach = attachTools(ctx, getActive);

    canvas.dispatch("pointerdown", pointer(100, 100, { button: 1 }));
    canvas.dispatch("pointermove", pointer(120, 100));
    expect(camera()).toEqual({ x: 20, y: 0, zoom: 1 });
    expect(active.onPointerDown).not.toHaveBeenCalled();

    canvas.dispatch("pointerup", pointer(120, 100, { button: 1 }));
    canvas.dispatch("pointerdown", pointer(0, 0));
    expect(active.onPointerDown).toHaveBeenCalledTimes(1); // tool ripristinato
    detach();
  });
});

describe("wheel zoom", () => {
  it("zooms out on a positive deltaY and keeps the world point under the cursor", () => {
    const { canvas, ctx, camera } = setup({ x: 0, y: 0, zoom: 1 });
    const detach = attachTools(ctx, getActive);
    const before = screenToWorld(camera(), 100, 200); // punto canvas sotto il cursore

    const e = wheel(100); // clientX 110 - rect.left 10 = 100 ; clientY 220 - top 20 = 200
    canvas.dispatch("wheel", e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(camera().zoom).toBeLessThan(1);
    const after = screenToWorld(camera(), 100, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    detach();
  });

  it("zooms in on a negative deltaY", () => {
    const { canvas, ctx, camera } = setup();
    const detach = attachTools(ctx, getActive);
    canvas.dispatch("wheel", wheel(-100));
    expect(camera().zoom).toBeGreaterThan(1);
    detach();
  });

  it("registers the wheel listener as non-passive so preventDefault works", () => {
    const { canvas, ctx } = setup();
    const detach = attachTools(ctx, getActive);
    expect(canvas.optionsFor("wheel")).toMatchObject({ passive: false });
    detach();
  });
});

describe("wheelZoomFactor", () => {
  it("is 1 for no delta, <1 zooming out, >1 zooming in", () => {
    expect(wheelZoomFactor(wheel(0) as unknown as WheelEvent)).toBe(1);
    expect(wheelZoomFactor(wheel(120) as unknown as WheelEvent)).toBeLessThan(1);
    expect(wheelZoomFactor(wheel(-120) as unknown as WheelEvent)).toBeGreaterThan(1);
  });

  it("scales line and page deltaModes up to pixels", () => {
    const px = wheelZoomFactor(wheel(-16) as unknown as WheelEvent);
    const lines = wheelZoomFactor(wheel(-1, { deltaMode: 1 }) as unknown as WheelEvent);
    expect(lines).toBeCloseTo(px, 6);
    expect(wheelZoomFactor(wheel(-1, { deltaMode: 2 }) as unknown as WheelEvent)).toBeGreaterThan(lines);
  });

  it("treats a ctrlKey wheel (trackpad pinch) as a finer-grained gesture", () => {
    // Il pinch del trackpad arriva come wheel+ctrlKey con delta piccoli: a
    // parità di delta deve zoomare di più, altrimenti il pinch non si sente.
    const pinch = wheelZoomFactor(wheel(-4, { ctrlKey: true }) as unknown as WheelEvent);
    const plain = wheelZoomFactor(wheel(-4) as unknown as WheelEvent);
    expect(pinch).toBeGreaterThan(plain);
  });

  it("clamps absurd deltas so one event cannot swallow the whole zoom range", () => {
    expect(wheelZoomFactor(wheel(100000) as unknown as WheelEvent)).toBeGreaterThan(0);
    expect(wheelZoomFactor(wheel(-100000) as unknown as WheelEvent)).toBeLessThanOrEqual(4);
    expect(wheelZoomFactor(wheel(100000) as unknown as WheelEvent)).toBeGreaterThanOrEqual(0.25);
  });
});

describe("eventToCanvasPoint", () => {
  it("subtracts the canvas origin (client -> canvas px)", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    expect(eventToCanvasPoint(canvas, { clientX: 110, clientY: 220 })).toEqual({ x: 100, y: 200 });
  });
});
