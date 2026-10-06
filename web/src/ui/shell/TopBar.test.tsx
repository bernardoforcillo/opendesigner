import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TopBar } from "./TopBar";
import { useScene } from "../../store/store";
import { useFlowUi } from "../../store/flowUi";
import { usePanels } from "./panels";

afterEach(cleanup);
afterEach(() => useFlowUi.getState().setMode("design"));

function renderTopBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      mode="design"
      presence={<span>fake-presence</span>}
      onNewDocument={vi.fn()}
      connection="connected"
      statusLabel="Connected"
      {...overrides}
    />,
  );
}

describe("TopBar", () => {
  it("mounts the document menu", () => {
    renderTopBar();
    expect(screen.getByRole("button", { name: "Document menu" })).toBeInTheDocument();
  });

  it("mounts the mode switch with the three modes", () => {
    renderTopBar();
    const group = screen.getByRole("radiogroup", { name: "Mode" });
    expect(group).toBeInTheDocument();
    for (const label of ["Design", "Flows", "Develop"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("choosing Flows really changes the mode in the store", () => {
    renderTopBar();
    fireEvent.click(screen.getByRole("radio", { name: /Flows/ }));
    expect(useFlowUi.getState().mode).toBe("flows");
  });

  it("mounts the presence received via prop", () => {
    renderTopBar();
    expect(screen.getByText("fake-presence")).toBeInTheDocument();
  });

  it("shows the camera zoom", () => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 1.5 } });
    renderTopBar();
    expect(screen.getByTitle("Zoom")).toHaveTextContent("150%");
  });

  it("shows the connection status", () => {
    renderTopBar({ statusLabel: "Reconnecting…" });
    expect(screen.getByTitle("Reconnecting…")).toBeInTheDocument();
  });

  it("shows the document name in the middle", () => {
    useScene.setState({ scene: { ...(useScene.getState().scene ?? ({} as never)), name: "Project" } as never });
    renderTopBar();
    expect(screen.getByRole("button", { name: "Rename document" })).toHaveTextContent("Project");
  });

  it("the panel buttons close and reopen them", () => {
    renderTopBar();
    const before = usePanels.getState().left;
    fireEvent.click(screen.getByRole("button", { name: before ? "Close left panel" : "Open left panel" }));
    expect(usePanels.getState().left).toBe(!before);
    usePanels.getState().toggle("left");
    const right = usePanels.getState().right;
    fireEvent.click(screen.getByRole("button", { name: right ? "Close right panel" : "Open right panel" }));
    expect(usePanels.getState().right).toBe(!right);
    usePanels.getState().toggle("right");
  });
});
