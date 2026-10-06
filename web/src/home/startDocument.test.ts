import { describe, expect, it, vi } from "vitest";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import { topLevelScreens } from "../flow/screens";
import { templateById } from "../templates/catalog";
import { applyTemplate, startDocument, StartError, type StartClient } from "./startDocument";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";

function fakeClient(over: Partial<StartClient> = {}) {
  const ops: { docId: string; clientId: string; op: Op }[] = [];
  const client: StartClient = {
    createDocument: vi.fn(async () => ({ id: "doc-9" })),
    openDocument: vi.fn(async () => ({ snapshot: { pages: [{ id: "page1" }] } })),
    submitOp: vi.fn(async (req) => { ops.push(req); return {}; }),
    ...over,
  };
  return { client, ops };
}

let n = 0;
const newId = () => `n${++n}`;

describe("startDocument", () => {
  it("Blank creates the document and sends no op", async () => {
    const { client, ops } = fakeClient();
    const id = await startDocument(client, templateById("blank")!);
    expect(id).toBe("doc-9");
    expect(client.createDocument).toHaveBeenCalledWith({ name: templateById("blank")!.docName });
    expect(ops).toHaveLength(0);
    expect(client.openDocument).not.toHaveBeenCalled();
  });

  it("a template sends the ops in order, all for the created document, and reports progress", async () => {
    const { client, ops } = fakeClient();
    const progress: number[] = [];
    const id = await startDocument(client, templateById("onboarding")!, { newId, onProgress: (d) => progress.push(d) });
    expect(id).toBe("doc-9");
    expect(ops.length).toBeGreaterThan(20);
    expect(ops.every((o) => o.docId === "doc-9" && o.op.docId === "doc-9")).toBe(true);
    expect(progress).toEqual(ops.map((_, i) => i + 1));
    // the ops, applied in that order to an empty scene, give the template
    const scene = ops.reduce((s, o) => applyOp(s, o.op), emptyScene("doc-9", "x"));
    expect(topLevelScreens(scene, "page1")).toHaveLength(3);
    expect(Object.keys(scene.flows)).toHaveLength(1);
  });

  it("uses the id of the document's first page, not a hardcoded 'page1'", async () => {
    const { client, ops } = fakeClient({ openDocument: vi.fn(async () => ({ snapshot: { pages: [{ id: "page-x" }] } })) });
    await startDocument(client, templateById("saas")!, { newId });
    const firstCreate = ops[0].op.kind;
    expect(firstCreate.case === "createNode" && firstCreate.value.node?.parentId).toBe("page-x");
  });

  it("if an op fails the error carries the id of the already created document", async () => {
    let calls = 0;
    const { client } = fakeClient({ submitOp: vi.fn(async () => { if (++calls === 3) throw new Error("disk full"); }) });
    const err = await startDocument(client, templateById("auth")!, { newId }).catch((e) => e);
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).docId).toBe("doc-9");
    expect((err as StartError).message).toBe("disk full");
  });

  it("if creation itself fails, the error has no id", async () => {
    const { client } = fakeClient({ createDocument: vi.fn(async () => { throw new Error("offline"); }) });
    const err = await startDocument(client, templateById("auth")!).catch((e) => e);
    expect((err as StartError).docId).toBeNull();
  });
});

describe("applyTemplate", () => {
  it("applies to an existing document with the given clientId", async () => {
    const { client, ops } = fakeClient();
    await applyTemplate(client, "doc-1", "page1", templateById("checkout")!, { clientId: "template", newId });
    expect(ops.every((o) => o.docId === "doc-1" && o.clientId === "template")).toBe(true);
  });
});
