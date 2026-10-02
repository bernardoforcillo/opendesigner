import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PresenceBar } from "./PresenceBar";
import { usePresence } from "../store/presence";

describe("PresenceBar", () => {
  afterEach(cleanup);
  beforeEach(() => {
    usePresence.setState({ peers: {} });
    localStorage.clear();
  });

  it("mostra un avatar per ogni altra persona", () => {
    usePresence.setState({
      peers: {
        a: { clientId: "a", nickname: "Ada", hasCursor: false, cursorX: 0, cursorY: 0, pageId: "", selection: [] },
        b: { clientId: "b", nickname: "bob", hasCursor: false, cursorX: 0, cursorY: 0, pageId: "", selection: [] },
      },
    });
    render(<PresenceBar nickname="Io" onNickname={() => {}} />);
    const list = screen.getByRole("list", { name: "Persone nel documento" });
    expect(list.children).toHaveLength(2);
    expect(screen.getByLabelText("Ada").textContent).toBe("A");
    expect(screen.getByLabelText("bob").textContent).toBe("B");
  });

  it("cambiare nickname lo salva e lo comunica, a Invio", async () => {
    const onNickname = vi.fn();
    render(<PresenceBar nickname="Io" onNickname={onNickname} />);
    const input = screen.getByLabelText("Il tuo nickname");
    await userEvent.clear(input);
    await userEvent.type(input, "Cleo{Enter}");
    expect(onNickname).toHaveBeenCalledWith("Cleo");
    expect(localStorage.getItem("opendesigner.nickname")).toBe("Cleo");
  });

  it("un nickname svuotato torna a quello di prima, senza comunicare nulla", async () => {
    const onNickname = vi.fn();
    render(<PresenceBar nickname="Io" onNickname={onNickname} />);
    const input = screen.getByLabelText("Il tuo nickname") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");
    expect(onNickname).not.toHaveBeenCalled();
    expect(input.value).toBe("Io");
  });

  it("Condividi copia il link del documento", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PresenceBar nickname="Io" onNickname={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Condividi" }));
    expect(writeText).toHaveBeenCalledWith(location.href);
    expect(await screen.findByRole("button", { name: "Link copiato" })).toBeTruthy();
  });
});
