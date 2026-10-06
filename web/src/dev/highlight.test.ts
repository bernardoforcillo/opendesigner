import { describe, it, expect } from "vitest";
import { highlight, langOf, type Lang, type TokenKind } from "./highlight";

const flat = (lines: ReturnType<typeof highlight>) => lines.map((l) => l.map((t) => t.s).join("")).join("\n");
const kinds = (code: string, lang: Lang, k: TokenKind) =>
  highlight(code, lang).flat().filter((t) => t.k === k).map((t) => t.s);

describe("langOf", () => {
  it.each([
    ["src/App.tsx", "tsx"], ["vite.config.ts", "tsx"], ["index.html", "html"], ["src/index.css", "css"],
    ["package.json", "json"], ["README.md", "md"], ["Makefile", "text"], ["a.PNG", "text"],
  ])("%s -> %s", (p, l) => expect(langOf(p)).toBe(l));
});

describe("highlight: tsx", () => {
  const code = [
    "// File generato",
    'import { useNavigate } from "react-router-dom";',
    "export default function Login() {",
    "  const navigate = useNavigate();",
    "  return (",
    '    <div data-node-id="1:2" className="relative w-[300px]" onClick={() => navigate("/home")}>',
    "      <Pulsante />",
    "    </div>",
    "  );",
    "}",
  ].join("\n");

  it("recognizes comments, keywords, strings, tags, attributes, functions, numbers", () => {
    expect(kinds(code, "tsx", "com")).toEqual(["// File generato"]);
    expect(kinds(code, "tsx", "kw")).toEqual(expect.arrayContaining(["import", "from", "export", "default", "function", "const", "return"]));
    expect(kinds(code, "tsx", "str")).toEqual(expect.arrayContaining(['"react-router-dom"', '"1:2"', '"/home"']));
    expect(kinds(code, "tsx", "tag")).toEqual(expect.arrayContaining(["div", "Pulsante"]));
    expect(kinds(code, "tsx", "attr")).toEqual(expect.arrayContaining(["data-node-id", "className", "onClick"]));
    expect(kinds(code, "tsx", "fn")).toEqual(expect.arrayContaining(["Login", "useNavigate", "navigate"]));
  });

  it("'a < b' and generics are not tags", () => {
    expect(kinds("if (a < b) {}", "tsx", "tag")).toEqual([]);
    expect(kinds("const x: Array<string> = []", "tsx", "tag")).toEqual([]);
    expect(kinds("const n = 3 + 0.5", "tsx", "num")).toEqual(["3", "0.5"]);
  });

  it("block comments and template literals span several lines, staying one token per line", () => {
    const lines = highlight("/* a\n b */ let x = `q\nr`;", "tsx");
    expect(lines).toHaveLength(3);
    expect(lines[0][0]).toEqual({ k: "com", s: "/* a" });
    expect(lines[1][0]).toEqual({ k: "com", s: " b */" });
    expect(lines[2][0]).toEqual({ k: "str", s: "r`" });
  });
});

describe("highlight: html / css / json / md", () => {
  it("html: tags, attributes, strings, comments, doctype; <style> is CSS", () => {
    const html = '<!doctype html>\n<!-- nota -->\n<html><head><style>\n.a-1 { color: #ff0000; width: 10px }\n</style></head><body><a href="x.html" class="b">Ciao</a></body></html>';
    expect(kinds(html, "html", "com")).toEqual(["<!-- nota -->"]);
    expect(kinds(html, "html", "kw")).toEqual(["<!doctype html>"]);
    expect(kinds(html, "html", "tag")).toEqual(expect.arrayContaining(["html", "a", ".a-1"]));
    expect(kinds(html, "html", "attr")).toEqual(expect.arrayContaining(["href", "class", "color", "width"]));
    expect(kinds(html, "html", "str")).toEqual(expect.arrayContaining(['"x.html"', '"b"']));
    expect(kinds(html, "html", "num")).toEqual(expect.arrayContaining(["#ff0000", "10px"]));
  });

  it("css: at-rule as keyword, comment, string", () => {
    const css = '@import "tailwindcss";\n/* x */\nbody { font-family: "Inter", sans-serif }';
    expect(kinds(css, "css", "kw")).toEqual(["@import"]);
    expect(kinds(css, "css", "com")).toEqual(["/* x */"]);
    expect(kinds(css, "css", "str")).toEqual(['"tailwindcss"', '"Inter"']);
  });

  it("json: keys as attributes, values as strings, numbers and booleans", () => {
    const j = '{ "name": "app", "n": 12, "ok": true }';
    expect(kinds(j, "json", "attr")).toEqual(['"name"', '"n"', '"ok"']);
    expect(kinds(j, "json", "str")).toEqual(['"app"']);
    expect(kinds(j, "json", "num")).toEqual(["12"]);
    expect(kinds(j, "json", "kw")).toEqual(["true"]);
  });

  it("md: titoli e codice in linea", () => {
    expect(kinds("# Titolo\ntesto `npm i` fine", "md", "kw")).toEqual(["# Titolo\n"].map((s) => s.trimEnd()));
    expect(kinds("tocca `npm i` ora", "md", "str")).toEqual(["`npm i`"]);
  });
});

describe("highlight: invariant", () => {
  // Whatever happens, the concatenated tokens give back the source: a
  // wrong recognition colors badly, it does not lose text.
  const samples: [Lang, string][] = [
    ["tsx", "const a = <T,>(x: T) => x; <div a='1' b={{c:1}}>{x < 3 ? <i/> : null}</div> // end"],
    ["tsx", "'unclosed\nsecond \\' line `tpl ${a} \n more lines` /* never closed"],
    ["tsx", ""],
    ["html", "<div class='a' <span>>< ><!-- unclosed"],
    ["html", "<style>a{b:c</style><script>let x = '<';</script> text & more"],
    ["css", "a{b:c;;} } } /* x */ 'k\n@media (x){.y{z:#abc}}"],
    ["json", '{"a": [1, 2.5e-3, -4, null, "x\\"y"], "b": {}'],
    ["md", "# t\n```\ncode\n```\n`a` `b\n"],
    ["text", "whatever\r\nthing"],
    ["tsx", "é ü 日本語 \u{1F600} <b>x</b>"],
  ];
  it.each(samples)("%s #%#", (lang, src) => {
    expect(flat(highlight(src, lang))).toBe(src);
  });

  it("even on a large generated file, in a reasonable time", () => {
    const line = '      <div data-node-id="n1" className="absolute left-[10px] top-[4px]">Testo</div>\n';
    const src = line.repeat(20000);
    const t0 = performance.now();
    const out = highlight(src, "tsx");
    expect(out).toHaveLength(20001);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
