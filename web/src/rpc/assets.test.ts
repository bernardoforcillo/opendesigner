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
  it("is /assets-api/{doc}/{hash}", () => {
    expect(assetUrl("doc-1", HASH)).toBe(`${ASSET_PREFIX}/doc-1/${HASH}`);
  });

  it("the prefix is NOT /assets/ (the Vite bundles live there)", () => {
    // `opendesigner serve` serves the compiled frontend from the root and Vite writes its
    // own files in dist/assets/: the two routes would cover each other.
    expect(ASSET_PREFIX).toBe("/assets-api");
  });

  it("encodes the segments: an id or a hash cannot FORMULATE a path", () => {
    expect(assetUrl("../altro", "a/b")).toBe(`${ASSET_PREFIX}/..%2Faltro/a%2Fb`);
  });
});

describe("isAssetHash", () => {
  it("accepts 64 lowercase hex digits and rejects everything else", () => {
    expect(isAssetHash(HASH)).toBe(true);
    expect(isAssetHash(HASH.toUpperCase())).toBe(false);
    expect(isAssetHash(HASH.slice(1))).toBe(false);
    expect(isAssetHash(`${HASH}0`)).toBe(false);
    expect(isAssetHash("")).toBe(false);
    expect(isAssetHash("z".repeat(64))).toBe(false);
  });
});

describe("uploadAsset", () => {
  it("sends the BARE file via POST to the document's collection", async () => {
    const fetchFn = vi.fn(async () => okResponse({ hash: HASH, size: 12, contentType: "image/png" }));
    const file = new Blob(["bytes"], { type: "image/png" });

    const ref = await uploadAsset("doc-1", file, fetchFn as unknown as typeof fetch);

    expect(ref.hash).toBe(HASH);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ASSET_PREFIX}/doc-1`);
    expect(init.method).toBe("POST");
    // No multipart: one file per request and no fields accompanying it,
    // so an envelope would be one more parser on both sides.
    expect(init.body).toBe(file);
  });

  it("a malformed hash in the response is an ERROR, not a broken node", async () => {
    // What comes out of here ends up in an op, that is in the op-log: an
    // impossible hash would stay there forever, pointing to an asset that no GET
    // could ever serve.
    const fetchFn = vi.fn(async () => okResponse({ hash: "nope" }));
    await expect(
      uploadAsset("doc-1", new Blob(["x"]), fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(/hash/);
  });

  it("a response without a hash is an error", async () => {
    const fetchFn = vi.fn(async () => okResponse({}));
    await expect(
      uploadAsset("doc-1", new Blob(["x"]), fetchFn as unknown as typeof fetch),
    ).rejects.toThrow();
  });

  it("the statuses the server really produces have a message that says what to do", async () => {
    for (const [status, fragment] of [
      [415, "format"],
      [413, "large"],
      [404, "document"],
    ] as const) {
      const fetchFn = vi.fn(async () => errResponse(status));
      await expect(
        uploadAsset("doc-1", new Blob(["x"]), fetchFn as unknown as typeof fetch),
      ).rejects.toThrow(new RegExp(fragment));
    }
  });

  it("for an unexpected status it reports the code instead of an 'unknown error'", () => {
    expect(uploadErrorMessage(500)).toContain("500");
  });
});
