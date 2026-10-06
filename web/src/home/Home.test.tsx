import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Home, type HomeClient } from "./Home";
import { TEMPLATES } from "../templates/catalog";

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;

const ID_A = "0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";
const ID_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c80";
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const sec = (agoSeconds: number) => BigInt(Math.floor(NOW / 1000) - agoSeconds);

function makeClient(docs: { id: string; name: string; updatedAt: bigint; screens: number; flows: number }[] = []) {
  const list = docs.map((d) => ({ ...d }));
  const client: HomeClient = {
    listDocuments: vi.fn(async () => ({ docs: [...list] })),
    createDocument: vi.fn(async () => ({ id: "new-doc" })),
    openDocument: vi.fn(async () => ({ snapshot: { pages: [{ id: "page1" }] } })),
    submitOp: vi.fn(async () => ({})),
    renameDocument: vi.fn(async (r: { docId: string; name: string }) => {
      const d = list.find((x) => x.id === r.docId);
      if (d) d.name = r.name;
      return {};
    }),
    deleteDocument: vi.fn(async (r: { docId: string }) => {
      list.splice(list.findIndex((x) => x.id === r.docId), 1);
      return {};
    }),
  };
  return client;
}

const DOCS = [
  { id: ID_A, name: "Old", updatedAt: sec(5 * 86400), screens: 2, flows: 1 },
  { id: ID_B, name: "Recent", updatedAt: sec(120), screens: 0, flows: 0 },
];

describe("Home", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("without documents it shows the empty state and the templates", async () => {
    render(<Home client={makeClient()} navigate={() => {}} now={() => NOW} />);
    expect(await screen.findByText("No documents yet")).toBeInTheDocument();
    for (const { name } of TEMPLATES) {
      expect(screen.getByRole("button", { name: `Create from template: ${name}` })).toBeInTheDocument();
    }
  });

  it("lists the documents from the most recent, with last edit and counts", async () => {
    render(<Home client={makeClient(DOCS)} navigate={() => {}} now={() => NOW} />);
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("Recent")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Edited 2 min ago")).toBeInTheDocument();
    expect(within(cards[0]).getByText("0 screens · 0 flows")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Old")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Edited 5 days ago")).toBeInTheDocument();
    expect(within(cards[1]).getByText("2 screens · 1 flow")).toBeInTheDocument();
  });

  it("every card is a real link to /doc/<id> (it opens, even in a new tab)", async () => {
    render(<Home client={makeClient(DOCS)} navigate={() => {}} now={() => NOW} />);
    const link = await screen.findByRole("link", { name: "Open Old" });
    expect(link).toHaveAttribute("href", `/doc/${ID_A}`);
  });

  it("'New document' creates an empty document and opens it", async () => {
    const client = makeClient();
    const navigate = vi.fn();
    render(<Home client={client} navigate={navigate} now={() => NOW} />);
    await screen.findByText("No documents yet");
    await userEvent.click(screen.getByRole("button", { name: "New document" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/doc/new-doc"));
    expect(client.createDocument).toHaveBeenCalledTimes(1);
    expect(client.submitOp).not.toHaveBeenCalled();
  });

  it("a template creates the document, sends it the ops and opens it", async () => {
    const client = makeClient();
    const navigate = vi.fn();
    render(<Home client={client} navigate={navigate} now={() => NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: `Create from template: ${tpl("checkout").name}` }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/doc/new-doc"));
    expect(client.createDocument).toHaveBeenCalledWith({ name: tpl("checkout").docName });
    expect((client.submitOp as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(50);
  });

  it("if the template is not fully applied it says so and stays in Home", async () => {
    const client = makeClient();
    (client.submitOp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    const navigate = vi.fn();
    render(<Home client={client} navigate={navigate} now={() => NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: `Create from template: ${tpl("onboarding").name}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/was not fully applied \(disk full\)/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renames a card: Enter confirms and calls the server", async () => {
    const client = makeClient(DOCS);
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[0];
    await userEvent.click(within(card).getByRole("button", { name: "Actions for Recent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Document name" });
    await userEvent.clear(input);
    await userEvent.type(input, "New name{Enter}");
    await waitFor(() => expect(client.renameDocument).toHaveBeenCalledWith({ docId: ID_B, name: "New name" }));
    expect(await screen.findByText("New name")).toBeInTheDocument();
  });

  it("Esc cancels the rename without calling the server", async () => {
    const client = makeClient(DOCS);
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[0];
    await userEvent.click(within(card).getByRole("button", { name: "Actions for Recent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Document name" });
    await userEvent.type(input, "xyz{Escape}");
    expect(client.renameDocument).not.toHaveBeenCalled();
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("deleting asks for confirmation: Cancel touches nothing, Delete deletes", async () => {
    const client = makeClient(DOCS);
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[1];
    await userEvent.click(within(card).getByRole("button", { name: "Actions for Old" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Delete “/)).toHaveTextContent("Old");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(client.deleteDocument).not.toHaveBeenCalled();

    await userEvent.click(within(card).getByRole("button", { name: "Actions for Old" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(client.deleteDocument).toHaveBeenCalledWith({ docId: ID_A }));
    await waitFor(() => expect(screen.queryByText("Old")).not.toBeInTheDocument());
  });

  it("if the server rejects the deletion (open document) the dialog stays and explains why", async () => {
    const client = makeClient(DOCS);
    (client.deleteDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("the document is open in an editor"));
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[0];
    await userEvent.click(within(card).getByRole("button", { name: "Actions for Recent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("open in an editor");
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("the 'join' field accepts a full link and opens that document", async () => {
    const navigate = vi.fn();
    render(<Home client={makeClient()} navigate={navigate} now={() => NOW} />);
    const field = await screen.findByLabelText("Link to a shared document");
    const join = screen.getByRole("button", { name: "Join" });
    expect(join).toBeDisabled();
    await userEvent.type(field, `http://192.168.1.7:8080/doc/${ID_A.toUpperCase()}{Enter}`);
    expect(navigate).toHaveBeenCalledWith(`/doc/${ID_A}`);
  });

  it("an invalid link shows the error and does not navigate", async () => {
    const navigate = vi.fn();
    render(<Home client={makeClient()} navigate={navigate} now={() => NOW} />);
    const field = await screen.findByLabelText("Link to a shared document");
    await userEvent.type(field, "hello{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not a valid opendesigner link.");
    expect(navigate).not.toHaveBeenCalled();
    // typing again clears the error
    await userEvent.type(field, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("if the list cannot be read it says so, without hiding the templates", async () => {
    const client = makeClient();
    (client.listDocuments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("server down"));
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("server down");
    expect(screen.getByRole("button", { name: `Create from template: ${tpl("blank").name}` })).toBeInTheDocument();
  });
});
