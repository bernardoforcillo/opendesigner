import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ConnectError, Code } from "@connectrpc/connect";
import { Root, documentTitleFor } from "./Root";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { useRenderer } from "../store/rendererChoice";
import { emptyScene } from "../store/types";

const ID = "0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";
const ID2 = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c80";

const home = <div>HOME</div>;
const editor = <div>EDITOR</div>;

function mount(path: string, slots: { home?: ReactNode; editor?: ReactNode } = {}) {
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<Root home={slots.home ?? home} editor={slots.editor ?? editor} history={history} />);
  return history;
}

const go = (history: RouterHistory, path: string) => act(() => { history.push(path); });

describe("Root", () => {
  beforeEach(() => { useScene.getState().setScene(null); });
  afterEach(() => { cleanup(); });

  it("at / it shows the Home; at /doc/<id> the editor", async () => {
    const history = mount("/");
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    go(history, `/doc/${ID}`);
    expect(await screen.findByText("EDITOR")).toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    go(history, "/");
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("a /doc/<id> link on load goes straight to the editor (deep link and invite)", async () => {
    mount(`/doc/${ID}`);
    expect(await screen.findByText("EDITOR")).toBeInTheDocument();
  });

  it("a malformed id does not open an editor", async () => {
    const history = mount("/doc/not-an-id");
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    expect(history.location.pathname).toBe("/");
  });

  it("an old #doc=<id> link is redirected to /doc/<id>", async () => {
    const history = mount(`/#doc=${ID.toUpperCase()}`);
    expect(await screen.findByText("EDITOR")).toBeInTheDocument();
    expect(history.location.pathname).toBe(`/doc/${ID}`);
  });

  it("an old #new link is redirected to the Home with the templates highlighted", async () => {
    const history = mount("/#new");
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    expect(history.location.pathname).toBe("/");
    expect(history.location.search).toContain("templates=true");
  });

  it("changing document remounts the editor from scratch (key = id)", async () => {
    let mounts = 0;
    function Probe() {
      mounts++;
      return <div>EDITOR</div>;
    }
    const history = mount(`/doc/${ID}`, { editor: <Probe /> });
    await screen.findByText("EDITOR");
    const before = mounts;
    go(history, `/doc/${ID2}`);
    await waitFor(() => expect(mounts).toBeGreaterThan(before));
  });

  it("leaving the editor resets the shared stores (scene, mode, prototype)", async () => {
    const history = mount(`/doc/${ID}`);
    await screen.findByText("EDITOR");
    act(() => {
      useScene.getState().setScene(emptyScene(ID, "Mine"));
      useFlowUi.getState().setMode("flows");
      useFlowUi.getState().setPresenting(true);
    });
    go(history, "/");
    await screen.findByText("HOME");
    expect(useScene.getState().scene).toBeNull();
    expect(useFlowUi.getState().mode).toBe("design");
    expect(useFlowUi.getState().presenting).toBe(false);
  });

  it("the tab title follows the document name", async () => {
    const history = mount(`/doc/${ID}`);
    await screen.findByText("EDITOR");
    expect(document.title).toBe("opendesigner");
    act(() => useScene.getState().setScene(emptyScene(ID, "My project")));
    expect(document.title).toBe("My project — opendesigner");
    go(history, "/");
    await screen.findByText("HOME");
    expect(document.title).toBe("opendesigner");
  });

  it("?renderer= in the link selects the renderer, and a change of choice updates the URL", async () => {
    useRenderer.getState().setChoice("cpu");
    const history = mount(`/doc/${ID}?renderer=gpu`);
    await screen.findByText("EDITOR");
    await waitFor(() => expect(useRenderer.getState().choice).toBe("gpu"));
    act(() => useRenderer.getState().setChoice("cpu"));
    await waitFor(() => expect(history.location.search).toContain("renderer=cpu"));
    useRenderer.getState().setChoice("cpu");
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
    const { Root: FreshRoot } = await import("./Root");
    const history = createMemoryHistory({ initialEntries: [`/doc/${ID}`] });
    render(<FreshRoot history={history} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Document not found");
    act(() => screen.getByRole("button", { name: "Back to Home" }).click());
    await waitFor(() => expect(history.location.pathname).toBe("/"));
  });
});
