import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useLanguage } from "@/i18n";
import { BoardDialog } from "@/ui/BoardDialog";
import { DiagramDialog } from "@/ui/DiagramDialog";
import { InkManagerDialog } from "@/ui/InkManagerDialog";
import { LayersDialog } from "@/ui/LayersDialog";
import { LinksDialog } from "@/ui/LinksDialog";
import { ObjectToolsDialog } from "@/ui/ObjectToolsDialog";
import { PluginsDialog } from "@/ui/PluginsDialog";
import { SwatchesDialog } from "@/ui/SwatchesDialog";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";

// The dialogs that used to be English only now follow the interface language.
const noop = () => {};

beforeEach(() => {
  localStorage.clear();
  act(() => { useScene.getState().setScene(emptyScene("d", "Doc")); });
});
afterEach(() => {
  cleanup();
  act(() => { useLanguage.getState().set("system"); });
});

function inSpanish() {
  act(() => { useLanguage.getState().set("es"); });
}

describe("dialogs follow the language", () => {
  it("Board (whiteboard)", () => {
    inSpanish();
    render(<BoardDialog isOpen onOpenChange={noop} />);
    expect(screen.getByRole("heading", { name: "Pizarra" })).toBeTruthy();
    expect(screen.getByText("Tablero kanban")).toBeTruthy();
    expect(screen.getByLabelText("Filas de la tabla")).toBeTruthy();
  });

  it("Diagram, Links, Ink manager, Object tools, Layers, Plugins and Swatches", () => {
    inSpanish();
    const { unmount: u1 } = render(<DiagramDialog isOpen onOpenChange={noop} />);
    expect(screen.getByRole("heading", { name: "Crear diagrama" })).toBeTruthy();
    expect(screen.getByText("Clases UML")).toBeTruthy();
    u1();
    const { unmount: u2 } = render(<LinksDialog isOpen onOpenChange={noop} />);
    expect(screen.getByText("No hay imágenes en este documento.")).toBeTruthy();
    u2();
    const { unmount: u3 } = render(<InkManagerDialog isOpen onOpenChange={noop} />);
    expect(screen.getByRole("heading", { name: "Gestor de tintas" })).toBeTruthy();
    expect(screen.getByText(/0 muestras CMYK/)).toBeTruthy();
    u3();
    const { unmount: u4 } = render(<ObjectToolsDialog isOpen onOpenChange={noop} />);
    expect(screen.getByRole("heading", { name: "Herramientas de objetos" })).toBeTruthy();
    expect(screen.getByLabelText("Copias")).toBeTruthy();
    u4();
    const { unmount: u5 } = render(<LayersDialog isOpen onOpenChange={noop} />);
    expect(screen.getByText("Aún no hay capas.")).toBeTruthy();
    u5();
    const { unmount: u6 } = render(<PluginsDialog isOpen onOpenChange={noop} />);
    expect(screen.getByText("Aún no hay plugins")).toBeTruthy();
    u6();
    render(<SwatchesDialog isOpen onOpenChange={noop} />);
    expect(screen.getByRole("heading", { name: "Muestras" })).toBeTruthy();
    expect(screen.getByLabelText("Modo de color")).toBeTruthy();
  });

  it("stays English by default", () => {
    render(<BoardDialog isOpen onOpenChange={noop} />);
    expect(screen.getByRole("heading", { name: "Whiteboard" })).toBeTruthy();
  });
});
