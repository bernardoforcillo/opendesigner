// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FacilitationBar } from "./FacilitationBar";
import { useFacilitation } from "../store/facilitation";
import { newPeer, usePresence } from "../store/presence";

afterEach(cleanup);
beforeEach(() => {
  useFacilitation.setState({ votes: [], timer: null, chat: "", reaction: "", emoteSeq: 0, following: null });
  usePresence.setState({ peers: {} });
});

describe("FacilitationBar", () => {
  it("starts a timer that everyone sees, and the starter can stop it", () => {
    render(<FacilitationBar myId="me" />);
    fireEvent.click(screen.getByRole("button", { name: "3 min" }));
    expect(useFacilitation.getState().timer).not.toBeNull();
    expect(screen.getByRole("timer").textContent).toMatch(/^[23]:\d\d/);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(useFacilitation.getState().timer).toBeNull();
  });

  it("shows another person's timer without a Stop button", () => {
    usePresence.setState({ peers: { p: newPeer("p", "Pia", { timerStartedMs: Date.now(), timerEndMs: Date.now() + 120000, timerLabel: "Ideas" }) } });
    render(<FacilitationBar myId="me" />);
    expect(screen.getByRole("timer").textContent).toContain("Ideas");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("counts dots left and can take them back", () => {
    useFacilitation.setState({ votes: ["a", "a"] });
    render(<FacilitationBar myId="me" />);
    expect(screen.getByLabelText("Dots left").textContent).toBe("3/5 dots");
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(useFacilitation.getState().votes).toEqual([]);
  });

  it("lists the results, mine and theirs together", () => {
    useFacilitation.setState({ votes: ["a"] });
    usePresence.setState({ peers: { p: newPeer("p", "Pia", { votes: ["a", "b"] }) } });
    render(<FacilitationBar myId="me" />);
    fireEvent.click(screen.getByRole("button", { name: "Results" }));
    const items = screen.getByRole("list", { name: "Voting results" }).querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("2");
  });

  it("sends a reaction and a chat line, and follows a person who shares their view", () => {
    usePresence.setState({ peers: { p: newPeer("p", "Pia", { hasView: true }) } });
    render(<FacilitationBar myId="me" />);
    fireEvent.click(screen.getByRole("button", { name: "React 🎉" }));
    expect(useFacilitation.getState()).toMatchObject({ reaction: "🎉", emoteSeq: 1 });
    fireEvent.change(screen.getByLabelText("Say something at your cursor"), { target: { value: "look here" } });
    fireEvent.submit(screen.getByLabelText("Say something at your cursor"));
    expect(useFacilitation.getState()).toMatchObject({ chat: "look here", emoteSeq: 2 });
    fireEvent.change(screen.getByLabelText("Follow"), { target: { value: "p" } });
    expect(useFacilitation.getState().following).toBe("p");
  });
});
