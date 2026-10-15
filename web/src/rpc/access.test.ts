import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeToken, canComment, canWrite, captureLinkToken, setActiveDoc, shareUrl, storeToken, storedToken, tokenFor } from "./access";
import { assetUrl, uploadAsset } from "./assets";

beforeEach(() => { localStorage.clear(); setActiveDoc(""); });
afterEach(() => vi.restoreAllMocks());

function fakeLocation(search: string, pathname = "/doc/d1"): { loc: Location; hist: History; replaced: string[] } {
  const replaced: string[] = [];
  return {
    loc: { search, pathname, hash: "" } as Location,
    hist: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) } as unknown as History,
    replaced,
  };
}

describe("link tokens", () => {
  it("takes ?k= from the address, keeps it for the document and removes it from the URL", () => {
    const { loc, hist, replaced } = fakeLocation("?k=secret&x=1");
    expect(captureLinkToken("d1", loc, hist)).toBe("secret");
    expect(replaced).toEqual(["/doc/d1?x=1"]);
    expect(storedToken("d1")).toBe("secret");
    expect(activeToken()).toBe("secret");
  });

  it("remembers the token on the next visit, and a token is only for its own document", () => {
    storeToken("d1", "t1");
    storeToken("d2", "t2");
    expect(captureLinkToken("d1", fakeLocation("").loc, fakeLocation("").hist)).toBe("t1");
    expect(tokenFor("d1")).toBe("t1");
    expect(tokenFor("d2")).toBe("t2");
    expect(tokenFor("nope")).toBe("");
    storeToken("d1", "");
    expect(storedToken("d1")).toBe("");
  });

  it("builds a share URL", () => {
    expect(shareUrl("d1", "a b", "https://x.test")).toBe("https://x.test/doc/d1?k=a%20b");
  });

  it("puts the token on image URLs and uploads, and not when there is none", async () => {
    expect(assetUrl("d1", "h")).toBe("/assets-api/d1/h");
    storeToken("d1", "tok");
    expect(assetUrl("d1", "h")).toBe("/assets-api/d1/h?k=tok");
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hash: "a".repeat(64), size: 1, contentType: "image/png" }) });
    await uploadAsset("d1", new Blob(["x"], { type: "image/png" }), fetchFn as unknown as typeof fetch);
    expect(fetchFn.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "image/png" });
  });
});

describe("roles", () => {
  it("who may write and comment", () => {
    for (const r of [null, "open", "owner", "edit"] as const) expect(canWrite(r)).toBe(true);
    expect(canWrite("comment")).toBe(false);
    expect(canWrite("view")).toBe(false);
    expect(canComment("comment")).toBe(true);
    expect(canComment("view")).toBe(false);
  });
});
