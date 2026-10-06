import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App, toolsForMode } from "./App";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import { baseScene } from "../flow/testSupport";

// DEVELOP MODE inside App: the selector's third segment, the panels that
// replace those of Design/Flows, the reduced tools and the S shortcut.
// As for Flows, App is the only place where they become reachable.

const exportCode = vi.fn(async () => ({ files: [], warnings: [] }));
vi.mock("../rpc/client", () => ({
  docClient: {
    createDocument: vi.fn(async () => ({ id: "doc-1" })),
    analyzeFlows: vi.fn(async () => ({ reports: [] })),
    exportCode: (...a: unknown[]) => (exportCode as (...x: unknown[]) => unknown)(...a),
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
  exportCode.mockClear();
  useFlowUi.setState({ mode: "design", presenting: false, selectedTransitionId: null, currentFlowId: null });
});

describe("Develop mode", () => {
  it("toolsForMode: in Develop only Select and Hand; Design and Flows as before", () => {
    expect(toolsForMode("dev").map((t) => t.id)).toEqual(["select", "hand"]);
    expect(toolsForMode("flows").map((t) => t.id)).toEqual(["select", "connect", "hand"]);
    expect(toolsForMode("design").map((t) => t.id)).not.toContain("connect");
  });

  it("the selector has three segments; Develop replaces layers and properties with Readiness and Ship", () => {
    useScene.getState().setScene(baseScene());
    render(<App />);
    expect(["Design", "Flows", "Develop"].map((n) => screen.getByRole("radio", { name: n }))).toHaveLength(3);

    fireEvent.click(screen.getByRole("radio", { name: "Develop" }));
    expect(useFlowUi.getState().mode).toBe("dev");
    expect(screen.getByRole("radio", { name: "Develop" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("complementary", { name: "Readiness" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Ship" })).toBeInTheDocument();
    expect(screen.queryByRole("grid", { name: "Layers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Properties" })).not.toBeInTheDocument();
    expect(screen.getByTestId("code-workbench")).toBeInTheDocument();
    // tools: only select and hand; no shapes, no Connect, no Present
    expect(screen.getByRole("radio", { name: "Select" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Hand" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Rectangle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Present" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Design" }));
    expect(screen.getByRole("grid", { name: "Layers" })).toBeInTheDocument();
    expect(screen.queryByTestId("code-workbench")).not.toBeInTheDocument();
  });

  it("S opens Develop and S again goes back to Design; F from Develop goes back to Design", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    fireEvent.keyDown(window, { key: "s" });
    expect(useFlowUi.getState().mode).toBe("dev");
    fireEvent.keyDown(window, { key: "s" });
    expect(useFlowUi.getState().mode).toBe("design");
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("design");
    // in Flows, F leads to Design (unchanged) and S to Develop
    fireEvent.keyDown(window, { key: "f" });
    expect(useFlowUi.getState().mode).toBe("flows");
    fireEvent.keyDown(window, { key: "s" });
    expect(useFlowUi.getState().mode).toBe("dev");
  });

  it("S does not fire in a text field nor with a modifier", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(useFlowUi.getState().mode).toBe("design");
    input.remove();
  });

  it("a drawing tool chosen in Design falls back to Select when entering Develop", () => {
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Rectangle" }));
    expect(screen.getByRole("radio", { name: "Rectangle" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Develop" }));
    expect(screen.getByRole("radio", { name: "Select" })).toHaveAttribute("aria-checked", "true");
  });

  it("no work outside Develop: ExportCode is called only inside the mode", async () => {
    useScene.getState().setScene(baseScene());
    render(<App />);
    fireEvent.keyDown(window, { key: "f" }); // Flows
    await new Promise((r) => setTimeout(r, 30));
    expect(exportCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Develop" }));
    await vi.waitFor(() => expect(exportCode).toHaveBeenCalled());
    expect(exportCode.mock.calls[0]).toEqual([{ docId: "doc", target: "react", flowId: "" }, expect.objectContaining({ signal: expect.anything() })]);
  });
});
