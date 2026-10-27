import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { PrintPdfDialog } from "@/ui/PrintPdfDialog";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";

const run = vi.fn(async () => true);
const pack = vi.fn(async () => true);
vi.mock("@/export/exportScene", () => ({ runDocumentExport: (...a: unknown[]) => (run as unknown as (...x: unknown[]) => unknown)(...a), runPackage: (...a: unknown[]) => (pack as unknown as (...x: unknown[]) => unknown)(...a) }));

beforeEach(() => {
  cleanup();
  run.mockClear();
  const s = emptyScene("d", "Doc");
  s.pages = [{ id: "page1", name: "One", width: 100, height: 100, bleed: 9 }];
  act(() => useScene.getState().setScene(s));
});

describe("PrintPdfDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<PrintPdfDialog isOpen={false} onOpenChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("warns about a missing bleed once marks are on, and sends the options on Export", () => {
    const close = vi.fn();
    render(<PrintPdfDialog isOpen onOpenChange={close} />);
    expect(screen.getByText(/No problems found/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Crop marks and page information"));
    act(() => { const sc = useScene.getState().scene!; useScene.getState().setScene({ ...sc, pages: [{ id: "page1", name: "One", width: 100, height: 100 }] }); });
    expect(screen.getByText(/has no bleed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("PDF standard"), { target: { value: "x4" } });
    fireEvent.click(screen.getByText("Export"));
    expect(close).toHaveBeenCalledWith(false);
    expect(run).toHaveBeenCalledWith("pdf", {}, expect.objectContaining({ pdfx: "x4", marks: true, bleed: true }));
  });

  it("packages with the same options", () => {
    render(<PrintPdfDialog isOpen onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Package…"));
    expect(pack).toHaveBeenCalledWith({}, expect.objectContaining({ bleed: true, pdfx: "none" }));
  });

  it("offers spreads only for a facing-pages document", () => {
    render(<PrintPdfDialog isOpen onOpenChange={() => {}} />);
    expect((screen.getByLabelText("Facing pages as spreads") as HTMLInputElement).disabled).toBe(true);
  });
});
