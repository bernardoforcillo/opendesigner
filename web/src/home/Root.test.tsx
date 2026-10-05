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

  it("without a hash it shows the Home; with #doc= the editor", () => {
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(screen.getByText("HOME")).toBeInTheDocument();
    go(`#doc=${ID}`);
    expect(screen.getByText("EDITOR")).toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    go("");
    expect(screen.getByText("HOME")).toBeInTheDocument();
  });

  it("a #doc= link on load goes straight to the editor (deep link and invite)", () => {
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(screen.getByText("EDITOR")).toBeInTheDocument();
  });

  it("an unknown hash does not open an editor", () => {
    location.hash = "#doc=../../etc";
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(screen.getByText("HOME")).toBeInTheDocument();
  });

  it("changing document remounts the editor from scratch (key = id)", () => {
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

  it("leaving the editor resets the shared stores (scene, mode, prototype)", () => {
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    act(() => {
      useScene.getState().setScene(emptyScene(ID, "Mine"));
      useFlowUi.getState().setMode("flows");
      useFlowUi.getState().setPresenting(true);
    });
    go("");
    expect(useScene.getState().scene).toBeNull();
    expect(useFlowUi.getState().mode).toBe("design");
    expect(useFlowUi.getState().presenting).toBe(false);
  });

  it("the tab title follows the document name", () => {
    location.hash = `#doc=${ID}`;
    render(<Root home={<div>HOME</div>} editor={<div>EDITOR</div>} />);
    expect(document.title).toBe("opendesigner");
    act(() => useScene.getState().setScene(emptyScene(ID, "My project")));
    expect(document.title).toBe("My project — opendesigner");
    go("");
    expect(document.title).toBe("opendesigner");
  });

  it("documentTitleFor: without a name it is just the app", () => {
    expect(documentTitleFor(null)).toBe("opendesigner");
    expect(documentTitleFor("X")).toBe("X — opendesigner");
  });
});

// The editor that cannot find the document: the card with the exit to the Home.
describe("nonexistent document", () => {
  afterEach(() => { cleanup(); vi.resetModules(); vi.doUnmock("../rpc/syncClient"); });

  it("the bootstrap NotFound error shows 'Document not found' and Back to Home goes to Home", async () => {
    vi.resetModules();
    vi.doMock("../rpc/syncClient", () => ({
      SyncClient: class {
        async start() { throw new ConnectError("document not found", Code.NotFound); }
        stop() {}
      },
    }));
    vi.doMock("../rpc/client", () => ({ docClient: {} }));
    const { App } = await import("../ui/App");
    location.hash = `#doc=${ID}`;
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Document not found");
    act(() => screen.getByRole("button", { name: "Back to Home" }).click());
    expect(location.hash === "" || location.hash === "#").toBe(true);
  });
});
