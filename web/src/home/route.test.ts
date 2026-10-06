import { describe, expect, it } from "vitest";
import { docIdFromHash, legacyRedirect, normalizeDocId, parseJoinLink, pathForDoc, relativeTime, sortRecent } from "./route";

const ID = "0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";

describe("legacyRedirect", () => {
  it("#doc=<uuid> points to the editor path (even in uppercase: the id comes out lowercase)", () => {
    expect(legacyRedirect(`#doc=${ID}`)).toEqual({ to: "/doc/$docId", params: { docId: ID } });
    expect(legacyRedirect(`#doc=${ID.toUpperCase()}`)).toEqual({ to: "/doc/$docId", params: { docId: ID } });
  });
  it("#new points to the Home with the templates highlighted", () => {
    expect(legacyRedirect("#new")).toEqual({ to: "/", search: { templates: true } });
  });
  it("anything else is not a legacy link, never an editor on a strange id", () => {
    expect(legacyRedirect("")).toBeNull();
    expect(legacyRedirect("#")).toBeNull();
    expect(legacyRedirect("#doc=../../etc/passwd")).toBeNull();
    expect(legacyRedirect(`#doc=${ID}x`)).toBeNull();
    expect(legacyRedirect("#other")).toBeNull();
  });
});

describe("document ids", () => {
  it("normalizeDocId accepts a well-formed id (lowercased) and nothing else", () => {
    expect(normalizeDocId(ID.toUpperCase())).toBe(ID);
    expect(normalizeDocId("../../etc")).toBeNull();
    expect(normalizeDocId(`${ID}x`)).toBeNull();
  });
  it("pathForDoc builds the shared link path", () => {
    expect(pathForDoc(ID)).toBe(`/doc/${ID}`);
  });
  it("docIdFromHash reads the legacy hash", () => {
    expect(docIdFromHash(`#doc=${ID}`)).toBe(ID);
    expect(docIdFromHash("#doc=")).toBeNull();
  });
});

describe("parseJoinLink", () => {
  it("accepts the full link copied from Share", () => {
    expect(parseJoinLink(`http://192.168.1.5:8080/doc/${ID}`)).toBe(ID);
    expect(parseJoinLink(`  https://example.com/doc/${ID}?renderer=gpu  `)).toBe(ID);
  });
  it("still accepts an old link with its hash", () => {
    expect(parseJoinLink(`http://192.168.1.5:8080/#doc=${ID}`)).toBe(ID);
  });
  it("accepts just the path, the hash or the bare id", () => {
    expect(parseJoinLink(`/doc/${ID}`)).toBe(ID);
    expect(parseJoinLink(`#doc=${ID}`)).toBe(ID);
    expect(parseJoinLink(ID)).toBe(ID);
    expect(parseJoinLink(ID.toUpperCase())).toBe(ID);
  });
  it("rejects the rest", () => {
    expect(parseJoinLink("")).toBeNull();
    expect(parseJoinLink("   ")).toBeNull();
    expect(parseJoinLink("hello")).toBeNull();
    expect(parseJoinLink("http://host/#doc=not-a-uuid")).toBeNull();
    expect(parseJoinLink("http://host/doc/not-a-uuid")).toBeNull();
    // a UUID elsewhere in the path is not an invite: it needs its `/doc/` marker
    expect(parseJoinLink(`http://host/${ID}/page`)).toBeNull();
    // the id must follow the marker immediately
    expect(parseJoinLink(`http://host/doc/x${ID}`)).toBeNull();
    expect(parseJoinLink(`http://host/#doc=x${ID}`)).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const ago = (s: number) => Math.floor(now / 1000) - s;
  it("scales from now to days", () => {
    expect(relativeTime(ago(5), now)).toBe("now");
    expect(relativeTime(ago(5 * 60), now)).toBe("5 min ago");
    expect(relativeTime(ago(3600), now)).toBe("1 hour ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3 hours ago");
    expect(relativeTime(ago(30 * 3600), now)).toBe("yesterday");
    expect(relativeTime(ago(4 * 86400), now)).toBe("4 days ago");
  });
  it("beyond a week it shows the date; zero = unknown", () => {
    expect(relativeTime(ago(30 * 86400), now)).toMatch(/2026/);
    expect(relativeTime(0, now)).toBe("—");
  });
  it("a clock set back produces no negative times", () => {
    expect(relativeTime(ago(-500), now)).toBe("now");
  });
});

describe("sortRecent", () => {
  it("most recent first, ties by name", () => {
    const docs = [
      { id: "1", name: "Zeta", updatedAt: 10 },
      { id: "2", name: "Beta", updatedAt: 50 },
      { id: "3", name: "Alpha", updatedAt: 10 },
    ];
    expect(sortRecent(docs).map((d) => d.id)).toEqual(["2", "3", "1"]);
    // does not mutate the input
    expect(docs.map((d) => d.id)).toEqual(["1", "2", "3"]);
  });
  it("accepts bigint (as it arrives from the wire)", () => {
    expect(sortRecent([{ id: "a", name: "a", updatedAt: 1n }, { id: "b", name: "b", updatedAt: 2n }]).map((d) => d.id)).toEqual(["b", "a"]);
  });
});
