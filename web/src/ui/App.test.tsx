// I matcher di jest-dom sono già installati dai setupFiles (vite.config.ts);
// l'import qui serve a TYPE-SCRIPT (tsc -b non legge i setupFiles), altrimenti
// toBeInTheDocument/toHaveAttribute non esistono per il compilatore.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App, TOOLS, TOOL_LABELS } from "./App";
import { textTool } from "../tools/textTool";
import { selectTool } from "../tools/selectTool";

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
      "Rettangolo",
      "Ellisse",
      "Testo",
      "Mano",
    ]);
  });
});

// I ToggleButton di un ToggleButtonGroup a selezione singola espongono
// role="radio" dentro un role="radiogroup" (react-aria-components): è la
// semantica giusta per "uno strumento alla volta", e i test la interrogano
// come la interrogherebbe uno screen reader.
describe("toolbar", () => {
  it("mostra un pulsante per ogni tool, Testo compreso", () => {
    render(<App />);
    for (const { label } of TOOL_LABELS) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
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

