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
  it("Vuoto crea il documento e non manda nessun op", async () => {
    const { client, ops } = fakeClient();
    const id = await startDocument(client, templateById("blank")!);
    expect(id).toBe("doc-9");
    expect(client.createDocument).toHaveBeenCalledWith({ name: "Senza titolo" });
    expect(ops).toHaveLength(0);
    expect(client.openDocument).not.toHaveBeenCalled();
  });

  it("un template manda gli op in ordine, tutti per il documento creato, e riporta l'avanzamento", async () => {
    const { client, ops } = fakeClient();
    const progress: number[] = [];
    const id = await startDocument(client, templateById("onboarding")!, { newId, onProgress: (d) => progress.push(d) });
    expect(id).toBe("doc-9");
    expect(ops.length).toBeGreaterThan(20);
    expect(ops.every((o) => o.docId === "doc-9" && o.op.docId === "doc-9")).toBe(true);
    expect(progress).toEqual(ops.map((_, i) => i + 1));
    // gli op, applicati in quell'ordine a una scena vuota, danno il template
    const scene = ops.reduce((s, o) => applyOp(s, o.op), emptyScene("doc-9", "x"));
    expect(topLevelScreens(scene, "page1")).toHaveLength(3);
    expect(Object.keys(scene.flows)).toHaveLength(1);
  });

  it("usa l'id della prima pagina del documento, non un 'page1' scolpito", async () => {
    const { client, ops } = fakeClient({ openDocument: vi.fn(async () => ({ snapshot: { pages: [{ id: "pagina-x" }] } })) });
    await startDocument(client, templateById("saas")!, { newId });
    const firstCreate = ops[0].op.kind;
    expect(firstCreate.case === "createNode" && firstCreate.value.node?.parentId).toBe("pagina-x");
  });

  it("se un op fallisce l'errore porta l'id del documento già creato", async () => {
    let calls = 0;
    const { client } = fakeClient({ submitOp: vi.fn(async () => { if (++calls === 3) throw new Error("disco pieno"); }) });
    const err = await startDocument(client, templateById("auth")!, { newId }).catch((e) => e);
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).docId).toBe("doc-9");
    expect((err as StartError).message).toBe("disco pieno");
  });

  it("se non si riesce nemmeno a creare, l'errore non ha id", async () => {
    const { client } = fakeClient({ createDocument: vi.fn(async () => { throw new Error("offline"); }) });
    const err = await startDocument(client, templateById("auth")!).catch((e) => e);
    expect((err as StartError).docId).toBeNull();
  });
});

describe("applyTemplate", () => {
  it("applica a un documento esistente con il clientId dato", async () => {
    const { client, ops } = fakeClient();
    await applyTemplate(client, "doc-1", "page1", templateById("checkout")!, { clientId: "template", newId });
    expect(ops.every((o) => o.docId === "doc-1" && o.clientId === "template")).toBe(true);
  });
});
