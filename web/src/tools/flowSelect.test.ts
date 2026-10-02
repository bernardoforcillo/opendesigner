import { describe, it, expect, beforeEach, vi } from "vitest";
import { pickArrow, withFlowArrows } from "./flowSelect";
import type { Tool, ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

let sync: FakeSync;
function ctx(): ToolContext {
  return {
    sync,
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;
const key = (k: string) => ({ key: k }) as KeyboardEvent;

function fakeBase() {
  const base: Tool = {
    id: "select", cursor: "default",
    onPointerDown: vi.fn(), onPointerMove: vi.fn(), onPointerUp: vi.fn(), onKeyDown: vi.fn(), onDeactivate: vi.fn(),
  };
  return base;
}

// A->B passa da (300,150): la freccia t1 sta su quella riga fra x 200 e 400.
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["A"], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "flows", currentFlowId: null, showAllFlows: false, selectedTransitionId: null, hoverTransitionId: null });
  useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "A", "Alfa"), flowOf("f2", "A", "Zeta")], [
    transition("t1", "f1", "A", "B"),
    transition("t2", "f2", "B", "C"),
  ]));
  useScene.getState().setSync(sync);
});

describe("withFlowArrows", () => {
  it("conserva id e cursore del tool di base", () => {
    const t = withFlowArrows(fakeBase());
    expect(t.id).toBe("select");
    expect(t.cursor).toBe("default");
  });

  it("in Design delega sempre, senza guardare le frecce", () => {
    useFlowUi.setState({ mode: "design" });
    const base = fakeBase();
    const t = withFlowArrows(base);
    t.onPointerDown!(at(300, 150), ctx());
    expect(base.onPointerDown).toHaveBeenCalledTimes(1);
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
  });

  it("in Flussi un click sulla freccia la seleziona e NON arriva al tool di selezione", () => {
    const base = fakeBase();
    const t = withFlowArrows(base);
    const c = ctx();
    t.onPointerDown!(at(300, 151), c);
    expect(useFlowUi.getState().selectedTransitionId).toBe("t1");
    // i nodi si deselezionano: la scelta è una sola
    expect(useScene.getState().selection).toEqual([]);
    t.onPointerMove!(at(310, 150), c);
    t.onPointerUp!(at(310, 150), c);
    expect(base.onPointerDown).not.toHaveBeenCalled();
    expect(base.onPointerMove).not.toHaveBeenCalled();
    expect(base.onPointerUp).not.toHaveBeenCalled();
    // finito il gesto, il prossimo click torna normale
    t.onPointerDown!(at(100, 100), c);
    expect(base.onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("un click altrove deseleziona la freccia e passa al tool di selezione", () => {
    useFlowUi.setState({ selectedTransitionId: "t1" });
    const base = fakeBase();
    withFlowArrows(base).onPointerDown!(at(100, 100), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(base.onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("si colpisce la pillola dell'etichetta anche lontano dal tratto", () => {
    const base = fakeBase();
    // il punto medio è (300,150): 8px sopra è fuori dal tratto (6) ma dentro la pillola
    withFlowArrows(base).onPointerDown!(at(300, 142), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBe("t1");
  });

  it("solo le frecce del flusso corrente, a meno di «mostra tutti»", () => {
    const t = withFlowArrows(fakeBase());
    // t2 (B->C, flusso f2) è sulla riga (700,150); il flusso corrente è il primo per nome: f1
    t.onPointerDown!(at(700, 150), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    useFlowUi.setState({ showAllFlows: true });
    t.onPointerDown!(at(700, 150), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBe("t2");
  });

  it("l'hover si aggiorna al pointermove e si spegne altrove", () => {
    const t = withFlowArrows(fakeBase());
    const c = ctx();
    t.onPointerMove!(at(300, 150), c);
    expect(useFlowUi.getState().hoverTransitionId).toBe("t1");
    t.onPointerMove!(at(100, 100), c);
    expect(useFlowUi.getState().hoverTransitionId).toBeNull();
  });

  it("l'hover non si calcola durante un gesto aperto (un drag di nodi)", () => {
    useScene.setState({ gesture: { selection: [], preview: new Map() } });
    const t = withFlowArrows(fakeBase());
    t.onPointerMove!(at(300, 150), ctx());
    expect(useFlowUi.getState().hoverTransitionId).toBeNull();
  });

  it("Canc sulla freccia scelta la cancella (un op, annullabile) e non tocca i nodi", () => {
    useFlowUi.setState({ selectedTransitionId: "t1" });
    const base = fakeBase();
    withFlowArrows(base).onKeyDown!(key("Delete"), ctx());
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["deleteTransition"]);
    expect(useScene.getState().scene!.transitions.t1).toBeUndefined();
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(base.onKeyDown).not.toHaveBeenCalled();
    useScene.getState().undo();
    expect(useScene.getState().scene!.transitions.t1).toBeDefined();
  });

  it("Canc con la freccia già sparita (cancellata da un peer) non manda niente", () => {
    useFlowUi.setState({ selectedTransitionId: "ghost" });
    withFlowArrows(fakeBase()).onKeyDown!(key("Backspace"), ctx());
    expect(sync.sent).toHaveLength(0);
  });

  it("Escape deseleziona la freccia; senza freccia il tasto va al tool di base", () => {
    useFlowUi.setState({ selectedTransitionId: "t1" });
    const base = fakeBase();
    const t = withFlowArrows(base);
    t.onKeyDown!(key("Escape"), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(base.onKeyDown).not.toHaveBeenCalled();
    t.onKeyDown!(key("Escape"), ctx());
    expect(base.onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("onDeactivate azzera il gesto armato e delega", () => {
    const base = fakeBase();
    const t = withFlowArrows(base);
    const c = ctx();
    t.onPointerDown!(at(300, 150), c); // arma
    t.onDeactivate!(c);
    expect(base.onDeactivate).toHaveBeenCalledTimes(1);
    t.onPointerUp!(at(0, 0), c);
    expect(base.onPointerUp).toHaveBeenCalledTimes(1);
  });
});

describe("pickArrow", () => {
  it("scena senza transizioni: null senza costruire niente", () => {
    useScene.getState().setScene(baseScene());
    expect(pickArrow(ctx(), 300, 150)).toBeNull();
  });

  it("la tolleranza è in px schermo: a zoom basso la presa in unità mondo cresce", () => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 0.25 } });
    // 20 unità mondo = 5px schermo: dentro i 6px di presa
    expect(pickArrow(ctx(), 250, 170)?.id).toBe("t1");
    useScene.setState({ camera: { x: 0, y: 0, zoom: 4 } });
    // a zoom 4 la presa è 1.5 unità mondo: 5 sopra è fuori
    expect(pickArrow(ctx(), 250, 155)).toBeNull();
  });
});
