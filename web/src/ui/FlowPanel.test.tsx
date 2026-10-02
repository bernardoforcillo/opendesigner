import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FlowReportSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FlowReport, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { FlowPanel } from "./FlowPanel";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { setAnalysisFetcher, useAnalysis } from "../flow/analysis";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { SceneState } from "../store/types";

// Doppio di SyncClient: registra gli op sul filo e li ECOA (come un server che
// accetta), per contare "un op per azione".
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function report(flowId: string, extra: { issues?: MessageInitShape<typeof FlowReportSchema>["issues"]; paths?: MessageInitShape<typeof FlowReportSchema>["paths"] } = {}): FlowReport {
  return create(FlowReportSchema, { flowId, screens: 3, transitions: 2, ...extra });
}

let sync: FakeSync;
function install(scene: SceneState) {
  useScene.getState().setScene(scene);
}
const populated = () =>
  withFlows(baseScene(), [flowOf("f1", "A", "Acquisto"), flowOf("f2", "", "Reso")], [
    transition("t1", "f1", "A", "B", { label: "Avanti", elementId: "btn" }),
    transition("t2", "f1", "B", "C", { guard: "cart=full", effect: "paid=true" }),
    transition("t3", "f2", "C", "A"),
  ]);

beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "flows", currentFlowId: null, selectedTransitionId: null, showAllFlows: false });
  useAnalysis.setState({ reports: {}, status: "idle", error: null, docId: null });
  setAnalysisFetcher(async () => []);
  install(baseScene());
  useScene.getState().setSync(sync);
});
afterEach(() => {
  cleanup();
  setAnalysisFetcher();
});

