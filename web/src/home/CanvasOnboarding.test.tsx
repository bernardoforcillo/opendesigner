import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasOnboarding, fitCameraToScreens, FIT_MARGIN } from "./CanvasOnboarding";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { emptyScene } from "../store/types";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import { loadDocPrefs, SHIPPED_EVENT } from "./docPrefs";

const client = () => ({ submitOp: vi.fn(async () => ({})) });

function install(scene = emptyScene("doc-1", "Doc")) {
  act(() => useScene.getState().setScene(scene));
}

describe("CanvasOnboarding", () => {
  beforeEach(() => {
    localStorage.clear();
    useScene.getState().setScene(null);
    useFlowUi.getState().setPresenting(false);
  });
  afterEach(cleanup);

  it("a documento vuoto mostra 'Da dove parti?' con i template, 'Disegna una schermata (A)' e i 4 passi", () => {
    install();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    const card = screen.getByRole("region", { name: "Da dove parti?" });
    expect(card).toBeInTheDocument();
    for (const n of ["Onboarding", "Login e registrazione", "Checkout", "Dashboard SaaS"]) {
      expect(screen.getByRole("button", { name: `Applica il template ${n}` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Disegna una schermata/ })).toHaveTextContent("A");
    const steps = screen.getByRole("list", { name: "Passi" }).querySelectorAll("li");
    expect([...steps].map((li) => li.textContent?.replace(/^\d/, ""))).toEqual(["Disegna", "Collega", "Presenta", "Spedisci"]);
    expect([...steps].every((li) => li.getAttribute("data-done") === "false")).toBe(true);
  });

  it("non cattura i click sulla tela: il contenitore è pointer-events-none, solo la scheda li prende", () => {
    install();
    const { container } = render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(container.firstElementChild).toHaveClass("pointer-events-none");
    expect(screen.getByRole("region", { name: "Da dove parti?" })).toHaveClass("pointer-events-auto");
  });

  it("'Disegna una schermata' avvisa l'editor (che attiva il tool frame)", async () => {
    install();
    const onDraw = vi.fn();
    render(<CanvasOnboarding onDrawScreen={onDraw} client={client()} />);
    await userEvent.click(screen.getByRole("button", { name: /Disegna una schermata/ }));
    expect(onDraw).toHaveBeenCalledTimes(1);
  });

  it("un template si applica a QUESTO documento, per RPC, con gli id del documento", async () => {
    install();
    const c = client();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={c} />);
    await userEvent.click(screen.getByRole("button", { name: "Applica il template Onboarding" }));
    await waitFor(() => expect(c.submitOp).toHaveBeenCalled());
    const calls = (c.submitOp as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every(([r]) => r.docId === "doc-1" && r.op.docId === "doc-1")).toBe(true);
    // finché il template non è tutto arrivato la scheda grande resta
    expect(screen.getByRole("region", { name: "Da dove parti?" })).toBeInTheDocument();
  });

  it("la X chiude la scheda e la scelta si ricorda per documento (anche dopo un nuovo montaggio)", async () => {
    install();
    const { unmount } = render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    await userEvent.click(screen.getByRole("button", { name: /non mostrare più/ }));
    expect(screen.queryByRole("region", { name: "Da dove parti?" })).not.toBeInTheDocument();
    expect(loadDocPrefs("doc-1").dismissed).toBe(true);
    unmount();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(screen.queryByRole("region", { name: "Da dove parti?" })).not.toBeInTheDocument();
    // un altro documento non è toccato
    install({ ...emptyScene("doc-2", "Altro") });
    cleanup();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(screen.getByRole("region", { name: "Da dove parti?" })).toBeInTheDocument();
  });

  it("con le schermate la scheda grande lascia il posto ai 'Primi passi', che si spuntano da soli", () => {
    install(baseScene());
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(screen.queryByRole("region", { name: "Da dove parti?" })).not.toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Primi passi" });
    expect(card).toHaveTextContent("1/4");
    const done = () => [...card.querySelectorAll("li")].filter((li) => li.getAttribute("data-done") === "true").map((li) => li.textContent);
    expect(done()).toEqual(["Disegna"]);
    // il documento cambia: nasce una transizione -> Collega si spunta
    act(() => useScene.getState().setScene(withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")])));
    expect(done()).toEqual(["Disegna", "Collega"]);
    expect(card).toHaveTextContent("2/4");
  });

  it("aprire il prototipo spunta 'Presenta' e lo ricorda", () => {
    install(withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]));
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    act(() => useFlowUi.getState().setPresenting(true));
    const card = screen.getByRole("region", { name: "Primi passi" });
    expect(card).toHaveTextContent("3/4");
    expect(loadDocPrefs("doc").presented).toBe(true); // baseScene() ha id "doc"
  });

  it("l'evento di export spunta 'Spedisci'; a checklist completa la scheda sparisce e non torna", () => {
    install(withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]));
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    act(() => useFlowUi.getState().setPresenting(true));
    act(() => { window.dispatchEvent(new Event(SHIPPED_EVENT)); });
    expect(screen.queryByRole("region", { name: "Primi passi" })).not.toBeInTheDocument();
    expect(loadDocPrefs("doc")).toMatchObject({ presented: true, shipped: true, dismissed: true });
  });
});

describe("fitCameraToScreens", () => {
  it("inquadra tutte le schermate, mai oltre 1:1, centrate", () => {
    const cam = fitCameraToScreens(baseScene(), 1000, 600)!;
    // A, B, C: x 0..1000, y 0..300 (200 di larghezza ciascuna, a 400 di passo)
    expect(cam.zoom).toBeCloseTo((1000 - 2 * FIT_MARGIN) / 1000, 5);
    const worldCenterX = 500, worldCenterY = 150;
    expect(worldCenterX * cam.zoom + cam.x).toBeCloseTo(500, 5);
    expect(worldCenterY * cam.zoom + cam.y).toBeCloseTo(300, 5);
  });
  it("una sola schermata piccola non si ingrandisce oltre 1", () => {
    const scene = { ...baseScene() };
    const one = { ...scene, nodes: scene.nodes.delete("B").delete("C") };
    expect(fitCameraToScreens(one, 4000, 3000)!.zoom).toBe(1);
  });
  it("senza schermate o senza spazio non c'è camera", () => {
    expect(fitCameraToScreens(emptyScene("d", "n"), 800, 600)).toBeNull();
    expect(fitCameraToScreens(baseScene(), 0, 0)).toBeNull();
  });
});
