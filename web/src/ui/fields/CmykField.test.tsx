// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CmykField } from "./CmykField";

afterEach(cleanup);

describe("CmykField", () => {
  it("opens on demand and shows the color in print terms, with the honest note", () => {
    render(<CmykField value={{ r: 1, g: 0, b: 0 }} onCommit={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "CMYK" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "CMYK" }));
    const group = screen.getByRole("group", { name: "CMYK" });
    const values = Array.from(group.querySelectorAll("input")).map((i) => i.value);
    expect(values).toEqual(["0", "100", "100", "0"]);
    expect(screen.getByText(/printer's profile is not applied/)).toBeInTheDocument();
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
