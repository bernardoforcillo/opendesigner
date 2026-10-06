import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../rpc/client", () => ({ docClient: { renameDocument: vi.fn(async () => ({})) } }));

import { DocMenu } from "./DocMenu";
import { useScene } from "../../store/store";
import { emptyScene } from "../../store/types";

// "Import SVG…" from the document menu: opens the file picker and imports the
// chosen file at the center of the view, like paste and drop.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40" width="80" height="40"><rect id="bar" width="80" height="40"/></svg>`;

describe("DocMenu: Import SVG…", () => {
  beforeEach(() => {
    useScene.setState({ gesture: null, notice: null, selection: [], camera: { x: 0, y: 0, zoom: 1 } });
    useScene.getState().setScene(emptyScene("doc-1", "Project"));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the entry exists, with the English label", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    expect(await screen.findByRole("menuitem", { name: "Import SVG…" })).toBeInTheDocument();
  });

  it("opens the picker (.svg only) and imports the chosen file, selecting the root", async () => {
    const clicks: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicks.push(this);
      // the user picks a file: `files` is read-only, so it is defined by hand
      Object.defineProperty(this, "files", { value: [new File([SVG], "bar.svg", { type: "image/svg+xml" })], configurable: true });
      this.dispatchEvent(new Event("change"));
    });

    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import SVG…" }));

    await waitFor(() => expect(useScene.getState().scene!.nodes.size).toBe(2));
    expect(clicks.length).toBe(1);
    expect(clicks[0].type).toBe("file");
    expect(clicks[0].accept).toContain(".svg");
    const nodes = [...useScene.getState().scene!.nodes.values()];
    const root = nodes.find((n) => n.kind === "group")!;
    expect(root.name).toBe("bar");
    expect(useScene.getState().selection).toEqual([root.id]);
    // center of the view (no canvas in the DOM: 800x600) -> 80x40 centered on (400,300)
    expect(root.x).toBe(360);
    expect(root.y).toBe(280);
    expect(useScene.getState().notice).toBe("Imported as 2 layers");
    // the temporary picker does not stay in the DOM
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("cancelling the picker changes nothing", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event("cancel"));
    });
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import SVG…" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(useScene.getState().scene!.nodes.size).toBe(0);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
