import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Op } from "../../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../../store/store";
import { useFlowUi } from "../../store/flowUi";
import { useAnalysis, setAnalysisFetcher } from "../../flow/analysis";
import { nodesWith } from "../../store/nodeMap";
import { emptyScene } from "../../store/types";
import { baseScene, flowOf, transition, withFlows } from "../../flow/testSupport";
import { resetCodegen, setCodeFetcher, type CodeFetcher, type CodeFile } from "../../dev/codegen";
import { ReadinessPanel } from "./ReadinessPanel";
import { ShipPanel } from "./ShipPanel";
import { CodeWorkbench } from "./CodeWorkbench";
import { PipelineStepper, goToStep } from "./PipelineStepper";
import { usePanels } from "../shell/panels";

// I TRE PANNELLI DI SVILUPPO con l'RPC finto: la checklist e le sue correzioni a
// un click (un gesto = un undo), Spedisci (lo zip e i comandi), la vista codice
// (stati di caricamento/errore, file <-> schermata, anteprima) e lo stepper.

const downloads: { name: string; bytes: Uint8Array }[] = [];
vi.mock("../../dev/zip", async (orig) => ({
  ...(await orig<typeof import("../../dev/zip")>()),
  downloadBytes: (name: string, bytes: Uint8Array) => { downloads.push({ name, bytes }); return true; },
}));

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const f = (path: string, text: string): CodeFile => ({ path, bytes: enc(text) });
const reactFiles = (): CodeFile[] => [
  f("src/screens/A.tsx", '<div data-node-id="A" className="x">A</div>'),
  f("src/screens/B.tsx", '<div data-node-id="B" className="y">B</div>'),
  f("src/App.tsx", "export default function App() {}"),
  f("package.json", '{"name":"x"}'),
  f("tests/flows.spec.ts", "test('x', () => {})"),
];
const htmlFiles = (): CodeFile[] => [
  f("index.html", '<html><body><div data-node-id="A">Pagina A</div><a href="b.html">vai</a></body></html>'),
  f("b.html", '<html><body><div data-node-id="B">Pagina B</div></body></html>'),
];
const ok: CodeFetcher = async (_d, target) => ({ files: target === "html" ? htmlFiles() : reactFiles(), warnings: [] });

let sync: FakeSync;
beforeEach(() => {
  downloads.length = 0;
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "dev", currentFlowId: null, presenting: false });
  useAnalysis.setState({ reports: {}, status: "idle", error: null, docId: null });
  setAnalysisFetcher(async () => []);
  setCodeFetcher(ok);
  resetCodegen();
  useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "A", "Acquisto")], [transition("t1", "f1", "A", "B", { label: "Avanti" })]));
  useScene.getState().setSync(sync);
  try { localStorage.clear(); } catch { /* */ }
});
afterEach(() => {
  cleanup();
  setCodeFetcher();
  setAnalysisFetcher();
});

const withReport = (issues: { kind: string; nodeId?: string }[] = []) =>
  useAnalysis.setState({
    reports: { f1: { flowId: "f1", issues: issues.map((i) => ({ nodeId: "", transitionId: "", message: `msg ${i.kind}`, ...i })) } as never },
    docId: "doc",
  });

describe("ReadinessPanel", () => {
  it("mostra i bloccanti e le correzioni; 'Assegna le rotte' scrive TUTTE le rotte in UN gesto (un solo Ctrl+Z)", () => {
    withReport();
    render(<ReadinessPanel />);
    expect(screen.getByText("3 bloccanti")).toBeInTheDocument();
    expect(screen.getByTestId("ready-routes")).toHaveAttribute("data-state", "fail");

    fireEvent.click(screen.getByRole("button", { name: "Assegna le rotte" }));
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setProps", "setProps", "setProps"]);
    const nodes = useScene.getState().scene!.nodes;
    expect(["A", "B", "C"].map((id) => nodes.at(id)!.meta?.["code.route"])).toEqual(["/a", "/b", "/c"]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // risolto: il badge diventa "Pronto" e la riga passa
    expect(screen.getByText("Pronto")).toBeInTheDocument();
    expect(screen.getByTestId("ready-routes")).toHaveAttribute("data-state", "pass");

    act(() => useScene.getState().undo());
    expect(useScene.getState().scene!.nodes.at("A")!.meta?.["code.route"]).toBeUndefined();
  });

  it("'Imposta l'inizio' imposta la schermata d'ingresso dei flussi che ne sono privi", () => {
    useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "")], [transition("t1", "f1", "B", "C", { label: "x" })]));
    withReport();
    render(<ReadinessPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Imposta l'inizio" }));
    expect(useScene.getState().scene!.flows.f1.startId).toBe("B");
    expect(screen.getByTestId("ready-start")).toHaveAttribute("data-state", "pass");
  });

  it("'Seleziona la schermata' porta alla schermata del problema", () => {
    withReport([{ kind: "unreachable", nodeId: "C" }]);
    render(<ReadinessPanel />);
    const row = screen.getByTestId("ready-issue:unreachable");
    expect(row).toHaveAttribute("data-state", "fail");
    fireEvent.click(within(row).getByRole("button", { name: "Seleziona la schermata" }));
    expect(useScene.getState().selection).toEqual(["C"]);
  });

  it("senza analisi del server le righe dipendenti sono 'pending' e non contano come bloccanti", () => {
    useScene.getState().setScene(withFlows(
      baseScene(), [flowOf("f1", "A")], [transition("t1", "f1", "A", "B", { label: "x" })],
    ));
    render(<ReadinessPanel />);
    expect(screen.getByTestId("ready-analysis")).toHaveAttribute("data-state", "pending");
    expect(screen.getByText("3 bloccanti")).toBeInTheDocument(); // solo le tre rotte
  });

  it("la barra di avanzamento conta gli stati", () => {
    const s = baseScene();
    const tested = { ...s.nodes.at("A")!, meta: { status: "tested" } };
    useScene.getState().setScene({ ...s, nodes: nodesWith(s.nodes, { A: tested }) });
    withReport();
    render(<ReadinessPanel />);
    expect(screen.getByRole("img", { name: /1 testate, 0 implementate, 2 pianificate su 3/ })).toBeInTheDocument();
  });
});

