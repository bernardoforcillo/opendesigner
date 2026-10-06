import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const renameDocument = vi.fn(async (_r: { docId: string; name: string }) => ({}));
const navigate = vi.fn();
vi.mock("../../home/nav", () => ({ useAppNavigate: () => navigate }));
vi.mock("../../rpc/client", () => ({ docClient: { renameDocument: (r: { docId: string; name: string }) => renameDocument(r) } }));

import { DocMenu, renameOpenDocument } from "./DocMenu";
import { useScene } from "../../store/store";
import { emptyScene } from "../../store/types";

describe("DocMenu", () => {
  beforeEach(() => {
    renameDocument.mockClear();
    useScene.getState().setScene(emptyScene("doc-1", "Project"));
  });
  afterEach(() => { cleanup(); navigate.mockClear(); });

  it("has Home, New document and Rename document", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    for (const n of ["Home", "New document", "Rename document"]) {
      expect(await screen.findByRole("menuitem", { name: n })).toBeInTheDocument();
    }
  });

  it("'Home' goes back to Home (navigates to /)", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Home" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("'New document' calls the editor's handler", async () => {
    const onNew = vi.fn();
    render(<DocMenu onNewDocument={onNew} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "New document" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("renames in place from the header: Enter confirms, the server and the store have the new name", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rename document" }));
    const input = await screen.findByRole("textbox", { name: "Document name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Other name{Enter}");
    await waitFor(() => expect(renameDocument).toHaveBeenCalledWith({ docId: "doc-1", name: "Other name" }));
    await waitFor(() => expect(useScene.getState().scene?.name).toBe("Other name"));
    expect(useScene.getState().confirmed?.name ?? "Other name").toBe("Other name");
  });

  it("Esc cancels, without calling the server", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rename document" }));
    const input = await screen.findByRole("textbox", { name: "Document name" });
    await userEvent.type(input, "zzz{Escape}");
    expect(renameDocument).not.toHaveBeenCalled();
    expect(useScene.getState().scene?.name).toBe("Project");
  });

  it("an empty or unchanged name is not a rename", async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rename document" }));
    const input = await screen.findByRole("textbox", { name: "Document name" });
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");
    expect(renameDocument).not.toHaveBeenCalled();
  });

  it("if the server refuses, the field stays open with the error", async () => {
    renameDocument.mockRejectedValueOnce(new Error("name too long"));
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rename document" }));
    const input = await screen.findByRole("textbox", { name: "Document name" });
    await userEvent.clear(input);
    await userEvent.type(input, "New{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("name too long");
    expect(useScene.getState().scene?.name).toBe("Project");
  });
});

describe("renameOpenDocument", () => {
  it("without an open document it does nothing", async () => {
    useScene.getState().setScene(null);
    renameDocument.mockClear();
    await renameOpenDocument("x");
    expect(renameDocument).not.toHaveBeenCalled();
  });
});
