import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { ComponentsPanel } from "./ComponentsPanel";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

// Doppio di SyncClient: registra gli op SUL FILO e modella un server che accetta
// ed ECOA subito (applyPending + apply), come le altre prove dei pannelli.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// Un FRAME master a (100,100), 200x120: contentWorldBounds ne restituisce il
// proprio box (un frame ha geometria propria), quindi l'istanza piazzata prende
// quella dimensione.
function frameNode(id: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a000001", name: "", visible: true, opacity: 1,
    x: 100, y: 100, width: 200, height: 120, rotation: 0,
    fills: [], strokes: [], kind: "frame", cornerRadius: 0, clipsContent: false, ...over,
  };
}

function installWithComponent() {
  const scene = emptyScene("doc-1", "Untitled");
  scene.nodes = scene.nodes.set("master", frameNode("master"));
  scene.components["cmp1"] = { rootNodeId: "master", name: "Bottone" };
  // setScene: installa una scena COERENTE (vista e confermato allineati, coda
  // vuota, storia azzerata), come nelle altre prove dei pannelli.
  useScene.getState().setScene(scene);
}

let sync: FakeSync;

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null });
  useScene.getState().setSync(sync);
});

afterEach(cleanup);

describe("stato vuoto", () => {
  it("senza componenti mostra il vuoto e non elenca nulla", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<ComponentsPanel />);
    expect(screen.getByText("Nessun componente")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("elenco dei componenti", () => {
  it("mostra un pulsante per ogni componente, col suo nome", () => {
    installWithComponent();
    render(<ComponentsPanel />);
    expect(screen.getByRole("button", { name: "Bottone" })).toBeInTheDocument();
  });
});

describe("piazzare un'istanza", () => {
  it("emette UN CreateNode di un nodo kind instance, sotto la pagina corrente, e lo seleziona", async () => {
    installWithComponent();
    render(<ComponentsPanel />);
    const user = userEvent.setup();
    const undoBefore = useScene.getState().undoStack.length;

    await user.click(screen.getByRole("button", { name: "Bottone" }));

    // UN solo op sul filo: una CreateNode con una forma `instance` che punta al
    // componente.
    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("createNode");
    if (op.kind.case !== "createNode") throw new Error("wrong kind");
    const node = op.kind.value.node!;
    expect(node.parentId).toBe("page1"); // la pagina corrente
    expect(node.shape.case).toBe("instance");
    if (node.shape.case === "instance") {
      expect(node.shape.value.componentId).toBe("cmp1");
      expect(node.shape.value.overrides).toEqual([]);
    }
    // Dimensione dal master (frame 200x120) e posizione spostata di 20 dal suo
    // angolo, così non ci cade sopra.
    expect(node.width).toBe(200);
    expect(node.height).toBe(120);
    expect(node.x).toBe(120);
    expect(node.y).toBe(120);

    // Selezionata dopo la creazione, ed è davvero un'istanza nella scena.
    const scene = useScene.getState().scene!;
    expect(useScene.getState().selection).toEqual([node.id]);
    expect(scene.nodes.at(node.id)?.kind).toBe("instance");
    // Un gesto, una voce di undo.
    expect(useScene.getState().undoStack.length).toBe(undoBefore + 1);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("l'istanza piazzata si annulla con Ctrl+Z (un solo gesto)", async () => {
    installWithComponent();
    render(<ComponentsPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Bottone" }));
    const instId = useScene.getState().selection[0];
    expect(useScene.getState().scene!.nodes.at(instId)).toBeDefined();

    useScene.getState().undo();

    expect(useScene.getState().scene!.nodes.at(instId)).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });
});
