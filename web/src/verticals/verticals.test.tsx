import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";

vi.mock("@/home/nav", () => ({ useAppNavigate: () => vi.fn() }));
vi.mock("@/rpc/client", () => ({ docClient: {} }));

import { menuShows, modeFor, VERTICAL_DEFS, VERTICAL_LIST, verticalDef } from ".";
import { DocMenu } from "@/ui/shell/DocMenu";
import { ModeTabs } from "@/ui/shell/ModeTabs";
import { TopBar } from "@/ui/shell/TopBar";
import { useScene } from "@/store/store";
import { useFlowUi } from "@/store/flowUi";
import { emptyScene, type Vertical } from "@/store/types";

class FakeSync {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}
function openAs(vertical: Vertical) {
  const scene = emptyScene("doc-1", "Doc");
  useScene.getState().setScene(vertical === "product" ? scene : { ...scene, settings: { vertical } });
  useScene.getState().setSync(new FakeSync());
  useScene.setState({ gesture: null, undoStack: [], redoStack: [] });
}
afterEach(() => { cleanup(); useFlowUi.getState().setMode("design"); });

describe("vertical definitions", () => {
  it("has the three verticals, product being the one a plain document gets", () => {
    expect(VERTICAL_LIST.map((v) => v.id)).toEqual(["publishing", "design", "product"]);
    expect(verticalDef(undefined)).toBe(VERTICAL_DEFS.product);
  });

  it("keeps a mode the vertical offers, and moves to its first mode otherwise", () => {
    expect(modeFor("product", "flows")).toBe("flows");
    expect(modeFor("publishing", "flows")).toBe("design");
    expect(modeFor("publishing", "dev")).toBe("design");
    expect(modeFor("design", "board")).toBe("board");
    expect(modeFor("design", "dev")).toBe("design");
  });

  it("every vertical can design, and publishing is the only one with page setup in its menu", () => {
    for (const v of VERTICAL_LIST) expect(v.modes).toContain("design");
    expect(menuShows("publishing", "page-setup")).toBe(true);
    expect(menuShows("design", "page-setup")).toBe(false);
    expect(menuShows("product", "export-epub")).toBe(false);
    expect(menuShows("publishing", "board")).toBe(false);
    expect(menuShows("product", "board")).toBe(true);
  });
});

describe("mode tabs by vertical", () => {
  // Board, Design, Flows and Develop are the tabs at the top of the right panel; Publishing's one mode is in the top bar.
  const bar = () => {
    const publishing = useScene.getState().scene?.settings?.vertical === "publishing";
    return render(publishing
      ? <TopBar mode="design" presence={null} onNewDocument={() => {}} connection="connected" statusLabel="ok" />
      : <ModeTabs />);
  };
  const modes = () => screen.getAllByRole("radio").map((r) => r.textContent);

  it("product offers every mode", () => {
    openAs("product");
    bar();
    expect(modes()).toEqual(["Board", "Design", "Flows", "Develop"]);
  });

  it("design offers the board and the design mode", () => {
    openAs("design");
    bar();
    expect(modes()).toEqual(["Board", "Design"]);
  });

  it("publishing offers a single Layout mode", () => {
    openAs("publishing");
    bar();
    expect(modes()).toEqual(["Layout"]);
  });
});

describe("DocMenu by vertical", () => {
  beforeEach(() => openAs("product"));
  const open = async () => {
    render(<DocMenu onNewDocument={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Document menu" }));
  };
  const names = () => screen.getAllByRole("menuitem").map((m) => m.textContent ?? "");

  it("publishing shows the print and EPUB export and page setup, and tucks away boards, tokens and plugins", async () => {
    openAs("publishing");
    await open();
    const items = names().join("|");
    expect(items).toContain("Export all pages as EPUB");
    expect(items).toContain("Export PDF for print");
    expect(items).toContain("Page setup");
    expect(items).not.toContain("Whiteboard");
    expect(items).not.toContain("Variables");
    expect(items).not.toContain("Plugins");
  });

  it("product keeps whiteboard, variables and plugins and has no EPUB", async () => {
    await open();
    const items = names().join("|");
    expect(items).toContain("Whiteboard");
    expect(items).toContain("Variables");
    expect(items).toContain("Plugins");
    expect(items).not.toContain("EPUB");
  });

  it("lists the three document types with the current one checked, and switching writes the setting (one undo)", async () => {
    await open();
    expect(screen.getByRole("menuitem", { name: /Design × Development/ }).querySelector("svg:last-of-type")).not.toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Publishing" }));
    expect(useScene.getState().scene!.settings).toEqual({ vertical: "publishing" });
    useScene.getState().undo();
    expect(useScene.getState().scene!.settings).toBeUndefined();
  });

  it("switching back to Design × Development stores nothing (the default)", async () => {
    openAs("design");
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: /Design × Development/ }));
    expect(useScene.getState().scene!.settings).toBeUndefined();
  });
});
