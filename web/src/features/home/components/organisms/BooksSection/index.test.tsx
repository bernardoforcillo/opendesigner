import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BooksSection, type BookChapterData, type BookData, type BooksClient } from "@features/home/components/organisms/BooksSection";

const A = "0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";
const B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c80";
const DOCS = [{ id: A, name: "Part one" }, { id: B, name: "Part two" }];

const chapter = (docId: string, name: string, over: Partial<BookChapterData> = {}): BookChapterData => ({
  docId, name, pages: 3, firstPageNumber: 1, missing: false, numbered: true, stylesBehind: 0, ...over,
});

function makeClient(books: BookData[], chapters: BookChapterData[]) {
  const list = books.map((b) => ({ ...b }));
  const client = {
    listBooks: vi.fn(async () => ({ books: [...list] })),
    getBook: vi.fn(async (r: { bookId: string }) => ({ book: list.find((b) => b.id === r.bookId), chapters })),
    saveBook: vi.fn(async (r: { book: BookData }) => {
      const i = list.findIndex((b) => b.id === r.book.id);
      if (i >= 0) list[i] = r.book; else list.push({ ...r.book, id: "new-book" });
      return {};
    }),
    deleteBook: vi.fn(async (r: { bookId: string }) => { list.splice(list.findIndex((b) => b.id === r.bookId), 1); return {}; }),
    syncBook: vi.fn(async () => ({})),
  } satisfies BooksClient;
  return client;
}

const BOOK: BookData = { id: "bk", name: "Novel", docIds: [A, B], styleSourceId: "", startNumber: 0 };

describe("BooksSection", () => {
  afterEach(cleanup);

  it("lists a book with its chapters, where each starts and what is out of step", async () => {
    const client = makeClient([BOOK], [chapter(A, "Part one"), chapter(B, "Part two", { firstPageNumber: 4, numbered: false, stylesBehind: 2 })]);
    render(<BooksSection client={client} docs={DOCS} />);
    const card = await screen.findByRole("article", { name: "Novel" });
    expect(within(card).getByText("2 chapters")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Part two" })).toHaveAttribute("href", `/doc/${B}`);
    expect(within(card).getByText(/Starts at page 4/)).toBeInTheDocument();
    expect(within(card).getByText("2 styles behind")).toBeInTheDocument();
    expect(within(card).getByText("Out of step")).toBeInTheDocument();
  });

  it("brings the book into line, and disables that when it already is", async () => {
    const user = userEvent.setup();
    const behind = makeClient([BOOK], [chapter(A, "Part one"), chapter(B, "Part two", { numbered: false })]);
    render(<BooksSection client={behind} docs={DOCS} />);
    await user.click(await screen.findByRole("button", { name: "Bring into line" }));
    expect(behind.syncBook).toHaveBeenCalledWith({ bookId: "bk", styles: true, numbering: true });
    cleanup();

    const inStep = makeClient([BOOK], [chapter(A, "Part one"), chapter(B, "Part two")]);
    render(<BooksSection client={inStep} docs={DOCS} />);
    expect(await screen.findByText("In step")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring into line" })).toBeDisabled();
  });

  it("creates a book from documents, in the order chosen", async () => {
    const user = userEvent.setup();
    const client = makeClient([], []);
    render(<BooksSection client={client} docs={DOCS} />);
    expect(await screen.findByText(/No books yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New book" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "Book name" }), "  Poems ");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Add a chapter…" }), A);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Add a chapter…" }), B);
    await user.click(within(dialog).getByRole("button", { name: "Move chapter up: Part two" }));
    await user.type(within(dialog).getByRole("spinbutton", { name: "First page number" }), "5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.saveBook).toHaveBeenCalled());
    expect(client.saveBook).toHaveBeenCalledWith({ book: { id: "", name: "Poems", docIds: [B, A], styleSourceId: "", startNumber: 5 } });
  });

  it("deletes a book after asking, and says why a save failed", async () => {
    const user = userEvent.setup();
    const client = makeClient([BOOK], [chapter(A, "Part one"), chapter(B, "Part two")]);
    client.saveBook.mockRejectedValueOnce(new Error("invalid book: chapter listed twice"));
    render(<BooksSection client={client} docs={DOCS} />);
    await user.click(await screen.findByRole("button", { name: "Edit book: Novel" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("chapter listed twice");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Delete book: Novel" }));
    const ask = await screen.findByRole("alertdialog");
    expect(ask).toHaveTextContent("Delete “Novel”? The documents stay.");
    await user.click(within(ask).getByRole("button", { name: "Delete book" }));
    await waitFor(() => expect(client.deleteBook).toHaveBeenCalledWith({ bookId: "bk" }));
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
  });
});
