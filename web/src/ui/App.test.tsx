// I matcher di jest-dom sono già installati dai setupFiles (vite.config.ts);
// l'import qui serve a TYPE-SCRIPT (tsc -b non legge i setupFiles), altrimenti
// toBeInTheDocument/toHaveAttribute non esistono per il compilatore.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { App, TOOLS, TOOL_LABELS, toolsForMode } from "./App";
import { textTool } from "../tools/textTool";
import { penTool } from "../tools/penTool";
import { frameTool } from "../tools/frameTool";
import { selectTool } from "../tools/selectTool";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import * as overlayRenderer from "../renderer/overlayRenderer";

// Il bootstrap di App parla con la rete (createDocument + SyncClient): qui
// serve solo la toolbar, quindi il trasporto è un doppio inerte. Senza, ogni
// test aprirebbe una fetch verso un server che non c'è.
vi.mock("../rpc/client", () => ({
  docClient: { createDocument: vi.fn(async () => ({ id: "doc-1" })) },
}));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));

// jsdom qui non espone localStorage (Node lo disabilita senza
// --localstorage-file): senza stub il bootstrap fallisce e sporca l'output con
// un errore che non c'entra nulla con la toolbar. Con un docId già in cache il
// bootstrap arriva fino ad attachTools, cioè al percorso vero.
vi.stubGlobal("localStorage", {
  getItem: () => "doc-1",
  setItem: () => {},
  removeItem: () => {},
});

afterEach(cleanup);
// I doppi installati con spyOn (getContext, drawOverlay) vanno tolti anche
// quando un'asserzione fallisce a metà test: senza, un rosso ne trascinerebbe
// altri dietro di sé e la causa vera sparirebbe nel rumore.
afterEach(() => vi.restoreAllMocks());

// Il registro dei tool è l'unico punto in cui un ToolId diventa RAGGIUNGIBILE:
// il tool testo era completo e testato ma non compariva né in TOOLS né nella
// toolbar (bug trovato in review), quindi non esisteva per l'utente. Questi
// test tengono chiuso proprio quel buco -- fra i due elenchi e fra elenco e
// tool vero.
describe("registro dei tool", () => {
  it("ogni pulsante della toolbar ha il SUO tool (nessun ripiego silenzioso su selectTool)", () => {
    for (const { id, label } of TOOL_LABELS) {
      const tool = TOOLS[id];
      expect(tool, `${label} (${id}) non è registrato in TOOLS`).toBeDefined();
      // attachTools fa `TOOLS[toolRef.current] ?? selectTool`: una entry
      // mancante non esplode, ripiega su Seleziona -- un pulsante che mente.
      if (id !== "select") expect(tool).not.toBe(selectTool);
    }
  });

  it("ogni tool registrato dichiara l'id con cui è registrato", () => {
    for (const [id, tool] of Object.entries(TOOLS)) {
      expect(tool!.id).toBe(id);
    }
  });

  it("ogni tool registrato ha un pulsante nella toolbar", () => {
    const labelled = new Set(TOOL_LABELS.map((t) => t.id));
    for (const id of Object.keys(TOOLS)) {
      expect(labelled.has(id as (typeof TOOL_LABELS)[number]["id"]), `${id} non ha un pulsante`).toBe(true);
    }
  });

  it("il tool testo è registrato ed è il textTool vero", () => {
    expect(TOOLS.text).toBe(textTool);
    expect(TOOL_LABELS.map((t) => t.label)).toEqual([
      "Seleziona",
      "Collega",
      "Frame",
      "Rettangolo",
      "Ellisse",
      "Testo",
      "Penna",
      "Mano",
    ]);
  });

  it("il tool frame è registrato ed è il frameTool vero", () => {
    expect(TOOLS.frame).toBe(frameTool);
  });

  it("il pen tool è registrato ed è il penTool vero", () => {
    expect(TOOLS.pen).toBe(penTool);
  });
});

