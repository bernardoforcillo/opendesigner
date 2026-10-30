import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useLanguage } from "@/i18n";
import { Button, IconButton } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";
import { SegRadio } from "@/ui/ds/props-controls";

afterEach(() => { cleanup(); useLanguage.getState().set("en"); });

// The shared controls translate their own labels, so every panel built from them follows the language.
describe("shared controls follow the interface language", () => {
  it("translates a field label, an icon button, a button and the segments", () => {
    useLanguage.getState().set("es");
    render(
      <>
        <NumberField label="Thickness" value={1} onCommit={() => {}} />
        <IconButton icon="plus" label="Add shadow" />
        <Button>Detach</Button>
        <SegRadio label="Alignment" value="left" onChange={() => {}} options={[{ value: "left", label: "Left" }]} />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Grosor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Añadir sombra" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Desvincular" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Alineación" })).toBeTruthy();
  });

  it("leaves a label with no entry as written", () => {
    useLanguage.getState().set("fr");
    render(<IconButton icon="plus" label="Something unlisted" />);
    expect(screen.getByRole("button", { name: "Something unlisted" })).toBeTruthy();
  });
});
