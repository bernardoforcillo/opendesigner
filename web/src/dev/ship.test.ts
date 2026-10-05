import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, projectZip, shipCommands, shipScript, shq, zipName } from "./ship";
import { PREVIEW_MSG, previewDoc, resolvePreviewHref } from "./preview";
import type { CodeFile } from "./codegen";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string): CodeFile => ({ path, bytes: enc(text) });

describe("zipName", () => {
  it.each([
    ["Checkout", "react", "checkout-react.zip"],
    ["Shop Café", "react", "shop-cafe-react.zip"],
    ["  ", "html", "design-html.zip"],
    ["My/doc: v2!", "react", "my-doc-v2-react.zip"],
  ] as const)("%j (%s) -> %s", (name, target, want) => expect(zipName(name, target)).toBe(want));
});

describe("commands to copy", () => {
  it("shq adds quotes only when needed and protects apostrophes", () => {
    expect(shq("checkout-react.zip")).toBe("checkout-react.zip");
    expect(shq("Shop Café")).toBe("'Shop Café'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  it("i quattro passi, nell'ordine: avvia, test e2e, check, coverage", () => {
    const steps = shipCommands("Shop", "shop-react.zip");
    expect(steps.map((s) => s.id)).toEqual(["run", "e2e", "check", "coverage"]);
    expect(steps[0].command).toBe("unzip shop-react.zip -d shop-react && cd shop-react && npm i && npm run dev");
    expect(steps[1].command).toBe("npx playwright test");
    expect(steps[2].command).toBe("opendesigner flow check -doc Shop");
    expect(steps[3].command).toBe("opendesigner flow coverage -doc Shop -repo ./shop-react");
  });

  it("a document name with spaces ends up in quotes in the CLI commands", () => {
    const steps = shipCommands("My shop", zipName("My shop", "react"));
    expect(steps[2].command).toBe("opendesigner flow check -doc 'My shop'");
  });

  it("the script has a comment and a command per step", () => {
    const s = shipScript(shipCommands("A", "a-react.zip"));
    expect(s.split("\n\n")).toHaveLength(4);
    expect(s.startsWith("# Start the app\nunzip a-react.zip")).toBe(true);
  });

  it("the MCP tools for agents are the documented ones", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["get_flow_spec", "export_code", "analyze_flows"]);
  });
});

describe("projectZip", () => {
  it("it is a valid zip with all the files (PK signature, EOCD with the count)", () => {
    const z = projectZip([file("a.txt", "1"), file("src/b.tsx", "22")]);
    expect(Array.from(z.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 22 + 10, true)).toBe(2);
  });
});

describe("preview", () => {
  const files = [
    file("index.html", '<html><body><a href="pagamento.html">Vai</a><img src="assets/ab.png"></body></html>'),
    file("pagamento.html", "<p>ciao</p>"),
    { path: "assets/ab.png", bytes: new Uint8Array([137, 80, 78, 71]) },
    file("assets/zz.png", "unused"),
  ];

  it("rewrites images as data URIs and injects the interceptor before </body>", () => {
    const doc = previewDoc(files, "index.html")!;
    expect(doc).toContain("data:image/png;base64,iVBORw==");
    expect(doc).not.toContain("assets/ab.png");
    expect(doc.indexOf(PREVIEW_MSG)).toBeGreaterThan(doc.indexOf("</a>"));
    expect(doc.indexOf(PREVIEW_MSG)).toBeLessThan(doc.indexOf("</body>"));
  });

  it("without </body> it appends the script; a file that does not exist gives null", () => {
    expect(previewDoc(files, "pagamento.html")!.endsWith("</script>")).toBe(true);
    expect(previewDoc(files, "no.html")).toBeNull();
  });

  it("hrefs resolve onto the real files (without ./, query, anchor); the others do not", () => {
    expect(resolvePreviewHref(files, "pagamento.html")).toBe("pagamento.html");
    expect(resolvePreviewHref(files, "./pagamento.html?x=1#y")).toBe("pagamento.html");
    expect(resolvePreviewHref(files, "https://example.com")).toBeNull();
    expect(resolvePreviewHref(files, "manca.html")).toBeNull();
  });
});
