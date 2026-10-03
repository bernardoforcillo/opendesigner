import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const renameDocument = vi.fn(async (_r: { docId: string; name: string }) => ({}));
vi.mock("../../rpc/client", () => ({ docClient: { renameDocument: (r: { docId: string; name: string }) => renameDocument(r) } }));

import { DocMenu, renameOpenDocument } from "./DocMenu";
import { useScene } from "../../store/store";
import { emptyScene } from "../../store/types";

describe("DocMenu", () => {
  beforeEach(() => {
    renameDocument.mockClear();
    useScene.getState().setScene(emptyScene("doc-1", "Progetto"));
  });
  afterEach(() => { cleanup(); location.hash = ""; });

  it("ha Home, Nuovo documento e Rinomina documento", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    for (const n of ["Home", "Nuovo documento", "Rinomina documento"]) {
      expect(await screen.findByRole("menuitem", { name: n })).toBeInTheDocument();
    }
  });

  it("'Home' torna alla Home (svuota l'hash)", async () => {
    location.hash = "#doc=0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Home" }));
    expect(location.hash === "" || location.hash === "#").toBe(true);
  });

  it("'Nuovo documento' chiama il gestore dell'editor", async () => {
    const onNew = vi.fn();
    render(<DocMenu onNewDocument={onNew} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Nuovo documento" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("rinomina sul posto dall'intestazione: Invio conferma, il server e lo store hanno il nuovo nome", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rinomina documento" }));
    const input = await screen.findByRole("textbox", { name: "Nome del documento" });
    await userEvent.clear(input);
    await userEvent.type(input, "Altro nome{Enter}");
    await waitFor(() => expect(renameDocument).toHaveBeenCalledWith({ docId: "doc-1", name: "Altro nome" }));
    await waitFor(() => expect(useScene.getState().scene?.name).toBe("Altro nome"));
    expect(useScene.getState().confirmed?.name ?? "Altro nome").toBe("Altro nome");
  });

  it("Esc annulla, senza chiamare il server", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rinomina documento" }));
    const input = await screen.findByRole("textbox", { name: "Nome del documento" });
    await userEvent.type(input, "zzz{Escape}");
    expect(renameDocument).not.toHaveBeenCalled();
    expect(useScene.getState().scene?.name).toBe("Progetto");
  });

  it("un nome vuoto o invariato non è una rinomina", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rinomina documento" }));
    const input = await screen.findByRole("textbox", { name: "Nome del documento" });
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");
    expect(renameDocument).not.toHaveBeenCalled();
  });

  it("se il server rifiuta, il campo resta aperto con l'errore", async () => {
    renameDocument.mockRejectedValueOnce(new Error("nome troppo lungo"));
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Menu del documento" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rinomina documento" }));
    const input = await screen.findByRole("textbox", { name: "Nome del documento" });
    await userEvent.clear(input);
    await userEvent.type(input, "Nuovo{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("nome troppo lungo");
    expect(useScene.getState().scene?.name).toBe("Progetto");
  });
});

describe("renameOpenDocument", () => {
  it("senza documento aperto non fa niente", async () => {
    useScene.getState().setScene(null);
    renameDocument.mockClear();
    await renameOpenDocument("x");
    expect(renameDocument).not.toHaveBeenCalled();
  });
});
