import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ExportSection } from "./ExportSection";

// La stessa sequenza di click vera usata in ExportButton.test.tsx (ora rimosso):
// usePress di react-aria scambia per "virtuale" un PointerEvent senza
// pressione, che è quello che jsdom costruisce di default.
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

afterEach(cleanup);

describe("ExportSection", () => {
  it("mostra Formato e Scala inline, senza bisogno di apertura", () => {
    render(<ExportSection onExport={vi.fn()} />);
    expect(radio("PNG")).toBeInTheDocument();
    expect(radio("SVG")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scarica" })).toBeInTheDocument();
  });

  it("non offre nessun controllo Ambito: l'esportazione è sempre della selezione", () => {
    render(<ExportSection onExport={vi.fn()} />);
    expect(screen.queryByRole("radio", { name: "Selezione" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Pagina" })).not.toBeInTheDocument();
  });

  it("la scala è una scelta del PNG: sull'SVG non compare", () => {
    render(<ExportSection onExport={vi.fn()} />);
    expect(radio("2x")).toBeInTheDocument();
    fireEvent.click(radio("SVG"));
    expect(screen.queryByRole("radio", { name: "2x" })).not.toBeInTheDocument();
  });

  it("Scarica manda formato e scala scelti, con scope fisso a selection", () => {
    const onExport = vi.fn(async () => true);
    render(<ExportSection onExport={onExport} />);
    fireEvent.click(radio("3x"));
    press(screen.getByRole("button", { name: "Scarica" }));
    expect(onExport).toHaveBeenCalledWith({ format: "png", scope: "selection", scale: 3 });
  });

  it("SVG manda scale 1 anche se non mostrato", () => {
    const onExport = vi.fn(async () => true);
    render(<ExportSection onExport={onExport} />);
    fireEvent.click(radio("SVG"));
    press(screen.getByRole("button", { name: "Scarica" }));
    expect(onExport).toHaveBeenCalledWith({ format: "svg", scope: "selection", scale: 1 });
  });
});
