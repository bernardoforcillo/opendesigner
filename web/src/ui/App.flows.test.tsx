import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App, TOOLS } from "./App";
import { connectTool } from "../tools/connectTool";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

// FLOWS MODE inside App: the toggle in the header, the tools, the
// panels and the F / K shortcuts. App is the only place where they become
// reachable (same reason as the toolbar tests in App.test.tsx).

vi.mock("../rpc/client", () => ({
  docClient: {
    createDocument: vi.fn(async () => ({ id: "doc-1" })),
    analyzeFlows: vi.fn(async () => ({ reports: [] })),
  },
}));
vi.mock("../rpc/syncClient", () => ({
  SyncClient: class {
    async start() {}
    stop() {}
  },
}));
vi.stubGlobal("localStorage", { getItem: () => "doc-1", setItem: () => {}, removeItem: () => {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useFlowUi.setState({ mode: "design", presenting: false, selectedTransitionId: null, currentFlowId: null });
});

describe("Flows mode", () => {
  it("the Connect tool is registered and is the real connectTool", () => {
    expect(TOOLS.connect).toBe(connectTool);
  });

  it("the Design | Flows toggle changes panels and tools", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    expect(screen.getByRole("radio", { name: "Design" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("grid", { name: "Layers" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Flows" }));
    expect(useFlowUi.getState().mode).toBe("flows");
    // The flows panel replaces the layers; "Connect" appears, "Rectangle" does not.
    expect(screen.queryByRole("grid", { name: "Layers" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Flows" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Rectangle" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Present" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Design" }));
    expect(screen.getByRole("grid", { name: "Layers" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Present" })).not.toBeInTheDocument();
  });

  it("F toggles the mode, K enters Flows with Connect active", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    const { container } = render(<App />);
    const canvas = container.querySelector("#scene") as HTMLCanvasElement;
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("flows");
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("design");

    fireEvent.keyDown(window, { key: "k" });
    expect(useFlowUi.getState().mode).toBe("flows");
    expect(screen.getByRole("radio", { name: "Connect" })).toHaveAttribute("aria-checked", "true");
    expect(canvas.style.cursor).toBe(connectTool.cursor);

    // Going back to Design the Connect tool (which does not exist there) falls back to Select.
    fireEvent.keyDown(window, { key: "f" });
    expect(screen.getByRole("radio", { name: "Select" })).toHaveAttribute("aria-checked", "true");
  });

  it("F and K do not fire while typing in a text field", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "f" });
    fireEvent.keyDown(input, { key: "k" });
    expect(useFlowUi.getState().mode).toBe("design");
    input.remove();
  });

  it("Present opens the prototype and Esc closes it", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Flows" }));
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    expect(screen.getByRole("dialog", { name: "Prototype" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Prototype" })).not.toBeInTheDocument();
  });
});