describe("FlowPanel: flussi", () => {
  it("senza flussi spiega come crearne uno", () => {
    render(<FlowPanel />);
    expect(screen.getByText(/Nessun flusso/)).toBeInTheDocument();
    expect(screen.queryByText("Flusso corrente")).not.toBeInTheDocument();
  });

  it("«+ Nuovo» crea «Flusso 1» (UN op) e lo rende il corrente", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Nuovo flusso" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setFlow"]);
    const flows = Object.values(useScene.getState().scene!.flows);
    expect(flows[0].name).toBe("Flusso 1");
    expect(useFlowUi.getState().currentFlowId).toBe(flows[0].id);
    // e compare nell'elenco, segnato come corrente
    expect(within(screen.getByRole("list", { name: "Flussi" })).getByRole("button", { name: /Flusso 1/ })).toHaveAttribute("aria-current", "true");
  });

  it("elenca i flussi col numero di transizioni; di default il primo per nome è corrente", () => {
    install(populated());
    render(<FlowPanel />);
    const list = screen.getByRole("list", { name: "Flussi" });
    const acquisto = within(list).getByRole("button", { name: /Acquisto/ });
    expect(acquisto).toHaveAttribute("aria-current", "true");
    expect(acquisto).toHaveTextContent("2");
    expect(within(list).getByRole("button", { name: /Reso/ })).not.toHaveAttribute("aria-current");
  });

  it("cliccare un altro flusso lo rende corrente e cambia le transizioni mostrate", () => {
    install(populated());
    render(<FlowPanel />);
    expect(screen.getAllByRole("button", { name: /^Transizione/ })).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("list", { name: "Flussi" })).getByRole("button", { name: /Reso/ }));
    expect(useFlowUi.getState().currentFlowId).toBe("f2");
    expect(screen.getAllByRole("button", { name: /^Transizione/ })).toHaveLength(1);
  });

  it("rinomina: Invio conferma con UN op, nome vuoto o invariato non manda niente", () => {
    install(populated());
    render(<FlowPanel />);
    const field = screen.getByRole("textbox", { name: "Nome del flusso" });
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sync.sent).toHaveLength(0);
    fireEvent.change(field, { target: { value: "Checkout" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setFlow"]);
    expect(useScene.getState().scene!.flows.f1).toMatchObject({ name: "Checkout", startId: "A" });
  });

  it("Invio e blur non confermano due volte", () => {
    install(populated());
    render(<FlowPanel />);
    const field = screen.getByRole("textbox", { name: "Nome del flusso" });
    fireEvent.change(field, { target: { value: "Checkout" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(sync.sent).toHaveLength(1);
  });

  it("«Imposta come inizio» usa la schermata del nodo selezionato (anche un elemento al suo interno)", () => {
    install(populated());
    useFlowUi.setState({ currentFlowId: "f2" }); // f2 non ha inizio
    render(<FlowPanel />);
    const btn = screen.getByRole("button", { name: "Imposta come inizio" });
    expect(btn).toBeDisabled(); // nessuna selezione
    expect(screen.getByTestId("flow-start")).toHaveTextContent("non impostato");

    // un elemento dentro A: lo start diventa A
    act(() => useScene.getState().setSelection(["btn"]));
    expect(screen.getByRole("button", { name: "Imposta come inizio" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Imposta come inizio" }));
    expect(useScene.getState().scene!.flows.f2.startId).toBe("A");
    expect(screen.getByTestId("flow-start")).toHaveTextContent("A");
    // già l'ingresso: disabilitato (niente op a vuoto)
    expect(screen.getByRole("button", { name: "Imposta come inizio" })).toBeDisabled();
  });

  it("un rettangolo sciolto (non una schermata) non può essere l'inizio", () => {
    install(populated());
    render(<FlowPanel />);
    act(() => useScene.getState().setSelection(["loose"]));
    expect(screen.getByRole("button", { name: "Imposta come inizio" })).toBeDisabled();
  });

  it("«Elimina flusso» cancella il flusso (un op) e le sue transizioni", () => {
    install(populated());
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Elimina flusso" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["deleteFlow"]);
    const s = useScene.getState().scene!;
    expect(s.flows.f1).toBeUndefined();
    expect(Object.keys(s.transitions)).toEqual(["t3"]);
    // e Ctrl+Z riporta tutto in UN passo
    useScene.getState().undo();
    expect(Object.keys(useScene.getState().scene!.transitions).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("«Mostra anche gli altri flussi» scrive nello stato di vista", () => {
    install(populated());
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("checkbox", { name: /altri flussi/ }));
    expect(useFlowUi.getState().showAllFlows).toBe(true);
  });
});

describe("FlowPanel: transizioni", () => {
  beforeEach(() => install(populated()));

  it("ogni riga mostra da -> a, etichetta (o innesco), guardia ed effetto", () => {
    render(<FlowPanel />);
    const r1 = screen.getByRole("button", { name: "Transizione A verso B" });
    expect(r1).toHaveTextContent("Avanti");
    const r2 = screen.getByRole("button", { name: "Transizione B verso C" });
    expect(r2).toHaveTextContent("Click");
    expect(r2).toHaveTextContent("se cart=full");
    expect(r2).toHaveTextContent("paid=true");
  });

  it("cliccare una riga la seleziona e apre l'editor; di nuovo la chiude", () => {
    render(<FlowPanel />);
    const row = screen.getByRole("button", { name: "Transizione A verso B" });
    expect(screen.queryByRole("textbox", { name: "Etichetta" })).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(useFlowUi.getState().selectedTransitionId).toBe("t1");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Etichetta" })).toHaveValue("Avanti");
    fireEvent.click(row);
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Etichetta" })).not.toBeInTheDocument();
  });

  it("la camera non si muove se la freccia è già tutta in vista", () => {
    const setCamera = vi.spyOn(useScene.getState(), "setCamera");
    useScene.setState({ camera: { x: 0, y: 0, zoom: 0.5 } });
    render(<FlowPanel />);
    // jsdom: nessun canvas "scene", la vista misura 800x600 di ripiego; A->B (x 200..400) a zoom .5 sta dentro
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    expect(setCamera).not.toHaveBeenCalled();
    setCamera.mockRestore();
  });

  it("la camera inquadra la freccia se è fuori vista", () => {
    useScene.setState({ camera: { x: -5000, y: 0, zoom: 1 } });
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    const cam = useScene.getState().camera;
    expect(cam.x).not.toBe(-5000);
    // ora l'arco A->B (mondo x 200..400) cade nella vista 800x600
    expect(200 * cam.zoom + cam.x).toBeGreaterThanOrEqual(0);
    expect(400 * cam.zoom + cam.x).toBeLessThanOrEqual(800);
  });

  it("modifica in linea: etichetta, guardia, effetto = un op ciascuno; invariato = nessun op", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    const label = screen.getByRole("textbox", { name: "Etichetta" });
    fireEvent.keyDown(label, { key: "Enter" }); // invariata
    expect(sync.sent).toHaveLength(0);

    fireEvent.change(label, { target: { value: "Accedi" } });
    fireEvent.keyDown(label, { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox", { name: "Guardia" }), { target: { value: "user=guest" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Guardia" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Effetto" }), { target: { value: "user=logged" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Effetto" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setTransition", "setTransition", "setTransition"]);
    expect(useScene.getState().scene!.transitions.t1).toMatchObject({
      label: "Accedi", guard: "user=guest", effect: "user=logged", fromId: "A", toId: "B", elementId: "btn",
    });
  });

  it("Escape nel campo scarta la bozza", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    const label = screen.getByRole("textbox", { name: "Etichetta" });
    fireEvent.change(label, { target: { value: "bozza" } });
    fireEvent.keyDown(label, { key: "Escape" });
    fireEvent.blur(label);
    expect(sync.sent).toHaveLength(0);
    expect(label).toHaveValue("Avanti");
  });

  it("i tasti battuti nei campi non arrivano alle scorciatoie globali", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Etichetta" }), { key: "k" });
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("l'innesco è una select con click/submit/auto/key/back", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione B verso C" }));
    const sel = screen.getByRole("combobox", { name: "Innesco" });
    expect(within(sel).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["click", "submit", "auto", "key", "back"]);
    fireEvent.change(sel, { target: { value: "submit" } });
    expect(useScene.getState().scene!.transitions.t2.trigger).toBe("submit");
  });

  it("un innesco di testo libero (da CLI/MCP) resta selezionabile e non si perde", () => {
    const s = useScene.getState().scene!;
    install({ ...s, transitions: { ...s.transitions, t2: { ...s.transitions.t2, trigger: "swipe" } } });
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione B verso C" }));
    const sel = screen.getByRole("combobox", { name: "Innesco" }) as HTMLSelectElement;
    expect(sel.value).toBe("swipe");
  });

  it("l'elemento hotspot si sceglie fra i discendenti della schermata di partenza", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    const sel = screen.getByRole("combobox", { name: "Elemento" }) as HTMLSelectElement;
    expect(sel.value).toBe("btn");
    expect(within(sel).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["", "btn"]);
    fireEvent.change(sel, { target: { value: "" } });
    expect(useScene.getState().scene!.transitions.t1.elementId).toBe("");
  });

  it("«Elimina transizione» la cancella (un op, annullabile) e chiude l'editor", () => {
    render(<FlowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Transizione B verso C" }));
    fireEvent.click(screen.getByRole("button", { name: "Elimina transizione" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["deleteTransition"]);
    expect(useScene.getState().scene!.transitions.t2).toBeUndefined();
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    useScene.getState().undo();
    expect(useScene.getState().scene!.transitions.t2).toBeDefined();
  });

  it("un flusso senza transizioni lo dice", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], []));
    render(<FlowPanel />);
    expect(screen.getByText(/Nessuna transizione/)).toBeInTheDocument();
  });
});

describe("FlowPanel: problemi e percorsi (AnalyzeFlows)", () => {
  const issueReport = () =>
    report("f1", {
      issues: [
        { kind: "dead_end", flowId: "f1", nodeId: "C", transitionId: "", message: "«C» è un vicolo cieco." },
        { kind: "dead_end", flowId: "f1", nodeId: "B", transitionId: "", message: "«B» è un vicolo cieco." },
        { kind: "ambiguous", flowId: "f1", nodeId: "", transitionId: "t2", message: "Due uscite uguali." },
      ],
      paths: [{ transitionIds: ["t1", "t2"], nodeIds: ["A", "B", "C"], loops: false }, { transitionIds: ["t1"], nodeIds: ["A", "B", "A"], loops: true }],
    });

  beforeEach(() => install(populated()));

  it("chiede l'analisi al montaggio e mostra problemi, contatori e percorsi", async () => {
    const fetcher = vi.fn(async () => [issueReport()]);
    setAnalysisFetcher(fetcher);
    render(<FlowPanel />);
    expect(await screen.findByText("«C» è un vicolo cieco.")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("doc");
    const summary = screen.getByLabelText("Riepilogo dei problemi");
    expect(summary).toHaveTextContent("vicoli ciechi: 2");
    expect(summary).toHaveTextContent("ambigue: 1");
    // il numero accanto al titolo
    expect(screen.getByText("Problemi").parentElement).toHaveTextContent("3");

    const paths = screen.getByRole("list", { name: "Percorsi del flusso" });
    expect(within(paths).getByText("A → B → C")).toBeInTheDocument();
    expect(within(paths).getByText("A → B → A ↻")).toBeInTheDocument();
  });

  it("senza problemi: «Nessun problema rilevato»", async () => {
    setAnalysisFetcher(async () => [report("f1")]);
    render(<FlowPanel />);
    expect(await screen.findByText("Nessun problema rilevato.")).toBeInTheDocument();
    expect(screen.getByText(/Nessun percorso/)).toBeInTheDocument();
  });

  it("finché non arriva niente dice che l'analisi è in corso / non disponibile", async () => {
    setAnalysisFetcher(async () => []);
    render(<FlowPanel />);
    await waitFor(() => expect(screen.getByText("Nessuna analisi disponibile.")).toBeInTheDocument());
  });

  it("un errore del server si mostra senza rompere il pannello", async () => {
    setAnalysisFetcher(async () => {
      throw new Error("server giù");
    });
    render(<FlowPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("server giù");
    expect(screen.getByRole("list", { name: "Transizioni" })).toBeInTheDocument();
  });

  it("cliccare un problema di nodo lo seleziona e lo inquadra (se fuori vista)", async () => {
    setAnalysisFetcher(async () => [issueReport()]);
    useScene.setState({ camera: { x: -9000, y: 0, zoom: 1 } });
    render(<FlowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "«C» è un vicolo cieco." }));
    expect(useScene.getState().selection).toEqual(["C"]);
    const cam = useScene.getState().camera;
    // C è a x 800..1000: ora sta in vista
    expect(800 * cam.zoom + cam.x).toBeGreaterThanOrEqual(0);
    expect(1000 * cam.zoom + cam.x).toBeLessThanOrEqual(800);
  });

  it("cliccare un problema di transizione seleziona la freccia e deseleziona i nodi", async () => {
    setAnalysisFetcher(async () => [issueReport()]);
    useScene.getState().setSelection(["A"]);
    render(<FlowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Due uscite uguali." }));
    expect(useFlowUi.getState().selectedTransitionId).toBe("t2");
    expect(useScene.getState().selection).toEqual([]);
  });

  it("cliccare un percorso ne seleziona le schermate", async () => {
    setAnalysisFetcher(async () => [issueReport()]);
    render(<FlowPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "A → B → C" }));
    expect(useScene.getState().selection).toEqual(["A", "B", "C"]);
  });

  it("l'analisi si riprende quando il documento confermato cambia", async () => {
    const fetcher = vi.fn(async () => [report("f1")]);
    setAnalysisFetcher(fetcher);
    render(<FlowPanel />);
    await screen.findByText("Nessun problema rilevato.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Transizione A verso B" }));
    const label = screen.getByRole("textbox", { name: "Etichetta" });
    fireEvent.change(label, { target: { value: "Altro" } });
    fireEvent.keyDown(label, { key: "Enter" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("i problemi mostrati sono quelli del flusso corrente", async () => {
    setAnalysisFetcher(async () => [issueReport(), report("f2", { issues: [{ kind: "no_start", flowId: "f2", nodeId: "", transitionId: "", message: "Reso senza ingresso." }] })]);
    render(<FlowPanel />);
    await screen.findByText("«C» è un vicolo cieco.");
    expect(screen.queryByText("Reso senza ingresso.")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("list", { name: "Flussi" })).getByRole("button", { name: /Reso/ }));
    expect(await screen.findByText("Reso senza ingresso.")).toBeInTheDocument();
  });
});
