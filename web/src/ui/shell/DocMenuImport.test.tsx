import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../rpc/client", () => ({ docClient: { renameDocument: vi.fn(async () => ({})) } }));

import { DocMenu } from "./DocMenu";
import { useScene } from "../../store/store";
import { emptyScene } from "../../store/types";

// "Importa SVG…" dal menu del documento: apre il selettore di file e importa il
// file scelto al centro della vista, come l'incolla e il rilascio.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40" width="80" height="40"><rect id="barra" width="80" height="40"/></svg>`;

describe("DocMenu: Importa SVG…", () => {
  beforeEach(() => {
    useScene.setState({ gesture: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
    useScene.getState().setScene(emptyScene("doc-1", "Progetto"));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("la voce c'è, con l'etichetta in italiano", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    expect(await screen.findByRole("menuitem", { name: "Importa SVG…" })).toBeInTheDocument();
  });

  it("apre il selettore (solo .svg) e importa il file scelto, selezionando la radice", async () => {
    const clicks: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicks.push(this);
      // l'utente sceglie un file: `files` è di sola lettura, si definisce a mano
      Object.defineProperty(this, "files", { value: [new File([SVG], "barra.svg", { type: "image/svg+xml" })], configurable: true });
      this.dispatchEvent(new Event("change"));
    });

    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Importa SVG…" }));

    await waitFor(() => expect(useScene.getState().scene!.nodes.size).toBe(2));
    expect(clicks.length).toBe(1);
    expect(clicks[0].type).toBe("file");
    expect(clicks[0].accept).toContain(".svg");
    const nodes = [...useScene.getState().scene!.nodes.values()];
    const root = nodes.find((n) => n.kind === "group")!;
    expect(root.name).toBe("barra");
    expect(useScene.getState().selection).toEqual([root.id]);
    // centro della vista (senza canvas nel DOM: 800x600) -> 80x40 centrato su (400,300)
    expect(root.x).toBe(360);
    expect(root.y).toBe(280);
    expect(useScene.getState().notice).toBe("Importato come 2 livelli");
    // il selettore temporaneo non resta nel DOM
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("annullando il selettore non cambia niente", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event("cancel"));
    });
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Importa SVG…" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(useScene.getState().scene!.nodes.size).toBe(0);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
