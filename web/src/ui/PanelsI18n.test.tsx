import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useLanguage } from "@/i18n";
import { ComponentsPanel } from "@/ui/ComponentsPanel";
import { FacilitationBar } from "@/ui/FacilitationBar";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";

// The Components panel and the Board's facilitation strip follow the interface language.
beforeEach(() => {
  localStorage.clear();
  act(() => { useScene.getState().setScene(emptyScene("d", "Doc")); });
});
afterEach(() => {
  cleanup();
  act(() => { useLanguage.getState().set("system"); });
});

describe("panels follow the language", () => {
  it("Components panel", () => {
    act(() => { useLanguage.getState().set("es"); });
    render(<ComponentsPanel />);
    expect(screen.getByRole("heading", { name: "Componentes" })).toBeTruthy();
    expect(screen.getByText("Sin componentes")).toBeTruthy();
  });

  it("Facilitation bar", () => {
    act(() => { useLanguage.getState().set("it"); });
    render(<FacilitationBar myId="me" />);
    expect(screen.getByRole("group", { name: "Facilitazione" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ritira" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Risultati" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Scrivi qualcosa…")).toBeTruthy();
  });
});
