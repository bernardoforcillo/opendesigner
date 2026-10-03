import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, projectZip, shipCommands, shipScript, shq, zipName } from "./ship";
import { PREVIEW_MSG, previewDoc, resolvePreviewHref } from "./preview";
import type { CodeFile } from "./codegen";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string): CodeFile => ({ path, bytes: enc(text) });

describe("zipName", () => {
  it.each([
    ["Checkout", "react", "checkout-react.zip"],
    ["Negozio Città", "react", "negozio-citta-react.zip"],
    ["  ", "html", "design-html.zip"],
    ["Mio/doc: v2!", "react", "mio-doc-v2-react.zip"],
  ] as const)("%j (%s) -> %s", (name, target, want) => expect(zipName(name, target)).toBe(want));
});

describe("comandi da copiare", () => {
  it("shq mette le virgolette solo se servono e protegge gli apici", () => {
    expect(shq("checkout-react.zip")).toBe("checkout-react.zip");
    expect(shq("Negozio Città")).toBe("'Negozio Città'");
    expect(shq("l'uno")).toBe(`'l'\\''uno'`);
  });

  it("i quattro passi, nell'ordine: avvia, test e2e, check, coverage", () => {
    const steps = shipCommands("Negozio", "negozio-react.zip");
    expect(steps.map((s) => s.id)).toEqual(["run", "e2e", "check", "coverage"]);
    expect(steps[0].command).toBe("unzip negozio-react.zip -d negozio-react && cd negozio-react && npm i && npm run dev");
    expect(steps[1].command).toBe("npx playwright test");
    expect(steps[2].command).toBe("opendesigner flow check -doc Negozio");
    expect(steps[3].command).toBe("opendesigner flow coverage -doc Negozio -repo ./negozio-react");
  });

  it("un nome di documento con spazi finisce fra apici nei comandi della CLI", () => {
    const steps = shipCommands("Il mio negozio", zipName("Il mio negozio", "react"));
    expect(steps[2].command).toBe("opendesigner flow check -doc 'Il mio negozio'");
  });

  it("lo script ha un commento e un comando per passo", () => {
    const s = shipScript(shipCommands("A", "a-react.zip"));
    expect(s.split("\n\n")).toHaveLength(4);
    expect(s.startsWith("# Avvia l'app\nunzip a-react.zip")).toBe(true);
  });

  it("i tool MCP per gli agenti sono quelli documentati", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["get_flow_spec", "export_code", "analyze_flows"]);
  });
});

describe("projectZip", () => {
  it("è uno zip valido con tutti i file (firma PK, EOCD con il conteggio)", () => {
    const z = projectZip([file("a.txt", "1"), file("src/b.tsx", "22")]);
    expect(Array.from(z.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 22 + 10, true)).toBe(2);
  });
});

describe("anteprima", () => {
  const files = [
    file("index.html", '<html><body><a href="pagamento.html">Vai</a><img src="assets/ab.png"></body></html>'),
    file("pagamento.html", "<p>ciao</p>"),
    { path: "assets/ab.png", bytes: new Uint8Array([137, 80, 78, 71]) },
    file("assets/zz.png", "non usato"),
  ];

  it("riscrive le immagini come data URI e inietta l'intercettatore prima di </body>", () => {
    const doc = previewDoc(files, "index.html")!;
    expect(doc).toContain("data:image/png;base64,iVBORw==");
    expect(doc).not.toContain("assets/ab.png");
    expect(doc.indexOf(PREVIEW_MSG)).toBeGreaterThan(doc.indexOf("</a>"));
    expect(doc.indexOf(PREVIEW_MSG)).toBeLessThan(doc.indexOf("</body>"));
  });

  it("senza </body> accoda lo script; un file che non esiste dà null", () => {
    expect(previewDoc(files, "pagamento.html")!.endsWith("</script>")).toBe(true);
    expect(previewDoc(files, "no.html")).toBeNull();
  });

  it("gli href si risolvono sui file veri (senza ./, query, ancora); gli altri no", () => {
    expect(resolvePreviewHref(files, "pagamento.html")).toBe("pagamento.html");
    expect(resolvePreviewHref(files, "./pagamento.html?x=1#y")).toBe("pagamento.html");
    expect(resolvePreviewHref(files, "https://esempio.it")).toBeNull();
    expect(resolvePreviewHref(files, "manca.html")).toBeNull();
  });
});
