import { describe, it, expect } from "vitest";
import { computeStyle, declaredProps, parseCss, parseDeclarations, specificityOf, splitTopLevel } from "./styles";

function el(xml: string): Element {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${xml}</svg>`, "image/svg+xml");
  return doc.documentElement.firstElementChild as Element;
}

describe("splitTopLevel / parseDeclarations", () => {
  it("does not split inside parentheses and quotes", () => {
    expect(splitTopLevel("a:b;c:url(data:image/png;base64,AAA);d:'x;y'", ";")).toEqual([
      "a:b", "c:url(data:image/png;base64,AAA)", "d:'x;y'",
    ]);
  });
  it("declarations, comments, !important, uppercase and values with colons", () => {
    expect(parseDeclarations("Fill: #F00 ; /* c */ stroke : none !important; broken; :x; a: b:c")).toEqual([
      { name: "fill", value: "#F00", important: false },
      { name: "stroke", value: "none", important: true },
      { name: "a", value: "b:c", important: false },
    ]);
  });
});

describe("parseCss", () => {
  it("rules with selector lists and multiple declarations", () => {
    const { rules, atRules } = parseCss(".a, .b { fill: red; stroke: blue } rect { opacity: .5 }");
    expect(rules.map((r) => r.selector)).toEqual([".a", ".b", "rect"]);
    expect(rules[0].decls.map((d) => d.name)).toEqual(["fill", "stroke"]);
    expect(atRules).toEqual([]);
  });
  it("skips at-rules (even nested) and reports them", () => {
    const { rules, atRules } = parseCss(
      "@import url(x.css); @keyframes k { from { fill: red } to { fill: blue } } .a { fill: green } @media print { .a { fill: black } }",
    );
    expect(rules.map((r) => r.selector)).toEqual([".a"]);
    expect(atRules).toContain("@keyframes");
    expect(atRules).toContain("@media");
    expect(atRules).toContain("@import");
  });
  it("commenti e CDATA", () => {
    const { rules } = parseCss("<![CDATA[ /* x */ .a { fill: red } ]]>");
    expect(rules.length).toBe(1);
  });
  it("specificity: id > class > tag", () => {
    expect(specificityOf("#a")).toBeGreaterThan(specificityOf(".a.b"));
    expect(specificityOf(".a")).toBeGreaterThan(specificityOf("rect"));
    expect(specificityOf("g rect")).toBe(2);
    expect(specificityOf("rect.a")).toBe(101);
  });
});

describe("declaredProps / computeStyle: the cascade", () => {
  it("presentation attribute < CSS rule < inline style < !important", () => {
    const e = el(`<rect fill="red" style="fill:blue"/>`);
    expect(declaredProps(e, [{ name: "fill", value: "green", important: false }]).get("fill")).toBe("blue");
    const e2 = el(`<rect fill="red"/>`);
    expect(declaredProps(e2, [{ name: "fill", value: "green", important: false }]).get("fill")).toBe("green");
    expect(declaredProps(e2, undefined).get("fill")).toBe("red");
    const e3 = el(`<rect style="fill:blue"/>`);
    expect(declaredProps(e3, [{ name: "fill", value: "green", important: true }]).get("fill")).toBe("green");
  });

  it("reads only known presentation properties", () => {
    const p = declaredProps(el(`<rect x="3" data-x="1" fill="red" class="a"/>`), undefined);
    expect([...p.keys()]).toEqual(["fill"]);
  });

  it("inherits fill/stroke/font but NOT opacity/display/transform", () => {
    const parent = declaredProps(el(`<g fill="red" stroke="blue" opacity="0.5" display="none" transform="scale(2)" font-size="20"/>`), undefined);
    const ps = computeStyle(parent, null);
    const child = computeStyle(declaredProps(el(`<rect/>`), undefined), ps);
    expect(child.get("fill")).toBe("red");
    expect(child.get("stroke")).toBe("blue");
    expect(child.get("font-size")).toBe("20");
    expect(child.get("opacity")).toBeUndefined();
    expect(child.get("display")).toBeUndefined();
    expect(child.get("transform")).toBeUndefined();
  });

  it("inherit takes the parent's value, even for non-inherited properties", () => {
    const ps = computeStyle(declaredProps(el(`<g opacity="0.3" fill="red"/>`), undefined), null);
    const c = computeStyle(declaredProps(el(`<rect opacity="inherit" fill="inherit"/>`), undefined), ps);
    expect(c.get("opacity")).toBe("0.3");
    expect(c.get("fill")).toBe("red");
  });
});
