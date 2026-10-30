import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LibraryItemKind } from "@/gen/opendesigner/v1/opendesigner_pb";

const client = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  setLibrary: vi.fn(),
  getLibrary: vi.fn(),
  importFromLibrary: vi.fn(),
}));
vi.mock("@/rpc/client", () => ({ docClient: client }));

import { LibrariesDialog } from "@features/editor/components/organisms/LibrariesDialog";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";

const docs = (appLibrary: boolean) => ({
  docs: [
    { id: "doc-1", name: "App", library: appLibrary },
    { id: "kit", name: "Design kit", library: true },
    { id: "plain", name: "Sketch", library: false },
  ],
});

beforeEach(() => {
  client.listDocuments.mockResolvedValue(docs(false));
  client.setLibrary.mockResolvedValue({});
  client.getLibrary.mockResolvedValue({
    items: [
      { kind: LibraryItemKind.COMPONENT, id: "c1", name: "Button", group: "" },
      { kind: LibraryItemKind.TEXT_STYLE, id: "t1", name: "Body", group: "" },
    ],
  });
  client.importFromLibrary.mockResolvedValue({ imported: [{ id: "c1" }, { id: "t1" }], skipped: [{ id: "c2" }], pageId: "p" });
  useScene.getState().setScene(emptyScene("doc-1", "App"));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("LibrariesDialog", () => {
  it("lists only other documents that are libraries, with what they offer", async () => {
    render(<LibrariesDialog isOpen onOpenChange={() => {}} />);
    const select = await screen.findByRole("combobox", { name: "Library" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Design kit"]);
    expect(await screen.findByRole("checkbox", { name: "Button" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Body" })).toBeInTheDocument();
    expect(client.getLibrary).toHaveBeenCalledWith(expect.objectContaining({ docId: "kit" }));
  });

  it("publishes this document as a library", async () => {
    render(<LibrariesDialog isOpen onOpenChange={() => {}} />);
    const box = await screen.findByRole("checkbox", { name: /Publish as a library/ });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    client.listDocuments.mockResolvedValue(docs(true));
    await userEvent.click(box);
    expect(client.setLibrary).toHaveBeenCalledWith(expect.objectContaining({ docId: "doc-1", library: true }));
    await waitFor(() => expect(box).toBeChecked());
  });

  it("imports the picked items and says what was skipped", async () => {
    render(<LibrariesDialog isOpen onOpenChange={() => {}} />);
    const importBtn = await screen.findByRole("button", { name: "Import selected" });
    expect(importBtn).toBeDisabled();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Button" }));
    await userEvent.click(importBtn);
    expect(client.importFromLibrary).toHaveBeenCalledTimes(1);
    const req = client.importFromLibrary.mock.calls[0][0];
    expect(req.docId).toBe("doc-1");
    expect(req.libraryDocId).toBe("kit");
    expect(req.items.map((i: { id: string; kind: number }) => [i.kind, i.id])).toEqual([[LibraryItemKind.COMPONENT, "c1"]]);
    expect(await screen.findByText("Imported 2 items.")).toBeInTheDocument();
    expect(screen.getByText("1 component was already in the document and was left as it is.")).toBeInTheDocument();
  });

  it("shows the error of a failed import", async () => {
    client.importFromLibrary.mockRejectedValue(new Error("the document is not published as a library"));
    render(<LibrariesDialog isOpen onOpenChange={() => {}} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Body" }));
    await userEvent.click(screen.getByRole("button", { name: "Import selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not published as a library");
  });

  it("says so when no library exists", async () => {
    client.listDocuments.mockResolvedValue({ docs: [{ id: "doc-1", name: "App", library: false }] });
    render(<LibrariesDialog isOpen onOpenChange={() => {}} />);
    expect(await screen.findByText("No other document is published as a library yet.")).toBeInTheDocument();
  });
});
