// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { resetActiveProfile, setActiveProfile } from "@/color/activeProfile";
import { CmykField } from "@/ui/fields/CmykField";

afterEach(cleanup);

describe("CmykField", () => {
  it("opens on demand and shows the color in print terms, with the honest note", () => {
    render(<CmykField value={{ r: 1, g: 0, b: 0 }} onCommit={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "CMYK" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "CMYK" }));
    const group = screen.getByRole("group", { name: "CMYK" });
    const values = Array.from(group.querySelectorAll("input")).map((i) => i.value);
    expect(values).toEqual(["0", "100", "100", "0"]);
    expect(screen.getByText(/Plain conversion from RGB/)).toBeInTheDocument();
  });

  it("reads the color through the document's ICC profile when one is loaded", () => {
    const bytes = new Uint8Array(200);
    act(() => setActiveProfile({ bytes, components: 4, managed: { colorSpace: "CMYK", description: "Stub", rgbToCmyk: () => ({ c: 11, m: 22, y: 33, k: 44 }), cmykToRgb: () => ({ r: 0, g: 0, b: 0 }) } }));
    try {
      render(<CmykField value={{ r: 1, g: 0, b: 0 }} onCommit={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "CMYK" }));
      const values = Array.from(screen.getByRole("group", { name: "CMYK" }).querySelectorAll("input")).map((i) => i.value);
      expect(values).toEqual(["11", "22", "33", "44"]);
      expect(screen.getByText(/through the document's ICC profile/)).toBeInTheDocument();
    } finally {
      act(() => resetActiveProfile());
    }
  });

  it("commits an edited channel as RGB", () => {
    const onCommit = vi.fn();
    render(<CmykField value={{ r: 1, g: 0, b: 0 }} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button", { name: "CMYK" }));
    const k = screen.getByLabelText("K");
    fireEvent.change(k, { target: { value: "50" } });
    fireEvent.keyDown(k, { key: "Enter" });
    fireEvent.blur(k);
    expect(onCommit).toHaveBeenCalled();
    const rgb = onCommit.mock.calls[0][0];
    expect(rgb.r).toBeCloseTo(0.5);
    expect(rgb.g).toBe(0);
  });
});
