import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasOnboarding, fitCameraToScreens, FIT_MARGIN } from "./CanvasOnboarding";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { emptyScene } from "../store/types";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import { loadDocPrefs, SHIPPED_EVENT } from "./docPrefs";
import { TEMPLATES } from "../templates/catalog";

const client = () => ({ submitOp: vi.fn(async () => ({})) });

function install(scene = emptyScene("doc-1", "Doc")) {
  act(() => useScene.getState().setScene(scene));
}

describe("CanvasOnboarding", () => {
  beforeEach(() => {
    localStorage.clear();
    useScene.getState().setScene(null);
    useFlowUi.getState().setPresenting(false);
  });
  afterEach(cleanup);

  it("on an empty document it shows 'Where do you want to start?' with the templates, 'Draw a screen (A)' and the 4 steps", () => {
    install();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    const card = screen.getByRole("region", { name: "Where do you want to start?" });
    expect(card).toBeInTheDocument();
    for (const { name: n } of TEMPLATES.filter((t) => t.id !== "blank")) {
      expect(screen.getByRole("button", { name: `Apply the ${n} template` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Draw a screen/ })).toHaveTextContent("A");
    const steps = screen.getByRole("list", { name: "Steps" }).querySelectorAll("li");
    expect([...steps].map((li) => li.textContent?.replace(/^\d/, ""))).toEqual(["Draw", "Connect", "Present", "Ship"]);
    expect([...steps].every((li) => li.getAttribute("data-done") === "false")).toBe(true);
  });

  it("does not capture clicks on the canvas: the container is pointer-events-none, only the card takes them", () => {
    install();
    const { container } = render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(container.firstElementChild).toHaveClass("pointer-events-none");
    expect(screen.getByRole("region", { name: "Where do you want to start?" })).toHaveClass("pointer-events-auto");
  });

  it("'Draw a screen' notifies the editor (which activates the frame tool)", async () => {
    install();
    const onDraw = vi.fn();
    render(<CanvasOnboarding onDrawScreen={onDraw} client={client()} />);
    await userEvent.click(screen.getByRole("button", { name: /Draw a screen/ }));
    expect(onDraw).toHaveBeenCalledTimes(1);
  });

  it("a template is applied to THIS document, via RPC, with the document's ids", async () => {
    install();
    const c = client();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={c} />);
    await userEvent.click(screen.getByRole("button", { name: `Apply the ${TEMPLATES.find((t) => t.id === "onboarding")!.name} template` }));
    await waitFor(() => expect(c.submitOp).toHaveBeenCalled());
    const calls = (c.submitOp as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every(([r]) => r.docId === "doc-1" && r.op.docId === "doc-1")).toBe(true);
    // until the template has fully arrived the big card stays
    expect(screen.getByRole("region", { name: "Where do you want to start?" })).toBeInTheDocument();
  });

  it("the X closes the card and the choice is remembered per document (even after a remount)", async () => {
    install();
    const { unmount } = render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    await userEvent.click(screen.getByRole("button", { name: /don't show again/ }));
    expect(screen.queryByRole("region", { name: "Where do you want to start?" })).not.toBeInTheDocument();
    expect(loadDocPrefs("doc-1").dismissed).toBe(true);
    unmount();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(screen.queryByRole("region", { name: "Where do you want to start?" })).not.toBeInTheDocument();
    // another document is not touched
    install({ ...emptyScene("doc-2", "Other") });
    cleanup();
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(screen.getByRole("region", { name: "Where do you want to start?" })).toBeInTheDocument();
  });

  it("with screens the big card gives way to 'Getting started', which ticks itself off", () => {
    install(baseScene());
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    expect(screen.queryByRole("region", { name: "Where do you want to start?" })).not.toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(card).toHaveTextContent("1/4");
    const done = () => [...card.querySelectorAll("li")].filter((li) => li.getAttribute("data-done") === "true").map((li) => li.textContent);
    expect(done()).toEqual(["Draw"]);
    // the document changes: a transition is born -> Connect ticks off
    act(() => useScene.getState().setScene(withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")])));
    expect(done()).toEqual(["Draw", "Connect"]);
    expect(card).toHaveTextContent("2/4");
  });

  it("opening the prototype ticks 'Present' and remembers it", () => {
    install(withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]));
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    act(() => useFlowUi.getState().setPresenting(true));
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(card).toHaveTextContent("3/4");
    expect(loadDocPrefs("doc").presented).toBe(true); // baseScene() has id "doc"
  });

  it("the export event ticks 'Ship'; once the checklist is complete the card disappears and does not come back", () => {
    install(withFlows(baseScene(), [flowOf("f", "A")], [transition("t", "f", "A", "B")]));
    render(<CanvasOnboarding onDrawScreen={() => {}} client={client()} />);
    act(() => useFlowUi.getState().setPresenting(true));
    act(() => { window.dispatchEvent(new Event(SHIPPED_EVENT)); });
    expect(screen.queryByRole("region", { name: "Getting started" })).not.toBeInTheDocument();
    expect(loadDocPrefs("doc")).toMatchObject({ presented: true, shipped: true, dismissed: true });
  });
});

describe("fitCameraToScreens", () => {
  it("frames all the screens, never beyond 1:1, centered", () => {
    const cam = fitCameraToScreens(baseScene(), 1000, 600)!;
    // A, B, C: x 0..1000, y 0..300 (200 wide each, at a 400 pitch)
    expect(cam.zoom).toBeCloseTo((1000 - 2 * FIT_MARGIN) / 1000, 5);
    const worldCenterX = 500, worldCenterY = 150;
    expect(worldCenterX * cam.zoom + cam.x).toBeCloseTo(500, 5);
    expect(worldCenterY * cam.zoom + cam.y).toBeCloseTo(300, 5);
  });
  it("a single small screen is not enlarged beyond 1", () => {
    const scene = { ...baseScene() };
    const one = { ...scene, nodes: scene.nodes.delete("B").delete("C") };
    expect(fitCameraToScreens(one, 4000, 3000)!.zoom).toBe(1);
  });
  it("without screens or without space there is no camera", () => {
    expect(fitCameraToScreens(emptyScene("d", "n"), 800, 600)).toBeNull();
    expect(fitCameraToScreens(baseScene(), 0, 0)).toBeNull();
  });
});
