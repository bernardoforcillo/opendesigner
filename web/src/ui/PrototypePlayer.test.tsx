import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { PrototypePlayer } from "./PrototypePlayer";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { SceneState } from "../store/types";
import * as renderer from "../renderer/canvasRenderer";

// jsdom has no 2D canvas: the real drawing (drawScene) is spied on, and what is
// tested here is the prototype's VIEW -- what is clickable, where it leads, what is
// disabled and why.

// jsdom does no layout: clientWidth/clientHeight are 0. The prototype's area
// is measured from there, so the tests fake it 800x600 (and one turns the fake off).
let measured = true;
function stubSize() {
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return measured ? (prop === "clientWidth" ? 800 : 600) : 0;
      },
    });
  }
}

beforeEach(() => {
  measured = true;
  stubSize();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  vi.spyOn(renderer, "drawScene").mockImplementation(() => {});
  useFlowUi.setState({ currentFlowId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

function install(s: SceneState) {
  useScene.getState().setScene(s);
}

// A -> B (hotspot "btn" on A, "Log in") ; A -> C (bar, guard user=admin) ;
// B -> C (bar, "End", effect done=true) ; C without exits.
const demo = () =>
  withFlows(baseScene(), [flowOf("f1", "A", "Main")], [
    transition("t1", "f1", "A", "B", { label: "Log in", elementId: "btn", effect: "user=guest" }),
    transition("t2", "f1", "A", "C", { label: "Admin", guard: "user=admin" }),
    transition("t3", "f1", "B", "C", { label: "End", effect: "done=true" }),
  ]);

describe("PrototypePlayer", () => {
  beforeEach(() => install(demo()));

  it("starts from the flow's entry screen, with back disabled", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Prototype" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("A");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    // the screen drawing comes from the usual renderer, on the derived scene
    expect(renderer.drawScene).toHaveBeenCalled();
    const scene = vi.mocked(renderer.drawScene).mock.calls.at(-1)![1];
    expect(scene.pages).toHaveLength(1);
    expect(vi.mocked(renderer.drawScene).mock.calls.at(-1)![3]).toBe("__prototype__");
  });

  it("without an entry in the flow it falls back to the first top-level frame", () => {
    install(withFlows(baseScene(), [flowOf("f1", "")], [transition("t", "f1", "A", "B")]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("A");
  });

  it("without any flow it still shows the first screen (and has no exits)", () => {
    install(baseScene());
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("A");
    expect(screen.getByText(/End of the path/)).toBeInTheDocument();
  });

  it("without any screen it says what to do", () => {
    install(withFlows({ ...baseScene(), nodes: baseScene().nodes.set("A", { ...baseScene().nodes.at("A"), kind: "rect" }).set("B", { ...baseScene().nodes.at("B"), kind: "rect" }).set("C", { ...baseScene().nodes.at("C"), kind: "rect" }) }, [], []));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByText(/No screen to present/)).toBeInTheDocument();
  });

  it("a transition with an element is a clickable region over the element; the others are in the bar", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    // the hotspot is a <button> outside the actions bar
    const bar = screen.getByRole("group", { name: "Screen actions" });
    const hot = screen.getByRole("button", { name: "Log in" });
    expect(bar).not.toContainElement(hot);
    // the bar has "Admin", not "Log in"
    expect(within(bar).getByRole("button", { name: "Admin" })).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("the hotspot sits over the element, in screen coordinates scaled to fit the area", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    const hot = screen.getByRole("button", { name: "Log in" });
    // A is 200x300 in an 800x600 area with a 48px margin: zoom = min(704/200, 504/300) = 1.68
    const z = 504 / 300;
    const camX = 400 - 100 * z;
    const camY = 300 - 150 * z;
    expect(parseFloat(hot.style.left)).toBeCloseTo(60 * z + camX, 1);
    expect(parseFloat(hot.style.top)).toBeCloseTo(200 * z + camY, 1);
    expect(parseFloat(hot.style.width)).toBeCloseTo(80 * z, 1);
    expect(parseFloat(hot.style.height)).toBeCloseTo(30 * z, 1);
  });

  it("without a measure of the area positions are not invented: the hotspots fall back to the bar", () => {
    measured = false;
    render(<PrototypePlayer onClose={() => {}} />);
    const bar = screen.getByRole("group", { name: "Screen actions" });
    expect(within(bar).getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  it("a disabled hotspot (guard) stays visible but does not navigate, and says why", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t", "f1", "A", "B", { label: "Pay", elementId: "btn", guard: "cart=full" })]));
    render(<PrototypePlayer onClose={() => {}} />);
    const hot = screen.getByRole("button", { name: "Pay" });
    expect(hot).toHaveAttribute("aria-disabled", "true");
    expect(hot).toHaveAttribute("title", "Requires cart=full");
    fireEvent.click(hot);
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent(/^A$/);
    expect(screen.getByText(/Pay: Requires cart=full/)).toBeInTheDocument();
  });

  it("clicking an exit changes screen, applies the effect and enables «Back»", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("A›B");
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    // the drawing moved to the new screen
    const scene = vi.mocked(renderer.drawScene).mock.calls.at(-1)![1];
    expect(scene.nodes.at("B").parentId).toBe("__prototype__");
    // variable set by the effect
    fireEvent.click(screen.getByRole("button", { name: "Variables" }));
    const vars = screen.getByRole("complementary", { name: "Prototype variables" });
    expect(vars).toHaveTextContent("user");
    expect(vars).toHaveTextContent("guest");
  });

  it("unsatisfied guard: button disabled WITH THE REASON, and the click does nothing", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    const admin = screen.getByRole("button", { name: "Admin" });
    expect(admin).toBeDisabled();
    expect(screen.getByText("Requires user=admin")).toBeInTheDocument();
    fireEvent.click(admin);
    expect(screen.getByRole("navigation", { name: "Path" })).not.toHaveTextContent("C");
  });

  it("free-text guard: disabled with «cannot be evaluated», never silently true", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t", "f1", "A", "B", { label: "Premium", guard: "premium user" })]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Premium" })).toBeDisabled();
    expect(screen.getByText(/Condition cannot be evaluated: "premium user"/)).toBeInTheDocument();
  });

  it("the guard unlocks when a variable satisfies it", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [
      transition("t1", "f1", "A", "B", { label: "Set", effect: "user=admin" }),
      transition("t2", "f1", "B", "A", { label: "Return" }),
      transition("t3", "f1", "A", "C", { label: "Admin", guard: "user=admin" }),
    ]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Admin" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(screen.getByRole("button", { name: "Return" }));
    // back on A, but now user=admin
    expect(screen.getByRole("button", { name: "Admin" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("C");
  });

  it("«Back» returns to the previous screen and variables", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("C");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("A›B");
    fireEvent.click(screen.getByRole("button", { name: "Variables" }));
    expect(screen.getByRole("complementary", { name: "Prototype variables" })).not.toHaveTextContent("done");
  });

  it("«Restart» starts again from the entry with the variables cleared", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent(/^A$/);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("the path breadcrumbs are clickable and go back to that point", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    const nav = screen.getByRole("navigation", { name: "Path" });
    fireEvent.click(within(nav).getByRole("button", { name: "A" }));
    expect(nav).toHaveTextContent(/^A$/);
  });

  it("the last screen (without exits) says so", () => {
    render(<PrototypePlayer onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(screen.getByText(/End of the path/)).toBeInTheDocument();
  });

  it("Esc closes and does not reach the other global listeners; the «Exit» buttons close", () => {
    const onClose = vi.fn();
    const other = vi.fn();
    window.addEventListener("keydown", other);
    render(<PrototypePlayer onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    window.removeEventListener("keydown", other);
    fireEvent.click(screen.getByRole("button", { name: "Close the prototype" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("uses the current flow chosen in the interface", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A", "One"), flowOf("f2", "B", "Two")], [
      transition("t1", "f1", "A", "C", { label: "From one" }),
      transition("t2", "f2", "B", "C", { label: "From two" }),
    ]));
    useFlowUi.setState({ currentFlowId: "f2" });
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent("B");
    expect(screen.getByRole("button", { name: "From two" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "From one" })).not.toBeInTheDocument();
  });

  it("a destination deleted while presenting: disabled with the reason, no crash", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t", "f1", "A", "ghost", { label: "Broken" })]));
    render(<PrototypePlayer onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Broken" })).toBeDisabled();
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
  });
});
