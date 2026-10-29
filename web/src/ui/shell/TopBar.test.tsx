import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TopBar } from "@/ui/shell/TopBar";
import { useScene } from "@/store/store";
import { useFlowUi } from "@/store/flowUi";
import { usePanels } from "@/ui/shell/panels";

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

  it("leaves the modes to the right panel (the Publishing workspace keeps its one here)", () => {
    renderTopBar();
    expect(screen.queryByRole("radiogroup", { name: "Mode" })).toBeNull();
  });

  it("mounts the presence received via prop", () => {
    renderTopBar();
    expect(screen.getByText("fake-presence")).toBeInTheDocument();
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
