import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CURVE_BOX, EasingEditor } from "./EasingEditor";
import { toPx } from "../../animation/easingEdit";

afterEach(cleanup);

// La mini-curva: il menu sceglie una curva con nome, i due punti si trascinano su
// una BOZZA e il rilascio conferma UNA volta sola.
const BOX = CURVE_BOX;

describe("EasingEditor", () => {
  it("il menu offre le curve con nome e 'Curva…' parte da una Bézier valida", async () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="easeOut" onCommit={onCommit} />);
    const sel = screen.getByRole("combobox", { name: "Easing" });
    expect(sel).toHaveValue("easeOut");
    await userEvent.selectOptions(sel, "spring");
    expect(onCommit).toHaveBeenLastCalledWith("spring");
    await userEvent.selectOptions(sel, "custom");
    expect(onCommit).toHaveBeenLastCalledWith("cubic-bezier(0.25,0.1,0.25,1)");
  });

  it("trascinare un punto: la bozza si vede subito, il commit è UNO al rilascio", () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="linear" onCommit={onCommit} />);
    const h2 = screen.getByRole("button", { name: "Punto di controllo 2" });
    const p = toPx(BOX, 0.7, 1.2);
    fireEvent.pointerDown(h2, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(screen.getByRole("group", { name: "Curva di easing" }), { pointerId: 1, clientX: p.x, clientY: p.y });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("cubic-bezier(0,0,0.7,1.2)")).toBeInTheDocument(); // l'etichetta segue la bozza
    fireEvent.pointerUp(screen.getByRole("group", { name: "Curva di easing" }), { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("cubic-bezier(0,0,0.7,1.2)");
  });

  it("un press senza movimento non conferma niente", () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="easeIn" onCommit={onCommit} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Punto di controllo 1" }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByRole("group", { name: "Curva di easing" }), { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("le frecce spostano un punto da tastiera", () => {
    const onCommit = vi.fn();
    render(<EasingEditor value="linear" onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Punto di controllo 1" }), { key: "ArrowUp" });
    expect(onCommit).toHaveBeenCalledWith("cubic-bezier(0,0.02,1,1)");
  });
});
