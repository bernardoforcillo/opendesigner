import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Home, type HomeClient } from "./Home";

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
  { id: ID_A, name: "Vecchio", updatedAt: sec(5 * 86400), screens: 2, flows: 1 },
  { id: ID_B, name: "Recente", updatedAt: sec(120), screens: 0, flows: 0 },
];

describe("Home", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("senza documenti mostra lo stato vuoto e i template", async () => {
    render(<Home client={makeClient()} navigate={() => {}} now={() => NOW} />);
    expect(await screen.findByText("Nessun documento, per ora")).toBeInTheDocument();
    for (const name of ["Vuoto", "Onboarding", "Login e registrazione", "Checkout", "Dashboard SaaS"]) {
      expect(screen.getByRole("button", { name: `Crea da template: ${name}` })).toBeInTheDocument();
    }
  });

  it("elenca i documenti dal più recente, con ultima modifica e conteggi", async () => {
    render(<Home client={makeClient(DOCS)} navigate={() => {}} now={() => NOW} />);
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("Recente")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Modificato 2 min fa")).toBeInTheDocument();
    expect(within(cards[0]).getByText("0 schermate · 0 flussi")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Vecchio")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Modificato 5 giorni fa")).toBeInTheDocument();
    expect(within(cards[1]).getByText("2 schermate · 1 flusso")).toBeInTheDocument();
  });

  it("ogni card è un link vero verso #doc=<id> (si apre, anche in una scheda nuova)", async () => {
    render(<Home client={makeClient(DOCS)} navigate={() => {}} now={() => NOW} />);
    const link = await screen.findByRole("link", { name: "Apri Vecchio" });
    expect(link).toHaveAttribute("href", `#doc=${ID_A}`);
  });

  it("'Nuovo documento' crea un documento vuoto e lo apre", async () => {
    const client = makeClient();
    const navigate = vi.fn();
    render(<Home client={client} navigate={navigate} now={() => NOW} />);
    await screen.findByText("Nessun documento, per ora");
    await userEvent.click(screen.getByRole("button", { name: "Nuovo documento" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#doc=new-doc"));
    expect(client.createDocument).toHaveBeenCalledTimes(1);
    expect(client.submitOp).not.toHaveBeenCalled();
  });

  it("un template crea il documento, gli manda gli op e lo apre", async () => {
    const client = makeClient();
    const navigate = vi.fn();
    render(<Home client={client} navigate={navigate} now={() => NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Crea da template: Checkout" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#doc=new-doc"));
    expect(client.createDocument).toHaveBeenCalledWith({ name: "Checkout" });
    expect((client.submitOp as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(50);
  });

  it("se il template non si applica per intero lo dice e resta in Home", async () => {
    const client = makeClient();
    (client.submitOp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disco pieno"));
    const navigate = vi.fn();
    render(<Home client={client} navigate={navigate} now={() => NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Crea da template: Onboarding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/non si è applicato per intero \(disco pieno\)/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rinomina una card: Invio conferma e chiama il server", async () => {
    const client = makeClient(DOCS);
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[0];
    await userEvent.click(within(card).getByRole("button", { name: "Azioni per Recente" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rinomina" }));
    const input = await screen.findByRole("textbox", { name: "Nome del documento" });
    await userEvent.clear(input);
    await userEvent.type(input, "Nuovo nome{Enter}");
    await waitFor(() => expect(client.renameDocument).toHaveBeenCalledWith({ docId: ID_B, name: "Nuovo nome" }));
    expect(await screen.findByText("Nuovo nome")).toBeInTheDocument();
  });

  it("Esc annulla la rinomina senza chiamare il server", async () => {
    const client = makeClient(DOCS);
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[0];
    await userEvent.click(within(card).getByRole("button", { name: "Azioni per Recente" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rinomina" }));
    const input = await screen.findByRole("textbox", { name: "Nome del documento" });
    await userEvent.type(input, "xyz{Escape}");
    expect(client.renameDocument).not.toHaveBeenCalled();
    expect(screen.getByText("Recente")).toBeInTheDocument();
  });

  it("eliminare chiede conferma: Annulla non tocca nulla, Elimina cancella", async () => {
    const client = makeClient(DOCS);
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[1];
    await userEvent.click(within(card).getByRole("button", { name: "Azioni per Vecchio" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Elimina" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Eliminare/)).toHaveTextContent("Vecchio");
    await userEvent.click(within(dialog).getByRole("button", { name: "Annulla" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(client.deleteDocument).not.toHaveBeenCalled();

    await userEvent.click(within(card).getByRole("button", { name: "Azioni per Vecchio" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Elimina" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Elimina" }));
    await waitFor(() => expect(client.deleteDocument).toHaveBeenCalledWith({ docId: ID_A }));
    await waitFor(() => expect(screen.queryByText("Vecchio")).not.toBeInTheDocument());
  });

  it("se il server rifiuta l'eliminazione (documento aperto) la finestra resta e lo spiega", async () => {
    const client = makeClient(DOCS);
    (client.deleteDocument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("il documento è aperto in un editor"));
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    const card = (await screen.findAllByRole("article"))[0];
    await userEvent.click(within(card).getByRole("button", { name: "Azioni per Recente" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Elimina" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Elimina" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("aperto in un editor");
    expect(screen.getByText("Recente")).toBeInTheDocument();
  });

  it("il campo 'unisciti' accetta un link completo e apre quel documento", async () => {
    const navigate = vi.fn();
    render(<Home client={makeClient()} navigate={navigate} now={() => NOW} />);
    const field = await screen.findByLabelText("Link di un documento condiviso");
    const join = screen.getByRole("button", { name: "Unisciti" });
    expect(join).toBeDisabled();
    await userEvent.type(field, `http://192.168.1.7:8080/#doc=${ID_A.toUpperCase()}{Enter}`);
    expect(navigate).toHaveBeenCalledWith(`#doc=${ID_A}`);
  });

  it("un link non valido mostra l'errore e non naviga", async () => {
    const navigate = vi.fn();
    render(<Home client={makeClient()} navigate={navigate} now={() => NOW} />);
    const field = await screen.findByLabelText("Link di un documento condiviso");
    await userEvent.type(field, "ciao{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Non è un link di opendesigner valido.");
    expect(navigate).not.toHaveBeenCalled();
    // riscrivere toglie l'errore
    await userEvent.type(field, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("se l'elenco non si legge lo dice, senza nascondere i template", async () => {
    const client = makeClient();
    (client.listDocuments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("server spento"));
    render(<Home client={client} navigate={() => {}} now={() => NOW} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("server spento");
    expect(screen.getByRole("button", { name: "Crea da template: Vuoto" })).toBeInTheDocument();
  });
});
