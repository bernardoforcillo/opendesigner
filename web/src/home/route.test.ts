import { describe, expect, it } from "vitest";
import { docIdFromHash, hashForDoc, parseJoinLink, relativeTime, routeFromHash, sortRecent } from "./route";

const ID = "0f8b1c3e-5a52-4c7d-9a1e-2b3c4d5e6f70";

describe("routeFromHash", () => {
  it("senza hash è la Home", () => {
    expect(routeFromHash("")).toEqual({ kind: "home", focusTemplates: false });
    expect(routeFromHash("#")).toEqual({ kind: "home", focusTemplates: false });
  });
  it("#new è la Home con i template in evidenza", () => {
    expect(routeFromHash("#new")).toEqual({ kind: "home", focusTemplates: true });
  });
  it("#doc=<uuid> apre l'editor (anche in maiuscolo: l'id esce in minuscolo)", () => {
    expect(routeFromHash(`#doc=${ID}`)).toEqual({ kind: "doc", id: ID });
    expect(routeFromHash(`#doc=${ID.toUpperCase()}`)).toEqual({ kind: "doc", id: ID });
  });
  it("un hash che non si riconosce vale Home, mai un editor su un id strano", () => {
    expect(routeFromHash("#doc=../../etc/passwd").kind).toBe("home");
    expect(routeFromHash(`#doc=${ID}x`).kind).toBe("home");
    expect(routeFromHash("#altro").kind).toBe("home");
  });
  it("hashForDoc e docIdFromHash sono uno l'inverso dell'altro", () => {
    expect(docIdFromHash(hashForDoc(ID))).toBe(ID);
  });
});

describe("parseJoinLink", () => {
  it("accetta il link intero copiato da Condividi", () => {
    expect(parseJoinLink(`http://192.168.1.5:8080/#doc=${ID}`)).toBe(ID);
    expect(parseJoinLink(`  https://example.com/app/#doc=${ID}  `)).toBe(ID);
  });
  it("accetta solo l'hash o l'id nudo", () => {
    expect(parseJoinLink(`#doc=${ID}`)).toBe(ID);
    expect(parseJoinLink(ID)).toBe(ID);
    expect(parseJoinLink(ID.toUpperCase())).toBe(ID);
  });
  it("rifiuta il resto", () => {
    expect(parseJoinLink("")).toBeNull();
    expect(parseJoinLink("   ")).toBeNull();
    expect(parseJoinLink("ciao")).toBeNull();
    expect(parseJoinLink("http://host/#doc=non-un-uuid")).toBeNull();
    // un UUID nel percorso non è un invito: serve il suo `#doc=`
    expect(parseJoinLink(`http://host/${ID}/pagina`)).toBeNull();
    // l'id deve seguire subito il marcatore
    expect(parseJoinLink(`http://host/#doc=x${ID}`)).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const ago = (s: number) => Math.floor(now / 1000) - s;
  it("scala da adesso ai giorni", () => {
    expect(relativeTime(ago(5), now)).toBe("adesso");
    expect(relativeTime(ago(5 * 60), now)).toBe("5 min fa");
    expect(relativeTime(ago(3600), now)).toBe("1 ora fa");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3 ore fa");
    expect(relativeTime(ago(30 * 3600), now)).toBe("ieri");
    expect(relativeTime(ago(4 * 86400), now)).toBe("4 giorni fa");
  });
  it("oltre una settimana mostra la data; zero = sconosciuto", () => {
    expect(relativeTime(ago(30 * 86400), now)).toMatch(/2026/);
    expect(relativeTime(0, now)).toBe("—");
  });
  it("un orologio indietro non produce tempi negativi", () => {
    expect(relativeTime(ago(-500), now)).toBe("adesso");
  });
});

describe("sortRecent", () => {
  it("i più recenti per primi, a parità per nome", () => {
    const docs = [
      { id: "1", name: "Zeta", updatedAt: 10 },
      { id: "2", name: "Beta", updatedAt: 50 },
      { id: "3", name: "Alfa", updatedAt: 10 },
    ];
    expect(sortRecent(docs).map((d) => d.id)).toEqual(["2", "3", "1"]);
    // non muta l'ingresso
    expect(docs.map((d) => d.id)).toEqual(["1", "2", "3"]);
  });
  it("accetta bigint (come arriva dal filo)", () => {
    expect(sortRecent([{ id: "a", name: "a", updatedAt: 1n }, { id: "b", name: "b", updatedAt: 2n }]).map((d) => d.id)).toEqual(["b", "a"]);
  });
});
