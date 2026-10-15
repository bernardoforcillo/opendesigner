import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PresenceBar } from "./PresenceBar";
import { newPeer, usePresence } from "../store/presence";

describe("PresenceBar", () => {
  afterEach(cleanup);
  beforeEach(() => {
    usePresence.setState({ peers: {} });
    localStorage.clear();
  });

  it("shows an avatar for every other person", () => {
    usePresence.setState({
      peers: {
        a: newPeer("a", "Ada"),
        b: newPeer("b", "bob"),
      },
    });
    render(<PresenceBar nickname="Io" onNickname={() => {}} />);
    const list = screen.getByRole("list", { name: "People in the document" });
    expect(list.children).toHaveLength(2);
    expect(screen.getByLabelText("Ada").textContent).toBe("A");
    expect(screen.getByLabelText("bob").textContent).toBe("B");
  });

  it("changing the nickname saves and communicates it, on Enter", async () => {
    const onNickname = vi.fn();
    render(<PresenceBar nickname="Io" onNickname={onNickname} />);
    const input = screen.getByLabelText("Your nickname");
    await userEvent.clear(input);
    await userEvent.type(input, "Cleo{Enter}");
    expect(onNickname).toHaveBeenCalledWith("Cleo");
    expect(localStorage.getItem("opendesigner.nickname")).toBe("Cleo");
  });

  it("an emptied nickname goes back to the previous one, without communicating anything", async () => {
    const onNickname = vi.fn();
    render(<PresenceBar nickname="Io" onNickname={onNickname} />);
    const input = screen.getByLabelText("Your nickname") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");
    expect(onNickname).not.toHaveBeenCalled();
    expect(input.value).toBe("Io");
  });

  it("Share copies the document link", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PresenceBar nickname="Io" onNickname={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(writeText).toHaveBeenCalledWith(location.href);
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
  });

  it("compact: a single People button with the count; nickname and link are in the popover", async () => {
    usePresence.setState({
      peers: { a: newPeer("a", "Ada") },
    });
    const onNickname = vi.fn();
    render(<PresenceBar compact nickname="Io" onNickname={onNickname} />);
    const trigger = screen.getByRole("button", { name: "People" });
    expect(trigger.textContent).toContain("2"); // me + Ada
    // At rest there is neither the field nor the Share button.
    expect(screen.queryByLabelText("Your nickname")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    const input = await screen.findByLabelText("Your nickname");
    await userEvent.clear(input);
    await userEvent.type(input, "Zoe{Enter}");
    expect(onNickname).toHaveBeenCalledWith("Zoe");
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByText("Ada", { selector: "li span" })).toBeInTheDocument();
  });
});
