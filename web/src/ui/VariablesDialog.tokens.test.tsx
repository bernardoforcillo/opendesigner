import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

const downloads = vi.hoisted(() => ({ saved: [] as { blob: Blob; name: string }[] }));
vi.mock("../export/exportScene", () => ({ downloadBlob: (blob: Blob, name: string) => { downloads.saved.push({ blob, name }); } }));

import { VariablesDialog } from "./VariablesDialog";

const sync = {
  submit(op: Op) {
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  },
};

beforeEach(() => {
  downloads.saved = [];
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, sync: null });
  useScene.getState().setScene(emptyScene("d", "My doc"));
  useScene.setState({ sync: sync as never });
});
afterEach(cleanup);

const fileOf = (text: string): File => {
  const f = new File([text], "tokens.json", { type: "application/json" });
  Object.defineProperty(f, "text", { value: async () => text });
  return f;
};

describe("VariablesDialog tokens", () => {
  it("imports a DTCG file as collections and variables, and says what it did", async () => {
    render(<VariablesDialog isOpen onOpenChange={() => {}} />);
    const text = JSON.stringify({ brand: { $type: "color", blue: { $value: "#0a84ff" }, ink: { $value: "#111111" } } });
    fireEvent.change(screen.getByLabelText("Tokens file"), { target: { files: [fileOf(text)] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("imported 2 variables in 1 collection"));
    const s = useScene.getState().scene!;
    expect(Object.values(s.collections).map((c) => c.name)).toEqual(["brand"]);
    expect(Object.values(s.variables).map((v) => v.name).sort()).toEqual(["blue", "ink"]);
  });

  it("refuses a file that is not tokens, without touching the document", async () => {
    render(<VariablesDialog isOpen onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Tokens file"), { target: { files: [fileOf("not json")] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("could not import"));
    expect(Object.keys(useScene.getState().scene!.collections)).toHaveLength(0);
  });

  it("exports JSON and CSS of what is there (disabled with nothing to export)", async () => {
    render(<VariablesDialog isOpen onOpenChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Tokens file"), { target: { files: [fileOf(JSON.stringify({ t: { $type: "number", gap: { $value: 8 } } }))] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export CSS" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Export CSS" }));
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(downloads.saved.map((d) => d.name)).toEqual(["My doc.tokens.css", "My doc.tokens.json"]);
    expect(await downloads.saved[0].blob.text()).toContain("--gap: 8;");
  });
});
