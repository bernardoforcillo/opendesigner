import { describe, it, expect, beforeEach, vi } from "vitest";
import { connectTool, createConnectTool } from "./connectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { SceneState } from "../store/types";

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

function install(scene: SceneState) {
  useScene.getState().setScene(scene);
}

// Geometria della fixture: A x 0..200, B x 400..600, C x 800..1000 (tutte y 0..300);
// btn dentro A a (60,200)..(140,230); `loose` è un rettangolo di pagina a (0,600).
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "flows", currentFlowId: null, selectedTransitionId: null, connectPreview: null });
  install(baseScene());
  useScene.getState().setSync(sync);
});

function drag(tool = connectTool, from: [number, number], to: [number, number], c = ctx()) {
  tool.onPointerDown!(at(...from), c);
  tool.onPointerMove!(at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), c);
  tool.onPointerMove!(at(...to), c);
  tool.onPointerUp!(at(...to), c);
}

describe("connectTool", () => {
  it("è il tool «connect» col cursore a croce", () => {
    expect(connectTool.id).toBe("connect");
    expect(connectTool.cursor).toBe("crosshair");
  });

  it("da una schermata a un'altra crea «Flusso 1» e la transizione click, in UN gesto", () => {
    drag(connectTool, [100, 100], [500, 100]);
    const s = useScene.getState().scene!;
    const flows = Object.values(s.flows);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ name: "Flusso 1", startId: "A" });
    const ts = Object.values(s.transitions);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ fromId: "A", toId: "B", trigger: "click", elementId: "", flowId: flows[0].id });
    // gli op sul filo: setFlow + setTransition, e UNA sola voce di undo
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setFlow", "setTransition"]);
    expect(useScene.getState().undoStack).toHaveLength(1);
    // il flusso diventa il corrente e la nuova freccia è selezionata
    expect(useFlowUi.getState().currentFlowId).toBe(flows[0].id);
    expect(useFlowUi.getState().selectedTransitionId).toBe(ts[0].id);
    // rubber band spento
    expect(useFlowUi.getState().connectPreview).toBeNull();

    useScene.getState().undo();
    expect(useScene.getState().scene!.flows).toEqual({});
    expect(useScene.getState().scene!.transitions).toEqual({});
  });

  it("partire da un elemento lo rende hotspot (elementId), fromId è la sua schermata", () => {
    drag(connectTool, [100, 215], [500, 100]); // dentro btn
    const t = Object.values(useScene.getState().scene!.transitions)[0];
    expect(t).toMatchObject({ fromId: "A", toId: "B", elementId: "btn" });
  });

  it("atterrare su un elemento dentro la schermata di arrivo collega la SCHERMATA", () => {
    drag(connectTool, [500, 100], [100, 215]); // B -> dentro btn (che sta in A)
    const t = Object.values(useScene.getState().scene!.transitions)[0];
    expect(t).toMatchObject({ fromId: "B", toId: "A", elementId: "" });
  });

  it("flusso esistente con ingresso: aggiunge solo la transizione", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], []));
    useFlowUi.setState({ currentFlowId: "f1" });
    drag(connectTool, [500, 100], [900, 100]);
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setTransition"]);
    expect(Object.values(useScene.getState().scene!.transitions)[0]).toMatchObject({ flowId: "f1", fromId: "B", toId: "C" });
  });

  it("flusso senza ingresso: la schermata di partenza lo diventa", () => {
    install(withFlows(baseScene(), [flowOf("f1", "")], []));
    useFlowUi.setState({ currentFlowId: "f1" });
    drag(connectTool, [500, 100], [900, 100]);
    expect(useScene.getState().scene!.flows.f1.startId).toBe("B");
  });

  it("un click senza trascinare non crea niente", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(100, 100), c);
    connectTool.onPointerUp!(at(101, 100), c);
    expect(sync.sent).toHaveLength(0);
    expect(useFlowUi.getState().connectPreview).toBeNull();
  });

  it("rilasciare nel vuoto o su un rettangolo sciolto non crea niente", () => {
    drag(connectTool, [100, 100], [300, 500]); // il vuoto fra le schermate e `loose`
    drag(connectTool, [100, 100], [20, 620]); // `loose` non è una schermata
    expect(sync.sent).toHaveLength(0);
  });

  it("partire dal vuoto o da un rettangolo sciolto non avvia nessun gesto", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(300, 500), c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    connectTool.onPointerDown!(at(20, 620), c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    connectTool.onPointerUp!(at(500, 100), c);
    expect(sync.sent).toHaveLength(0);
  });

  it("una schermata verso se stessa solo da un elemento", () => {
    drag(connectTool, [100, 100], [150, 150]); // A -> A senza hotspot: niente
    expect(sync.sent).toHaveLength(0);
    drag(connectTool, [100, 215], [150, 50]); // btn -> A: un «ricarica»
    expect(Object.values(useScene.getState().scene!.transitions)[0]).toMatchObject({ fromId: "A", toId: "A", elementId: "btn" });
  });

  it("durante il drag il rubber band segue il puntatore e dice la schermata di arrivo", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(100, 100), c);
    expect(useFlowUi.getState().connectPreview).toMatchObject({
      fromScreenId: "A", elementId: "", fromBounds: { x: 0, y: 0, width: 200, height: 300 }, targetId: null,
    });
    connectTool.onPointerMove!(at(500, 120), c);
    expect(useFlowUi.getState().connectPreview).toMatchObject({ x: 500, y: 120, targetId: "B" });
    connectTool.onPointerMove!(at(300, 120), c);
    expect(useFlowUi.getState().connectPreview?.targetId).toBeNull();
    // e l'hotspot di partenza è il box dell'elemento
    connectTool.onPointerUp!(at(300, 120), c);
    connectTool.onPointerDown!(at(100, 215), c);
    expect(useFlowUi.getState().connectPreview).toMatchObject({ elementId: "btn", fromBounds: { x: 60, y: 200, width: 80, height: 30 } });
  });

  it("Escape annulla il gesto: nessun op, rubber band spento", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(100, 100), c);
    connectTool.onPointerMove!(at(500, 100), c);
    connectTool.onKeyDown!({ key: "Escape" } as KeyboardEvent, c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    connectTool.onPointerUp!(at(500, 100), c);
    expect(sync.sent).toHaveLength(0);
  });

  it("cambiare tool (onDeactivate) abbandona il gesto a metà", () => {
    const c = ctx();
    const tool = createConnectTool();
    tool.onPointerDown!(at(100, 100), c);
    tool.onDeactivate!(c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    tool.onPointerUp!(at(500, 100), c);
    expect(sync.sent).toHaveLength(0);
  });

  it("più collegamenti fra le stesse due schermate sono transizioni distinte", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t0", "f1", "A", "B")]));
    useFlowUi.setState({ currentFlowId: "f1" });
    drag(connectTool, [100, 100], [500, 100]);
    expect(Object.keys(useScene.getState().scene!.transitions)).toHaveLength(2);
  });

  it("zoom e pan: il hit-test passa dalla camera (ctx.toWorld è già mondo)", () => {
    useScene.setState({ camera: { x: 50, y: 0, zoom: 0.5 } });
    // il mock di toWorld ignora la camera: qui basta che lo zoom non rompa lo slop
    drag(connectTool, [100, 100], [500, 100]);
    expect(Object.keys(useScene.getState().scene!.transitions)).toHaveLength(1);
  });
});
