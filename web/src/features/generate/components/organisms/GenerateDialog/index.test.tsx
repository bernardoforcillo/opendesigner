import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";
import { GenerateDialog } from "@features/generate/components/organisms/GenerateDialog";

afterEach(cleanup);

let written: string[] = [];
beforeEach(() => {
  written = [];
  const scene = emptyScene("doc-1", "Untitled");
  scene.components = { c1: { rootNodeId: "n1", name: "Button" } };
  scene.variables = { v1: { id: "v1", collectionId: "k", name: "color/primary", type: "color", values: {} } };
  useScene.getState().setScene(scene);
});

// userEvent.setup() installs its own clipboard stub, so ours goes in after it.
function setup() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (s: string) => { written.push(s); return Promise.resolve(); } } });
  return user;
}

describe("GenerateDialog", () => {
  it("shows what the kit holds and copies a prompt that names it", async () => {
    const user = setup();
    render(<GenerateDialog isOpen onOpenChange={() => {}} />);
    const kit = screen.getByRole("list", { name: "Design kit" });
    expect(kit).toHaveTextContent("Components1");
    expect(kit).toHaveTextContent("Color variables1");
    expect(kit).toHaveTextContent("Text styles0");

    const copy = screen.getByRole("button", { name: "Copy prompt for the agent" });
    expect(copy).toBeDisabled();
    await user.type(screen.getByLabelText("Description"), "A sign in screen");
    expect(copy).toBeEnabled();
    await user.click(copy);
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("A sign in screen");
    expect(written[0]).toContain('"Button"');
    expect(written[0]).toContain('"color/primary"');
    expect(await screen.findByText(/Copied/)).toBeInTheDocument();
  });

  it("says so when the kit is empty, and allows a screenshot with no description", async () => {
    const user = setup();
    useScene.getState().setScene(emptyScene("doc-2", "Empty"));
    render(<GenerateDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("The kit is empty");
    await user.click(screen.getByLabelText("I will attach a screenshot to the agent"));
    await user.click(screen.getByRole("button", { name: "Copy prompt for the agent" }));
    await waitFor(() => expect(written[0]).toContain("attached screenshot"));
  });
});
