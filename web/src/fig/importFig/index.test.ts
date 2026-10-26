import { beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { importFigFile } from "@/fig/importFig/index";
import { useScene } from "@/store/store";
import { emptyScene } from "@/store/types";

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

  it("creates the imported collections, then the variables, ahead of the nodes", async () => {
    const collections = [{ id: "c1", name: "Theme", modes: [{ id: "m1", name: "Light" }] }];
    const variables = [{ id: "v1", name: "bg", collectionId: "c1" }, { id: "v2", name: "alias", collectionId: "c1", aliasOf: "v1" }];
    const client = { importFig: vi.fn().mockResolvedValue({ nodes: [{}, {}], width: 1, height: 1, warnings: [], collections, variables }) };
    const insert = vi.fn().mockReturnValue("root");
    const r = await importFigFile(file, client as never, insert);
    const leading = insert.mock.calls[0][3] as { kind: { case: string; value: Record<string, { id: string }> } }[];
    expect(leading.map((o) => o.kind.case)).toEqual(["setCollection", "setVariable", "setVariable"]);
    expect(leading[0].kind.value.collection.id).toBe("c1");
    expect(leading[2].kind.value.variable.id).toBe("v2");
    expect(r.message).toBe("Imported 1 layers and 2 variables in 1 collection from Design.fig.");
  });

  it("says so when it cannot insert", async () => {
    const client = { importFig: vi.fn().mockResolvedValue({ nodes: [{}], width: 1, height: 1, warnings: [] }) };
    expect(await importFigFile(file, client, vi.fn().mockReturnValue(null))).toMatchObject({ ok: false });
  });
});
