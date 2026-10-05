import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ExportSection } from "./ExportSection";

// The same real click sequence used in ExportButton.test.tsx (now removed):
// react-aria's usePress mistakes for "virtual" a PointerEvent without
// pressure, which is what jsdom builds by default.
function press(el: Element) {
  const base = { button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, detail: 1 };
  fireEvent.pointerDown(el, { ...base, pressure: 0.5 });
  fireEvent.mouseDown(el, base);
  fireEvent.pointerUp(el, { ...base, pressure: 0 });
  fireEvent.mouseUp(el, base);
  fireEvent.click(el, base);
}

function radio(name: string): HTMLInputElement {
  return screen.getByRole("radio", { name }) as HTMLInputElement;
}

afterEach(cleanup);

describe("ExportSection", () => {
  it("shows Format and Scale inline, without needing to be opened", () => {
    render(<ExportSection onExport={vi.fn()} />);
    expect(radio("PNG")).toBeInTheDocument();
    expect(radio("SVG")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("offers no Scope control: the export is always of the selection", () => {
    render(<ExportSection onExport={vi.fn()} />);
    expect(screen.queryByRole("radio", { name: "Selection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Page" })).not.toBeInTheDocument();
  });

  it("scale is a PNG choice: it does not appear for SVG", () => {
    render(<ExportSection onExport={vi.fn()} />);
    expect(radio("2x")).toBeInTheDocument();
    fireEvent.click(radio("SVG"));
    expect(screen.queryByRole("radio", { name: "2x" })).not.toBeInTheDocument();
  });

  it("Download sends the chosen format and scale, with scope fixed to selection", () => {
    const onExport = vi.fn(async () => true);
    render(<ExportSection onExport={onExport} />);
    fireEvent.click(radio("3x"));
    press(screen.getByRole("button", { name: "Download" }));
    expect(onExport).toHaveBeenCalledWith({ format: "png", scope: "selection", scale: 3 });
  });

  it("SVG sends scale 1 even if not shown", () => {
    const onExport = vi.fn(async () => true);
    render(<ExportSection onExport={onExport} />);
    fireEvent.click(radio("SVG"));
    press(screen.getByRole("button", { name: "Download" }));
    expect(onExport).toHaveBeenCalledWith({ format: "svg", scope: "selection", scale: 1 });
  });
});