// I ToggleButton di un ToggleButtonGroup a selezione singola espongono
// role="radio" dentro un role="radiogroup" (react-aria-components): è la
// semantica giusta per "uno strumento alla volta", e i test la interrogano
// come la interrogherebbe uno screen reader.
describe("toolbar", () => {
  it("mostra un pulsante per ogni tool, Testo compreso", () => {
    render(<App />);
    // Le forme stanno in un solo pulsante (l'ultima usata, di default
    // Rettangolo) con le altre dietro "Altre forme".
    for (const { id, label } of toolsForMode("design")) {
      if (id === "ellipse") continue;
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Altre forme" })).toBeInTheDocument();
    // "Collega" esiste solo nei flussi.
    expect(screen.queryByRole("radio", { name: "Collega" })).not.toBeInTheDocument();
  });

  it("Ellisse si sceglie dal menu delle forme e prende il posto del pulsante", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Altre forme" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ellisse/ }));
    const ellisse = screen.getByRole("radio", { name: "Ellisse" });
    expect(ellisse).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "Rettangolo" })).not.toBeInTheDocument();
  });

  it("premere Testo attiva davvero il tool testo (il cursore del canvas lo dimostra)", () => {
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    expect(canvas.style.cursor).toBe(selectTool.cursor); // stato iniziale: Seleziona

    const testo = screen.getByRole("radio", { name: "Testo" });
    fireEvent.click(testo);

    expect(testo).toHaveAttribute("aria-checked", "true");
    // Il cursore viene da TOOLS[toolId]: "text" solo se la chiave "text"
    // risolve al textTool. Con la entry mancante ripiegherebbe su selectTool
    // ("default") senza dire niente a nessuno.
    expect(canvas.style.cursor).toBe(textTool.cursor);
    expect(textTool.cursor).toBe("text");
  });

  it("premere Penna attiva davvero il pen tool", () => {
    render(<App />);
    const penna = screen.getByRole("radio", { name: "Penna" });
    fireEvent.click(penna);
    expect(penna).toHaveAttribute("aria-checked", "true");
    // Il cursore da solo non basterebbe a distinguerlo (rect ed ellisse usano
    // lo stesso "crosshair"): è TOOLS.pen === penTool, verificato qui sopra, a
    // dire che il pulsante instrada davvero al pen tool.
    expect(TOOLS.pen!.cursor).toBe("crosshair");
  });
});

// L'anteprima del pen tool esiste solo se qualcuno la DISEGNA: App è l'unico
// posto in cui il canale dello store (penPreview) incontra l'overlay. Senza
// questa riga il pen tool funzionerebbe -- op giusti, gesto giusto -- e
// l'utente disegnerebbe alla cieca fino all'ultimo click. È lo stesso buco del
// tool non registrato in TOOLS, un piano più in basso.
describe("ciclo di disegno", () => {
  it("passa l'anteprima del pen tool all'overlay", async () => {
    // jsdom non implementa getContext: senza doppio, drawOverlay non verrebbe
    // mai chiamata (App salta il disegno quando il contesto manca). Il doppio è
    // un Proxy che risponde a QUALUNQUE metodo con un no-op: il ciclo disegna
    // prima la scena e poi l'overlay, e un metodo mancante nel mezzo
    // spegnerebbe il ciclo (l'eccezione muore dentro il requestAnimationFrame)
    // prima di arrivare a quello che stiamo misurando.
    const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
    const fakeCtx = new Proxy(target, {
      get: (t, p) => (p in t ? t[p] : () => {}),
    }) as unknown as CanvasRenderingContext2D;
    // `as never`: i tipi di canvaskit-wasm aggiungono l'overload WebGPU a getContext, e
    // mockReturnValue prende il tipo dell'ULTIMO overload.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
    const drawOverlay = vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);

    const pen = {
      anchors: [{ x: 1, y: 2, inX: 0, inY: 0, outX: 0, outY: 0 }],
      next: { x: 9, y: 9 },
      active: null,
      closed: false,
    };
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    useScene.getState().setPenPreview(pen);

    render(<App />);

    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    // Settimo argomento: l'anteprima del pen tool, esattamente quella dello
    // store (il sesto è ora `snapGuides`, aggiunto dalla traccia rotazione).
    expect(drawOverlay.mock.calls.at(-1)![6]).toBe(pen);

    useScene.getState().setPenPreview(null);
  });
});

// Gli stessi test della toolbar, per lo stesso motivo, applicati ai PANNELLI:
// LayersPanel e PropertiesPanel sono componenti completi e testati, ma finché
// nessuno li monta non esistono per chi usa l'app. App.tsx è l'unico posto in
// cui diventano raggiungibili.
describe("layout a tre colonne", () => {
  it("monta il pannello livelli a SINISTRA del canvas e quello proprietà a DESTRA", () => {
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    const layers = screen.getByRole("grid", { name: "Livelli" });
    const props = screen.getByText("Proprietà");

    expect(layers).toBeInTheDocument();
    expect(props).toBeInTheDocument();

    // L'ORDINE nel documento è l'ordine delle colonne: livelli, canvas,
    // proprietà. compareDocumentPosition è il modo diretto di chiederlo al DOM
    // senza dipendere dalle classi Tailwind.
    const before = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(layers.compareDocumentPosition(canvas) & before).toBeTruthy();
    expect(canvas.compareDocumentPosition(props) & before).toBeTruthy();
  });

  it("i pannelli non stanno SOPRA il canvas: sono suoi fratelli, non lo coprono", () => {
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    const layers = screen.getByRole("grid", { name: "Livelli" });
    // Se un pannello contenesse il canvas (o viceversa) il layout sarebbe a
    // sovrapposizione: i suoi eventi arriverebbero al canvas sotto e la sua
    // larghezza non verrebbe tolta dal calcolo di resizeCanvasToDisplaySize.
    expect(layers.contains(canvas)).toBe(false);
    expect(canvas.contains(layers)).toBe(false);
  });
});


