import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { BookMetadataDialog } from "./BookMetadataDialog";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

const downloads: { blob: Blob; name: string }[] = [];
vi.mock("../export/exportScene", () => ({ downloadBlob: (blob: Blob, name: string) => { downloads.push({ blob, name }); } }));

beforeEach(() => {
  cleanup();
  downloads.length = 0;
  act(() => {
    useScene.getState().setScene(emptyScene("d", "Doc"));
    useScene.getState().setSync({ submit(op: Op) { useScene.getState().applyPending(op); useScene.getState().apply(op); } });
  });
});

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("BookMetadataDialog", () => {
  it("renders nothing while closed", () => {
    expect(render(<BookMetadataDialog isOpen={false} onOpenChange={() => {}} />).container.innerHTML).toBe("");
  });

  it("flags an invalid ISBN, lists what ONIX still lacks, and saves the record into the document settings", () => {
    const close = vi.fn();
    render(<BookMetadataDialog isOpen onOpenChange={close} />);
    type("ISBN-13", "978-88-04-66823-8");
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/Not a valid ISBN-13/);
    type("ISBN-13", "978-88-04-66823-7");
    type("Title", "Il nome della rosa");
    fireEvent.click(screen.getByText("Add a contributor"));
    type("Contributor name 1", "Umberto Eco");
    fireEvent.click(screen.getByText("Add a price"));
    type("Price amount 1", "9.99");
    expect(screen.getByLabelText("ONIX completeness").textContent).toContain("No publisher.");
    fireEvent.click(screen.getByText("Save"));
    expect(close).toHaveBeenCalledWith(false);
    expect(useScene.getState().scene!.settings!.book).toEqual({
      isbn13: "9788804668237", title: "Il nome della rosa",
      contributors: [{ role: "A01", personName: "Umberto Eco" }], prices: [{ priceType: "02", amount: "9.99", currency: "EUR" }],
    });
  });

  it("downloads the ONIX message named after the ISBN", async () => {
    render(<BookMetadataDialog isOpen onOpenChange={() => {}} />);
    type("ISBN-13", "9788804668237");
    type("Title", "T");
    fireEvent.click(screen.getByText("Save and download ONIX…"));
    expect(await downloads[0]!.blob.text()).toContain('release="3.1"');
    fireEvent.change(screen.getByLabelText("ONIX release"), { target: { value: "3.0" } });
    fireEvent.click(screen.getByText("Save and download ONIX…"));
    expect(await downloads[1]!.blob.text()).toContain('release="3.0"');
    expect(downloads[0]!.name).toBe("9788804668237.onix.xml");
    expect(await downloads[0]!.blob.text()).toContain("<IDValue>9788804668237</IDValue>");
  });

  it("will not download without an ISBN and a title", () => {
    render(<BookMetadataDialog isOpen onOpenChange={() => {}} />);
    expect((screen.getByText("Save and download ONIX…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts from the record already in the document", () => {
    act(() => { const s = useScene.getState().scene!; useScene.getState().setScene({ ...s, settings: { book: { title: "Known" } } }); });
    render(<BookMetadataDialog isOpen onOpenChange={() => {}} />);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Known");
  });
});
