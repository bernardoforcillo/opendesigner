import { beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { importFigFile } from "./importFig";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";

beforeEach(() => useScene.getState().setScene(emptyScene("doc-1", "Doc")));

const file = new File([new Uint8Array([1, 2, 3])], "Design.fig");

describe("importFigFile", () => {
  it("sends the file to the server and inserts what comes back, reporting the warnings", async () => {
    const client = { importFig: vi.fn().mockResolvedValue({ nodes: [{}, {}, {}], width: 10, height: 10, warnings: ["2 instances were imported as plain frames"] }) };
    const insert = vi.fn().mockReturnValue("root");
    const r = await importFigFile(file, client, insert);
    expect(client.importFig).toHaveBeenCalledWith({ docId: "doc-1", data: new Uint8Array([1, 2, 3]), name: "Design.fig" });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, message: "Imported 2 layers from Design.fig.", warnings: ["2 instances were imported as plain frames"] });
  });

  it("explains a file the server cannot read, and a server that does not answer", async () => {
    const bad = { importFig: vi.fn().mockRejectedValue(new ConnectError("figimport: this is not a Figma canvas", Code.InvalidArgument)) };
    expect(await importFigFile(file, bad, vi.fn())).toMatchObject({ ok: false, message: expect.stringContaining("this is not a Figma canvas") });
    const down = { importFig: vi.fn().mockRejectedValue(new Error("network")) };
    expect(await importFigFile(file, down, vi.fn())).toMatchObject({ ok: false, message: expect.stringContaining("did not answer") });
  });

  it("says so when it cannot insert", async () => {
    const client = { importFig: vi.fn().mockResolvedValue({ nodes: [{}], width: 1, height: 1, warnings: [] }) };
    expect(await importFigFile(file, client, vi.fn().mockReturnValue(null))).toMatchObject({ ok: false });
  });
});
