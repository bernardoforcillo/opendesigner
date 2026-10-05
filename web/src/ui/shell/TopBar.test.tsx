import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TopBar } from "./TopBar";
import { useScene } from "../../store/store";
import { useFlowUi } from "../../store/flowUi";

afterEach(cleanup);
afterEach(() => useFlowUi.getState().setMode("design"));

function renderTopBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      mode="design"
      presence={<span>presenza-finta</span>}
      onNewDocument={vi.fn()}
      connection="connected"
      statusLabel="Connesso"
      {...overrides}
    />,
  );
}

describe("TopBar", () => {
  it("monta il menu del documento", () => {
    renderTopBar();
    expect(screen.getByRole("button", { name: "Menu del documento" })).toBeInTheDocument();
  });

  it("monta lo switch di modalità con le tre modalità", () => {
    renderTopBar();
    const group = screen.getByRole("radiogroup", { name: "Modalità" });
    expect(group).toBeInTheDocument();
    for (const label of ["Design", "Flussi", "Sviluppo"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("scegliere Flussi cambia davvero la modalità nello store", () => {
    renderTopBar();
    fireEvent.click(screen.getByRole("radio", { name: /Flussi/ }));
    expect(useFlowUi.getState().mode).toBe("flows");
  });

  it("monta la presenza ricevuta via prop", () => {
    renderTopBar();
    expect(screen.getByText("presenza-finta")).toBeInTheDocument();
  });

  it("mostra lo zoom della camera", () => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1.5 } });
    renderTopBar();
    expect(screen.getByTitle("Zoom")).toHaveTextContent("150%");
  });

  it("mostra lo stato della connessione", () => {
    renderTopBar({ statusLabel: "Riconnessione…" });
    expect(screen.getByTitle("Riconnessione…")).toBeInTheDocument();
  });
});