// Stesso principio del registro dei tool: tools/clipboard.ts è completo e
// testato, ma finché App non lo monta Ctrl+C/V/D non esistono per chi usa
// l'app. Qui si verifica solo il MONTAGGIO (il comportamento è in
// tools/clipboard.test.ts) e il fatto che lo smontaggio stacchi i listener.
describe("scorciatoie della clipboard", () => {
  function installScene() {
    const scene = emptyScene("doc-1", "Untitled");
    scene.nodes = scene.nodes.set("n1", {
      id: "n1", parentId: "page1", orderKey: "a000001", name: "Rettangolo",
      visible: true, opacity: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    });
    useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], sync: null });
    useScene.getState().setScene(scene);
    useScene.getState().setSelection(["n1"]);
  }

  it("Ctrl+D duplica: l'app monta davvero le scorciatoie", () => {
    render(<App />);
    installScene();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(2);
  });

  it("smontare l'app le stacca", () => {
    const { unmount } = render(<App />);
    installScene();
    unmount();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(1);
  });
});


// Stesso principio del registro dei tool e delle scorciatoie: export/ è
// completo e testato, ma finché la toolbar non lo monta l'export non esiste per
// chi usa l'app. Qui si verifica solo il montaggio (il comportamento è in
// ui/ExportButton.test.tsx).
describe("export", () => {
  it("la toolbar ha il pulsante Esporta", () => {
    render(<App />);
    const toolbar = screen.getByRole("toolbar", { name: "Strumenti" });
    expect(within(toolbar).getByRole("button", { name: "Esporta" })).toBeInTheDocument();
  });
});

import { docIdFromHash } from "./App";

describe("docIdFromHash", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  it("legge l'id dal link di invito", () => {
    expect(docIdFromHash(`#doc=${id}`)).toBe(id);
    expect(docIdFromHash(`#doc=${id.toUpperCase()}`)).toBe(id);
  });
  it("ignora tutto ciò che non è un id ben formato", () => {
    expect(docIdFromHash("")).toBeNull();
    expect(docIdFromHash("#doc=")).toBeNull();
    expect(docIdFromHash("#doc=../../etc/passwd")).toBeNull();
    expect(docIdFromHash(`#altro=${id}`)).toBeNull();
    expect(docIdFromHash(`#doc=${id}x`)).toBeNull();
  });
});

// Il ciclo di disegno è A INVALIDAZIONE: un editor fermo non ridisegna. Prima
// girava a 60 fps sempre, anche senza nessuna modifica.
describe("ciclo di disegno a invalidazione", () => {
  function setupCtx() {
    const target: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 } };
    const fakeCtx = new Proxy(target, {
      get: (t, p) => (p in t ? t[p] : () => {}),
    }) as unknown as CanvasRenderingContext2D;
    // `as never`: i tipi di canvaskit-wasm aggiungono l'overload WebGPU a getContext, e
    // mockReturnValue prende il tipo dell'ULTIMO overload.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as never);
    return vi.spyOn(overlayRenderer, "drawOverlay").mockImplementation(() => {});
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("da fermo non ridisegna; ogni cambiamento che si vede ne produce uno", async () => {
    const drawOverlay = setupCtx();
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);

    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    await sleep(80); // lascia sfogare i frame di assestamento
    const idle = drawOverlay.mock.calls.length;
    await sleep(250);
    expect(drawOverlay.mock.calls.length).toBe(idle); // niente rAF in giro

    useScene.getState().setSelection(["x"]);
    await waitFor(() => expect(drawOverlay.mock.calls.length).toBeGreaterThan(idle));
    const afterSelection = drawOverlay.mock.calls.length;
    await sleep(120);
    expect(drawOverlay.mock.calls.length).toBe(afterSelection);

    useScene.getState().setCamera({ x: 5, y: 5, zoom: 2 });
    await waitFor(() => expect(drawOverlay.mock.calls.length).toBeGreaterThan(afterSelection));
  });

  it("molte invalidazioni nello stesso frame producono UN disegno", async () => {
    const drawOverlay = setupCtx();
    vi.spyOn(overlayRenderer, "selectionWorldBounds").mockReturnValue(null);
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    await waitFor(() => expect(drawOverlay).toHaveBeenCalled());
    await sleep(80);
    const before = drawOverlay.mock.calls.length;
    for (let i = 0; i < 25; i++) useScene.getState().setCamera({ x: i, y: 0, zoom: 1 });
    await sleep(120);
    expect(drawOverlay.mock.calls.length - before).toBeLessThanOrEqual(2);
    expect(drawOverlay.mock.calls.length - before).toBeGreaterThanOrEqual(1);
  });
});
