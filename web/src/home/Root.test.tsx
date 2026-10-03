import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConnectError, Code } from "@connectrpc/connect";
import { Root, documentTitleFor } from "./Root";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { emptyScene } from "../store/types";

const ID = "0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";
const ID2 = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c80";

function go(hash: string) {
  act(() => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("Root", () => {
  beforeEach(() => { location.hash = ""; useScene.getState().setScene(null); });
  afterEach(() => { cleanup(); location.hash = ""; });

  it("senza hash mostra la Home; con #doc= l'editor", () => {
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(screen.getByText("HOME")).toBeInTheDocument();
    go(`#doc=${ID}`);
    expect(screen.getByText("EDITOR")).toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    go("");
    expect(screen.getByText("HOME")).toBeInTheDocument();
  });

  it("un link #doc= all'apertura va dritto all'editor (deep link e invito)", () => {
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(screen.getByText("EDITOR")).toBeInTheDocument();
  });

  it("un hash sconosciuto non apre un editor", () => {
    location.hash = "#doc=../../etc";
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(screen.getByText("HOME")).toBeInTheDocument();
  });

  it("cambiare documento rimonta l'editor da zero (key = id)", () => {
    let mounts = 0;
    function Probe() {
      mounts++;
      return <div>EDITOR</div>;
    }
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<Probe />} />);
    const before = mounts;
    go(`#doc=${ID2}`);
    expect(mounts).toBeGreaterThan(before);
  });

  it("uscire dall'editor riporta a zero gli store condivisi (scena, modalità, prototipo)", () => {
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    act(() => {
      useScene.getState().setScene(emptyScene(ID, "Mio"));
      useFlowUi.getState().setMode("flows");
      useFlowUi.getState().setPresenting(true);
    });
    go("");
    expect(useScene.getState().scene).toBeNull();
    expect(useFlowUi.getState().mode).toBe("design");
    expect(useFlowUi.getState().presenting).toBe(false);
  });

  it("il titolo della scheda segue il nome del documento", () => {
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(document.title).toBe("opendesigner");
    act(() => useScene.getState().setScene(emptyScene(ID, "Il mio progetto")));
    expect(document.title).toBe("Il mio progetto — opendesigner");
    go("");
    expect(document.title).toBe("opendesigner");
  });

  it("documentTitleFor: senza nome è solo l'app", () => {
    expect(documentTitleFor(null)).toBe("opendesigner");
    expect(documentTitleFor("X")).toBe("X — opendesigner");
  });
});

// L'editor che non trova il documento: la scheda con l'uscita verso la Home.
describe("documento inesistente", () => {
  afterEach(() => { cleanup(); vi.resetModules(); vi.doUnmock("../rpc/syncClient"); });

  it("l'errore NotFound del bootstrap mostra 'Documento non trovato' e Torna alla Home porta in Home", async () => {
    vi.resetModules();
    vi.doMock("../rpc/syncClient", () => ({
      SyncClient: class {
        async start() { throw new ConnectError("documento non trovato", Code.NotFound); }
        stop() {}
      },
    }));
    vi.doMock("../rpc/client", () => ({ docClient: {} }));
    const { App } = await import("../ui/App");
    location.hash = `#doc=${ID}`;
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Documento non trovato");
    act(() => screen.getByRole("button", { name: "Torna alla Home" }).click());
    expect(location.hash === "" || location.hash === "#").toBe(true);
  });
});
