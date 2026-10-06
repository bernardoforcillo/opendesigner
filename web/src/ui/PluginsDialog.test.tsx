// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const runPlugin = vi.hoisted(() => vi.fn());
vi.mock("../plugins/run", () => ({ runPlugin }));

import { PluginsDialog } from "./PluginsDialog";
import { EXAMPLE_PLUGIN } from "../plugins/manifest";

beforeEach(() => { localStorage.clear(); runPlugin.mockReset(); });
afterEach(cleanup);

describe("PluginsDialog", () => {
  it("installs a plugin from pasted JSON, lists it with its permissions, and removes it", () => {
    render(<PluginsDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByText("No plugins yet")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Plugin JSON"), { target: { value: JSON.stringify(EXAMPLE_PLUGIN) } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const list = screen.getByRole("list", { name: "Installed plugins" });
    expect(within(list).getByText(/Number the selection/)).toBeInTheDocument();
    expect(within(list).getByText(/can read and write/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("od.plugins")!)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove Number the selection" }));
    expect(screen.getByText("No plugins yet")).toBeInTheDocument();
  });

  it("refuses something that is not a plugin and says why", () => {
    render(<PluginsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Plugin JSON"), { target: { value: '{"name":"x"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByRole("alert")).toHaveTextContent("needs `code`");
  });

  it("runs a plugin and reports what it said, or why it failed", async () => {
    render(<PluginsDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Plugin JSON"), { target: { value: JSON.stringify(EXAMPLE_PLUGIN) } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    runPlugin.mockImplementationOnce(async (_p, o) => { o.notify("Numbered 2 layers."); return { ok: true }; });
    fireEvent.click(screen.getByRole("button", { name: "Run Number the selection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Numbered 2 layers.");
    runPlugin.mockResolvedValueOnce({ ok: false, error: "boom" });
    fireEvent.click(screen.getByRole("button", { name: "Run Number the selection" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Number the selection: boom"));
  });
});
