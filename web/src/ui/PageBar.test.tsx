// I matcher di jest-dom sono già installati dai setupFiles (vite.config.ts);
// l'import qui serve a TYPE-SCRIPT (tsc -b non legge i setupFiles), altrimenti
// toBeDisabled/toHaveAttribute non esistono per il compilatore.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PageBar } from "./PageBar";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/brawt/v1/brawt_pb";

// Doppio di SyncClient: registra gli op sul filo e modella un server che accetta
// ed ECOA subito (applyPending + apply), come nei test dei tool. Serve a
// contare "un op per azione" e a far avanzare il documento confermato.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function twoPageScene(): SceneState {
  return {
    ...emptyScene("doc1", "Untitled"),
    pages: [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }],
  };
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({
    selection: [],
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
  useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  useScene.getState().setSync(sync);
});
afterEach(cleanup);

describe("PageBar", () => {
  it("mostra un pulsante per pagina e segna quella corrente", () => {
    useScene.getState().setScene(twoPageScene());
    render(<PageBar />);
    const p1 = screen.getByRole("button", { name: "Page 1" });
    const p2 = screen.getByRole("button", { name: "Page 2" });
    expect(p1).toBeInTheDocument();
    expect(p2).toBeInTheDocument();
    // La corrente (page1 di default) è marcata con aria-current.
    expect(p1).toHaveAttribute("aria-current", "page");
    expect(p2).not.toHaveAttribute("aria-current");
  });

  it("cliccando una scheda si cambia pagina corrente e la selezione si azzera", () => {
    useScene.getState().setScene(twoPageScene());
    useScene.setState({ selection: ["z"] });
    render(<PageBar />);
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(useScene.getState().currentPageId).toBe("page2");
    expect(useScene.getState().selection).toEqual([]);
  });

  it("«+» crea UNA pagina (una sola CreatePage) e ci si sposta sopra", () => {
    render(<PageBar />);
    fireEvent.click(screen.getByRole("button", { name: "Nuova pagina" }));
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("createPage");
    const pages = useScene.getState().scene!.pages;
    expect(pages).toHaveLength(2);
    expect(pages[1].name).toBe("Page 2");
    // Ci si è spostati sulla pagina appena creata.
    expect(useScene.getState().currentPageId).toBe(pages[1].id);
  });

  it("«Elimina» è disabilitato con una sola pagina (il core rifiuta l'ultima)", () => {
    render(<PageBar />);
    expect(screen.getByRole("button", { name: "Elimina pagina" })).toBeDisabled();
  });

  it("«Elimina» rimuove la pagina corrente quando ce n'è più d'una (una sola DeletePage)", () => {
    useScene.getState().setScene(twoPageScene());
    useScene.getState().setCurrentPage("page2");
    render(<PageBar />);
    const del = screen.getByRole("button", { name: "Elimina pagina" });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deletePage");
    expect(useScene.getState().scene!.pages.map((p) => p.id)).toEqual(["page1"]);
    // La corrente sparita ripiega sulla rimasta.
    expect(useScene.getState().currentPageId).toBe("page1");
  });

  it("doppio click sul nome apre la rinomina; Invio manda UNA RenamePage", () => {
    render(<PageBar />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 1" }));
    const field = screen.getByRole("textbox", { name: "Nome della pagina" });
    fireEvent.change(field, { target: { value: "Cover" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("renamePage");
    expect(useScene.getState().scene!.pages[0].name).toBe("Cover");
  });

  it("rinominare con lo stesso nome non manda nessun op", () => {
    render(<PageBar />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 1" }));
    const field = screen.getByRole("textbox", { name: "Nome della pagina" });
    fireEvent.keyDown(field, { key: "Enter" }); // valore invariato
    expect(sync.sent).toHaveLength(0);
  });
});
