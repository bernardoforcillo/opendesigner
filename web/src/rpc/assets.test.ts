import { describe, it, expect, vi } from "vitest";
import { ASSET_PREFIX, assetUrl, isAssetHash, uploadAsset, uploadErrorMessage } from "./assets";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe("assetUrl", () => {
  it("è /assets-api/{doc}/{hash}", () => {
    expect(assetUrl("doc-1", HASH)).toBe(`${ASSET_PREFIX}/doc-1/${HASH}`);
  });

  it("il prefisso NON è /assets/ (là sotto ci sono i bundle di Vite)", () => {
    // `brawt serve` serve il frontend compilato dalla radice e Vite scrive i
    // propri file in dist/assets/: le due route si coprirebbero a vicenda.
    expect(ASSET_PREFIX).toBe("/assets-api");
  });

  it("codifica i segmenti: un id o un hash non possono FORMULARE un percorso", () => {
    expect(assetUrl("../altro", "a/b")).toBe(`${ASSET_PREFIX}/..%2Faltro/a%2Fb`);
  });
});

describe("isAssetHash", () => {
  it("accetta 64 esadecimali minuscoli e rifiuta tutto il resto", () => {
    expect(isAssetHash(HASH)).toBe(true);
    expect(isAssetHash(HASH.toUpperCase())).toBe(false);
    expect(isAssetHash(HASH.slice(1))).toBe(false);
    expect(isAssetHash(`${HASH}0`)).toBe(false);
    expect(isAssetHash("")).toBe(false);
    expect(isAssetHash("z".repeat(64))).toBe(false);
  });
});

describe("uploadAsset", () => {
  it("manda il file NUDO in POST sulla collezione del documento", async () => {
    const fetchFn = vi.fn(async () => okResponse({ hash: HASH, size: 12, contentType: "image/png" }));
    const file = new Blob(["bytes"], { type: "image/png" });

    const ref = await uploadAsset("doc-1", file, fetchFn as unknown as typeof fetch);

    expect(ref.hash).toBe(HASH);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ASSET_PREFIX}/doc-1`);
    expect(init.method).toBe("POST");
    // Niente multipart: un file per richiesta e nessun campo che lo accompagna,
    // quindi un involucro sarebbe un parser in più da entrambi i lati.
    expect(init.body).toBe(file);
  });

  it("un hash malformato nella risposta è un ERRORE, non un nodo rotto", async () => {
    // Quello che esce di qui finisce in un op, cioè nell'op-log: un hash
    // impossibile ci resterebbe per sempre, puntando a un asset che nessuna GET
    // potrà mai servire.
    const fetchFn = vi.fn(async () => okResponse({ hash: "nope" }));
    await expect(
      uploadAsset("doc-1", new Blob(["x"]), fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(/hash/);
  });

  it("una risposta senza hash è un errore", async () => {
    const fetchFn = vi.fn(async () => okResponse({}));
    await expect(
      uploadAsset("doc-1", new Blob(["x"]), fetchFn as unknown as typeof fetch),
    ).rejects.toThrow();
  });

  it("gli stati che il server produce davvero hanno un messaggio che dice cosa fare", async () => {
    for (const [status, fragment] of [
      [415, "formato"],
      [413, "grande"],
      [404, "documento"],
    ] as const) {
      const fetchFn = vi.fn(async () => errResponse(status));
      await expect(
        uploadAsset("doc-1", new Blob(["x"]), fetchFn as unknown as typeof fetch),
      ).rejects.toThrow(new RegExp(fragment));
    }
  });

  it("per uno stato imprevisto riporta il codice invece di un 'errore sconosciuto'", () => {
    expect(uploadErrorMessage(500)).toContain("500");
  });
});