describe("ShipPanel", () => {
  it("scarica <doc>-react.zip con i file generati (rigenerando al momento del click)", async () => {
    const spy = vi.fn(ok);
    setCodeFetcher(spy);
    withReport();
    render(<ShipPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^t-react\.zip$/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("t-react.zip");
    expect(spy).toHaveBeenCalledWith("doc", "react", expect.anything());
    expect(Array.from(downloads[0].bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);
  });

  it("un errore del server si dice, e non scarica niente", async () => {
    setCodeFetcher(async () => { throw new Error("giù"); });
    render(<ShipPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^t-react\.zip$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("giù");
    expect(downloads).toHaveLength(0);
  });

  it("mostra i comandi copiabili e i tool per gli agenti; 'Copia tutto' copia lo script", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ShipPanel />);
    expect(screen.getByText("npx playwright test")).toBeInTheDocument();
    expect(screen.getByText("opendesigner flow check -doc t")).toBeInTheDocument();
    for (const tool of ["export_code", "get_flow_spec", "analyze_flows"]) expect(screen.getByText(tool)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copia tutto" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const script = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain("npm i && npm run dev");
    expect(script).toContain("opendesigner flow coverage");
  });

  it("senza schermate il pulsante dello zip è disabilitato", () => {
    useScene.getState().setScene(emptyScene("doc", "t"));
    render(<ShipPanel />);
    expect(screen.getByRole("button", { name: /^t-react\.zip$/ })).toBeDisabled();
  });
});

describe("CodeWorkbench", () => {
  it("genera il codice, raggruppa i file e mostra il primo file di schermata", async () => {
    render(<CodeWorkbench />);
    expect(await screen.findByTestId("code-text")).toHaveTextContent('data-node-id="A"');
    const nav = screen.getByRole("navigation", { name: "File generati" });
    for (const name of ["Schermate", "App", "Configurazione", "Test"]) expect(within(nav).getByRole("region", { name })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "src/screens/A.tsx" })).toHaveAttribute("aria-current", "true");
  });

  it("la schermata selezionata nel documento seleziona il suo file, e viceversa", async () => {
    render(<CodeWorkbench />);
    await screen.findByTestId("code-text");
    act(() => useScene.getState().setSelection(["B"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "src/screens/B.tsx" })).toHaveAttribute("aria-current", "true"));
    // un figlio della schermata (btn è dentro A) seleziona il file di A
    act(() => useScene.getState().setSelection(["btn"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "src/screens/A.tsx" })).toHaveAttribute("aria-current", "true"));
    // cliccare un file di schermata seleziona la schermata nel documento
    fireEvent.click(screen.getByRole("button", { name: "src/screens/B.tsx" }));
    expect(useScene.getState().selection).toEqual(["B"]);
    // un file che non è una schermata si apre senza toccare la selezione
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    expect(screen.getByTestId("code-text")).toHaveTextContent('"name"');
    expect(useScene.getState().selection).toEqual(["B"]);
  });

  it("stato di caricamento, poi errore con 'Riprova' che rifà la richiesta", async () => {
    let fail = true;
    setCodeFetcher(async (d, t, s) => {
      if (fail) throw new Error("server giù");
      return ok(d, t, s);
    });
    render(<CodeWorkbench />);
    expect(await screen.findByText("Non riesco a generare il codice")).toBeInTheDocument();
    expect(screen.getByText("server giù")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    expect(await screen.findByTestId("code-text")).toBeInTheDocument();
  });

  it("mentre carica dice che sta generando", async () => {
    setCodeFetcher(() => new Promise(() => {}));
    render(<CodeWorkbench />);
    expect((await screen.findAllByText("Genero il codice…")).length).toBeGreaterThan(0);
  });

  it("il target HTML mostra i file HTML; 'Anteprima' mette la schermata generata in un iframe sandboxed", async () => {
    render(<CodeWorkbench />);
    await screen.findByTestId("code-text");
    fireEvent.click(screen.getByRole("radio", { name: "HTML" }));
    expect(await screen.findByRole("button", { name: "index.html" })).toBeInTheDocument();

    expect(screen.queryByTitle("Anteprima della schermata generata")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anteprima" }));
    const frame = (await screen.findByTitle("Anteprima della schermata generata")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); // niente allow-same-origin
    expect(frame.getAttribute("srcdoc")).toContain("Pagina A");

    // selezionando B si vede B
    act(() => useScene.getState().setSelection(["B"]));
    await waitFor(() => expect((screen.getByTitle("Anteprima della schermata generata") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("Pagina B"));
  });

  it("un click su un link dentro l'anteprima (postMessage) cambia la schermata mostrata e selezionata", async () => {
    render(<CodeWorkbench />);
    fireEvent.click(await screen.findByRole("button", { name: "Anteprima" }));
    const frame = (await screen.findByTitle("Anteprima della schermata generata")) as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("Pagina A"));
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { odPreviewNav: "b.html" }, source: frame.contentWindow }));
    });
    await waitFor(() => expect(screen.getByTitle("Anteprima della schermata generata").getAttribute("srcdoc")).toContain("Pagina B"));
    expect(useScene.getState().selection).toEqual(["B"]);
    // un messaggio da un'altra finestra si ignora
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { odPreviewNav: "index.html" }, source: window }));
    });
    expect(screen.getByTitle("Anteprima della schermata generata").getAttribute("srcdoc")).toContain("Pagina B");
  });

  it("un file molto lungo si monta a pezzi: 'Mostra tutte le righe'", async () => {
    const long = Array.from({ length: 2000 }, (_, i) => `const a${i} = ${i};`).join("\n");
    setCodeFetcher(async () => ({ files: [f("src/screens/A.tsx", `<div data-node-id="A"/>\n${long}`)], warnings: [] }));
    render(<CodeWorkbench />);
    const more = await screen.findByRole("button", { name: /Mostra tutte le 2001 righe/ });
    expect(screen.getByTestId("code-text").textContent).not.toContain("a1999");
    fireEvent.click(more);
    expect(screen.getByTestId("code-text").textContent).toContain("a1999");
  });

  it("le approssimazioni del generatore si possono aprire", async () => {
    setCodeFetcher(async () => ({ files: reactFiles(), warnings: ["asset mancante"] }));
    render(<CodeWorkbench />);
    fireEvent.click(await screen.findByRole("button", { name: /1 approssimazione/ }));
    expect(screen.getByText("asset mancante")).toBeInTheDocument();
  });

  it("fuori da Sviluppo non c'è lavoro: smontato, la richiesta in volo è annullata", async () => {
    let signal!: AbortSignal;
    setCodeFetcher((_d, _t, s) => { signal = s; return new Promise(() => {}); });
    const { unmount } = render(<CodeWorkbench />);
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("PipelineStepper", () => {
  it("mostra i quattro passi con lo stato dedotto dal documento", async () => {
    withReport();
    render(<PipelineStepper />);
    const nav = screen.getByRole("navigation", { name: "Pipeline" });
    const step = (id: string) => nav.querySelector(`[data-step="${id}"]`)!;
    expect(step("draw")).toHaveAttribute("data-done", "true");
    expect(step("connect")).toHaveAttribute("data-done", "true");
    expect(step("try")).toHaveAttribute("data-done", "false");
    expect(step("ship")).toHaveAttribute("data-done", "false"); // 3 rotte mancanti
    expect(step("ship")).toHaveAttribute("aria-current", "step"); // siamo in Sviluppo
  });

  it("i click portano dove si lavora", () => {
    withReport();
    render(<PipelineStepper />);
    const nav = screen.getByRole("navigation", { name: "Pipeline" });
    fireEvent.click(nav.querySelector('[data-step="draw"]')!);
    expect(useFlowUi.getState().mode).toBe("design");
    fireEvent.click(nav.querySelector('[data-step="connect"]')!);
    expect(useFlowUi.getState().mode).toBe("flows");
    expect(useFlowUi.getState().presenting).toBe(false);
    fireEvent.click(nav.querySelector('[data-step="try"]')!);
    expect(useFlowUi.getState()).toMatchObject({ mode: "flows", presenting: true });
    // aver presentato accende il passo (flag per documento)
    expect(localStorage.getItem("od.presented.doc")).toBe("1");
  });

  it("Spedisci riapre il pannello destro se era chiuso; Prova senza flussi si ferma ai Flussi", () => {
    usePanels.setState({ left: true, right: false });
    goToStep("ship", true);
    expect(useFlowUi.getState().mode).toBe("dev");
    expect(usePanels.getState().right).toBe(true);
    goToStep("try", false);
    expect(useFlowUi.getState()).toMatchObject({ mode: "flows", presenting: false });
  });
});
