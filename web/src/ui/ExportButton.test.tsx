import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ExportButton } from "./ExportButton";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function node(id: string): NodeLite {
  return {
    id, parentId: "page1", orderKey: "a1", name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

function install(selection: string[]): void {
  const scene = emptyScene("doc", "Untitled");
  scene.nodes = scene.nodes.set("n1", node("n1"));
  useScene.setState({ scene, selection, gesture: null, notice: null });
}

// La sequenza di un click vero del mouse, con `pressure: 0.5` esplicito: è la
// stessa di ui/LayersPanel.test.tsx::press e per la stessa ragione (usePress di
// react-aria scambia per "virtuale" un PointerEvent senza pressione, che è
// quello che jsdom costruisce di default). Vale per i Button di RAC; i radio
// sono `<input type=radio>` veri e rispondono al click semplice.
function press(el: Element) {
  const base = { button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, detail: 1 };
  fireEvent.pointerDown(el, { ...base, pressure: 0.5 });
  fireEvent.mouseDown(el, base);
  fireEvent.pointerUp(el, { ...base, pressure: 0 });
  fireEvent.mouseUp(el, base);
  fireEvent.click(el, base);
}

function radio(name: string): HTMLInputElement {
  return screen.getByRole("radio", { name }) as HTMLInputElement;
}

async function open(): Promise<void> {
  press(screen.getByRole("button", { name: "Esporta" }));
  await screen.findByRole("radio", { name: "PNG" });
}

beforeEach(() => install([]));
afterEach(cleanup);

describe("ExportButton", () => {
  it("apre i controlli di export", async () => {
    render(<ExportButton onExport={vi.fn()} />);
    await open();
    expect(radio("PNG")).toBeInTheDocument();
    expect(radio("SVG")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scarica" })).toBeInTheDocument();
  });

  it("con una selezione, l'ambito parte dalla SELEZIONE", async () => {
    install(["n1"]);
    render(<ExportButton onExport={vi.fn()} />);
    await open();
    expect(radio("Selezione")).toBeChecked();
  });

  it("senza selezione, esportare la selezione non è nemmeno offerto", async () => {
    render(<ExportButton onExport={vi.fn()} />);
    await open();
    expect(radio("Selezione")).toBeDisabled();
    expect(radio("Pagina")).toBeChecked();
  });

  it("la scala è una scelta del PNG: sull'SVG non compare", async () => {
    render(<ExportButton onExport={vi.fn()} />);
    await open();
    expect(radio("2x")).toBeInTheDocument();
    fireEvent.click(radio("SVG"));
    expect(screen.queryByRole("radio", { name: "2x" })).not.toBeInTheDocument();
  });

  it("Scarica manda formato, ambito e scala scelti", async () => {
    install(["n1"]);
    const onExport = vi.fn(async () => true);
    render(<ExportButton onExport={onExport} />);
    await open();
    fireEvent.click(radio("3x"));
    press(screen.getByRole("button", { name: "Scarica" }));
    expect(onExport).toHaveBeenCalledWith({ format: "png", scope: "selection", scale: 3 });
  });

  it("SVG e intera pagina", async () => {
    install(["n1"]);
    const onExport = vi.fn(async () => true);
    render(<ExportButton onExport={onExport} />);
    await open();
    fireEvent.click(radio("SVG"));
    fireEvent.click(radio("Pagina"));
    press(screen.getByRole("button", { name: "Scarica" }));
    expect(onExport).toHaveBeenCalledWith({ format: "svg", scope: "page", scale: 1 });
  });

  it("dopo l'export i controlli si chiudono", async () => {
    const onExport = vi.fn(async () => true);
    render(<ExportButton onExport={onExport} />);
    await open();
    press(screen.getByRole("button", { name: "Scarica" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Scarica" })).not.toBeInTheDocument();
    });
  });

  it("la selezione svuotata mentre il pannello è aperto non lascia l'ambito su un ambito che non c'è più", async () => {
    install(["n1"]);
    const onExport = vi.fn(async () => true);
    render(<ExportButton onExport={onExport} />);
    await open();
    expect(radio("Selezione")).toBeChecked();
    // Un altro pezzo dell'app svuota la selezione (Escape sul canvas, un nodo
    // cancellato): l'ambito non può restare "selezione", o Scarica chiederebbe
    // l'export di qualcosa che non esiste.
    useScene.getState().clearSelection();
    await waitFor(() => expect(radio("Pagina")).toBeChecked());
    press(screen.getByRole("button", { name: "Scarica" }));
    expect(onExport).toHaveBeenCalledWith({ format: "png", scope: "page", scale: 1 });
  });
});
