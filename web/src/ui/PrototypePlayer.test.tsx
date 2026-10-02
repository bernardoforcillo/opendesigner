import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { PrototypePlayer } from "./PrototypePlayer";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { SceneState } from "../store/types";
import * as renderer from "../renderer/canvasRenderer";

// jsdom non ha un canvas 2D: il disegno vero (drawScene) si spia, e ciò che si
// prova qui è la VISTA del prototipo -- cosa è cliccabile, dove porta, cosa è
// disabilitato e perché.

// jsdom non fa layout: clientWidth/clientHeight valgono 0. L'area del prototipo
// si misura da lì, quindi i test la fingono 800x600 (e uno spegne la finta).
let measured = true;
function stubSize() {
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return measured ? (prop === "clientWidth" ? 800 : 600) : 0;
      },
    });
  }
}

beforeEach(() => {
  measured = true;
  stubSize();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  vi.spyOn(renderer, "drawScene").mockImplementation(() => {});
  useFlowUi.setState({ currentFlowId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

function install(s: SceneState) {
  useScene.getState().setScene(s);
}

// A -> B (hotspot "btn" su A, "Accedi") ; A -> C (barra, guardia utente=admin) ;
// B -> C (barra, "Fine", effetto done=true) ; C senza uscite.
const demo = () =>
  withFlows(baseScene(), [flowOf("f1", "A", "Principale")], [
    transition("t1", "f1", "A", "B", { label: "Accedi", elementId: "btn", effect: "user=guest" }),
    transition("t2", "f1", "A", "C", { label: "Admin", guard: "user=admin" }),
    transition("t3", "f1", "B", "C", { label: "Fine", effect: "done=true" }),
  ]);

describe("PrototypePlayer", () => {
  beforeEach(() => install(demo()));

  it("parte dalla schermata d'ingresso del flusso, con indietro disabilitato", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Prototipo" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("A");
    expect(screen.getByRole("button", { name: "Indietro" })).toBeDisabled();
    // il disegno della schermata parte dal renderer di sempre, sulla scena derivata
    expect(renderer.drawScene).toHaveBeenCalled();
    const scene = vi.mocked(renderer.drawScene).mock.calls.at(-1)![1];
    expect(scene.pages).toHaveLength(1);
    expect(vi.mocked(renderer.drawScene).mock.calls.at(-1)![3]).toBe("__prototype__");
  });

  it("senza ingresso nel flusso ripiega sul primo frame di primo livello", () => {
    install(withFlows(baseScene(), [flowOf("f1", "")], [transition("t", "f1", "A", "B")]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("A");
  });

  it("senza nessun flusso mostra comunque la prima schermata (e non ha uscite)", () => {
    install(baseScene());
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("A");
    expect(screen.getByText(/Fine del percorso/)).toBeInTheDocument();
  });

  it("senza nessuna schermata dice cosa fare", () => {
    install(withFlows({ ...baseScene(), nodes: baseScene().nodes.set("A", { ...baseScene().nodes.at("A"), kind: "rect" }).set("B", { ...baseScene().nodes.at("B"), kind: "rect" }).set("C", { ...baseScene().nodes.at("C"), kind: "rect" }) }, [], []));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByText(/Nessuna schermata da presentare/)).toBeInTheDocument();
  });

  it("una transizione con elemento è una regione cliccabile sopra l'elemento; le altre stanno nella barra", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    // l'hotspot è un <button> fuori dalla barra delle azioni
    const bar = screen.getByRole("group", { name: "Azioni della schermata" });
    const hot = screen.getByRole("button", { name: "Accedi" });
    expect(bar).not.toContainElement(hot);
    // la barra ha "Admin", non "Accedi"
    expect(within(bar).getByRole("button", { name: "Admin" })).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Accedi" })).not.toBeInTheDocument();
  });

  it("l'hotspot sta sopra l'elemento, in coordinate dello schermo scalate per stare nell'area", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    const hot = screen.getByRole("button", { name: "Accedi" });
    // A è 200x300 in un'area 800x600 con 48px di margine: zoom = min(704/200, 504/300) = 1.68
    const z = 504 / 300;
    const camX = 400 - 100 * z;
    const camY = 300 - 150 * z;
    expect(parseFloat(hot.style.left)).toBeCloseTo(60 * z + camX, 1);
    expect(parseFloat(hot.style.top)).toBeCloseTo(200 * z + camY, 1);
    expect(parseFloat(hot.style.width)).toBeCloseTo(80 * z, 1);
    expect(parseFloat(hot.style.height)).toBeCloseTo(30 * z, 1);
  });

  it("senza misura dell'area non si inventano posizioni: gli hotspot ripiegano sulla barra", () => {
    measured = false;
    render(<PrototypePlayer onClose={() => {}} />);
    const bar = screen.getByRole("group", { name: "Azioni della schermata" });
    expect(within(bar).getByRole("button", { name: "Accedi" })).toBeInTheDocument();
  });

  it("un hotspot disabilitato (guardia) resta visibile ma non naviga, e dice perché", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t", "f1", "A", "B", { label: "Paga", elementId: "btn", guard: "cart=full" })]));
    render(<PrototypePlayer onClose={() => {}} />);
    const hot = screen.getByRole("button", { name: "Paga" });
    expect(hot).toHaveAttribute("aria-disabled", "true");
    expect(hot).toHaveAttribute("title", "Richiede cart=full");
    fireEvent.click(hot);
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent(/^A$/);
    expect(screen.getByText(/Paga: Richiede cart=full/)).toBeInTheDocument();
  });

  it("cliccare un'uscita cambia schermata, applica l'effetto e abilita «Indietro»", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Accedi" }));
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("A›B");
    expect(screen.getByRole("button", { name: "Indietro" })).toBeEnabled();
    // il disegno è passato alla nuova schermata
    const scene = vi.mocked(renderer.drawScene).mock.calls.at(-1)![1];
    expect(scene.nodes.at("B").parentId).toBe("__prototype__");
    // variabile impostata dall'effetto
    fireEvent.click(screen.getByRole("button", { name: "Variabili" }));
    const vars = screen.getByRole("complementary", { name: "Variabili del prototipo" });
    expect(vars).toHaveTextContent("user");
    expect(vars).toHaveTextContent("guest");
  });

  it("guardia non soddisfatta: pulsante disabilitato COL MOTIVO, e il click non fa nulla", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    const admin = screen.getByRole("button", { name: "Admin" });
    expect(admin).toBeDisabled();
    expect(screen.getByText("Richiede user=admin")).toBeInTheDocument();
    fireEvent.click(admin);
    expect(screen.getByRole("navigation", { name: "Percorso" })).not.toHaveTextContent("C");
  });

  it("guardia in testo libero: disabilitata con «non valutabile», mai vera in silenzio", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t", "f1", "A", "B", { label: "Premium", guard: "utente premium" })]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Premium" })).toBeDisabled();
    expect(screen.getByText(/Condizione non valutabile: «utente premium»/)).toBeInTheDocument();
  });

  it("la guardia si sblocca quando una variabile la soddisfa", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [
      transition("t1", "f1", "A", "B", { label: "Imposta", effect: "user=admin" }),
      transition("t2", "f1", "B", "A", { label: "Torna" }),
      transition("t3", "f1", "A", "C", { label: "Admin", guard: "user=admin" }),
    ]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Admin" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Imposta" }));
    fireEvent.click(screen.getByRole("button", { name: "Torna" }));
    // di nuovo su A, ma ora user=admin
    expect(screen.getByRole("button", { name: "Admin" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("C");
  });

  it("«Indietro» torna alla schermata e alle variabili di prima", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Accedi" }));
    fireEvent.click(screen.getByRole("button", { name: "Fine" }));
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("C");
    fireEvent.click(screen.getByRole("button", { name: "Indietro" }));
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("A›B");
    fireEvent.click(screen.getByRole("button", { name: "Variabili" }));
    expect(screen.getByRole("complementary", { name: "Variabili del prototipo" })).not.toHaveTextContent("done");
  });

  it("«Ricomincia» riparte dall'ingresso con le variabili azzerate", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Accedi" }));
    fireEvent.click(screen.getByRole("button", { name: "Ricomincia" }));
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent(/^A$/);
    expect(screen.getByRole("button", { name: "Indietro" })).toBeDisabled();
  });

  it("le briciole del percorso sono cliccabili e tornano a quel punto", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Accedi" }));
    fireEvent.click(screen.getByRole("button", { name: "Fine" }));
    const nav = screen.getByRole("navigation", { name: "Percorso" });
    fireEvent.click(within(nav).getByRole("button", { name: "A" }));
    expect(nav).toHaveTextContent(/^A$/);
  });

  it("l'ultima schermata (senza uscite) lo dice", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Accedi" }));
    fireEvent.click(screen.getByRole("button", { name: "Fine" }));
    expect(screen.getByText(/Fine del percorso/)).toBeInTheDocument();
  });

  it("Esc chiude e non arriva agli altri ascoltatori globali; i pulsanti «Esci» chiudono", () => {
    const onClose = vi.fn();
    const other = vi.fn();
    window.addEventListener("keydown", other);
    render(<PrototypePlayer onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    window.removeEventListener("keydown", other);
    fireEvent.click(screen.getByRole("button", { name: "Chiudi il prototipo" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("usa il flusso corrente scelto nell'interfaccia", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A", "Uno"), flowOf("f2", "B", "Due")], [
      transition("t1", "f1", "A", "C", { label: "Da uno" }),
      transition("t2", "f2", "B", "C", { label: "Da due" }),
    ]));
    useFlowUi.setState({ currentFlowId: "f2" });
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Percorso" })).toHaveTextContent("B");
    expect(screen.getByRole("button", { name: "Da due" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Da uno" })).not.toBeInTheDocument();
  });

  it("un arrivo cancellato mentre si presenta: disabilitato col motivo, nessun crash", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t", "f1", "A", "ghost", { label: "Rotto" })]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Rotto" })).toBeDisabled();
    expect(screen.getByText(/non esiste più/)).toBeInTheDocument();
  });
});
