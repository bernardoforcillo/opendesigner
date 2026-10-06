import { describe, it, expect } from "vitest";
import { nodesToSvg } from "./svg";
import type { NodeLite, TextStyleLite } from "../store/types";

// FAKE and deterministic measure: 10 units per character. It is the only way to
// test the generator as a pure function -- measuring glyphs for real
// would require a canvas, and the result would change from font to font.
const measure = (s: string) => s.length * 10;

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}

function style(over: Partial<TextStyleLite> = {}): TextStyleLite {
  return { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left", ...over };
}

function text(over: Partial<NodeLite> & { id: string }, content: string, s = style()): NodeLite {
  return node({ kind: "text", width: 100, height: 40, text: { content, style: s }, ...over });
}

const FULL = { x: 0, y: 0, width: 100, height: 100 };

describe("nodesToSvg — the document", () => {
  it("root: xmlns, dimensions and viewBox taken from the REGION", () => {
    const svg = nodesToSvg([node({ id: "a" })], { x: 10, y: 20, width: 300, height: 150 }, measure);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="150"');
    // The viewBox carries the region's ORIGIN: the nodes' coordinates stay
    // the model's, no translation baked in.
    expect(svg).toContain('viewBox="10 20 300 150"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("coordinates are the WORLD's, not the screen's", () => {
    // No camera parameter exists in this signature: that is the point. A node at
    // (250, 400) is written 250, 400 however the view was set.
    const svg = nodesToSvg(
      [node({ id: "a", x: 250, y: 400, width: 20, height: 30 })],
      { x: 250, y: 400, width: 20, height: 30 },
      measure,
    );
    expect(svg).toContain('<rect x="250" y="400" width="20" height="30"');
  });

  it("keeps the draw order: the first node is the first element", () => {
    const svg = nodesToSvg(
      [node({ id: "below" }), node({ id: "above", kind: "ellipse" })],
      FULL, measure,
    );
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<ellipse"));
  });

  it("a region without nodes stays a valid, empty SVG document", () => {
    const svg = nodesToSvg([], FULL, measure);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<rect");
  });
});

describe("nodesToSvg — shapes", () => {
  it("rectangle", () => {
    const svg = nodesToSvg([node({ id: "a", x: 1, y: 2, width: 30, height: 40 })], FULL, measure);
    expect(svg).toContain('<rect x="1" y="2" width="30" height="40" fill="rgb(0,0,0)"/>');
  });

  it("rounded rectangle: rx from the corner radius", () => {
    const svg = nodesToSvg(
      [node({ id: "a", width: 40, height: 40, cornerRadius: 8 })], FULL, measure,
    );
    expect(svg).toContain('rx="8"');
  });

  it("the radius is CLAMPED to half the shorter side, as roundRect does", () => {
    // Without the clamp the two renderers would draw different shapes from the
    // same model: the canvas reduces radii that are too large, the raw SVG does not
    // (it depends on the viewer).
    const svg = nodesToSvg(
      [node({ id: "a", width: 40, height: 20, cornerRadius: 999 })], FULL, measure,
    );
    expect(svg).toContain('rx="10"');
  });

  it("no rx when the radius is zero", () => {
    const svg = nodesToSvg([node({ id: "a" })], FULL, measure);
    expect(svg).not.toContain("rx=");
  });

  it("ellipse: center and semi-axes, not a rectangle", () => {
    const svg = nodesToSvg(
      [node({ id: "a", kind: "ellipse", x: 10, y: 20, width: 100, height: 50 })], FULL, measure,
    );
    expect(svg).toContain('<ellipse cx="60" cy="45" rx="50" ry="25" fill="rgb(0,0,0)"/>');
    expect(svg).not.toContain("<rect");
  });
});

describe("nodesToSvg — color and opacity", () => {
  it("the tint becomes rgb() with channels out of 255", () => {
    const svg = nodesToSvg(
      [node({ id: "a", fills: [{ r: 1, g: 0.5, b: 0, a: 1 }] })], FULL, measure,
    );
    expect(svg).toContain('fill="rgb(255,128,0)"');
  });

  it("a node without tints takes the SAME default gray as the canvas", () => {
    const svg = nodesToSvg([node({ id: "a", fills: [] })], FULL, measure);
    expect(svg).toContain('fill="rgb(204,204,204)"'); // 0.8 * 255
  });

  it("the tint's alpha becomes fill-opacity, the node's opacity becomes opacity", () => {
    const svg = nodesToSvg(
      [node({ id: "a", opacity: 0.5, fills: [{ r: 0, g: 0, b: 0, a: 0.25 }] })], FULL, measure,
    );
    expect(svg).toContain('fill-opacity="0.25"');
    expect(svg).toContain('opacity="0.5"');
  });

  it("opacity attributes are omitted when they are 1", () => {
    const svg = nodesToSvg([node({ id: "a" })], FULL, measure);
    expect(svg).not.toContain("opacity");
  });
});

describe("nodesToSvg — text", () => {
  it("comes out as a REAL <text>, not as a path", () => {
    const svg = nodesToSvg([text({ id: "t", x: 10, y: 20 }, "ciao")], FULL, measure);
    expect(svg).toContain("<text");
    expect(svg).toContain(">ciao<");
    expect(svg).not.toContain("<path");
  });

  it("carries family, size and weight RESOLVED from the renderer's defaults", () => {
    const svg = nodesToSvg([text({ id: "t" }, "ciao")], FULL, measure);
    expect(svg).toContain('font-family="Inter, sans-serif"');
    expect(svg).toContain('font-size="16"');
    expect(svg).toContain('font-weight="400"');
  });

  it("an explicit style wins over the defaults", () => {
    const svg = nodesToSvg(
      [text({ id: "t" }, "ciao", style({ fontFamily: "Georgia", fontSize: 32, fontWeight: "700" }))],
      FULL, measure,
    );
    expect(svg).toContain('font-family="Georgia"');
    expect(svg).toContain('font-size="32"');
    expect(svg).toContain('font-weight="700"');
  });

  it("one line per tspan, positioned as the canvas positions it", () => {
    // width 100 and 10 units per character: "abcdefghij klm" wraps.
    const svg = nodesToSvg([text({ id: "t", x: 10, y: 20 }, "abcdefghij klm")], FULL, measure);
    // ascent = (19.2-16)/2 + 16*0.8 = 14.4 ; lineHeight = 19.2
    expect(svg).toContain('<tspan x="10" y="34.4">abcdefghij</tspan>');
    expect(svg).toContain('<tspan x="10" y="53.6">klm</tspan>');
  });

  it("tspans are ATTACHED: no whitespace between them", () => {
    // With xml:space="preserve" even a newline between two tspans becomes a
    // drawn space: the exported text would have indents that the canvas does not
    // have.
    const svg = nodesToSvg([text({ id: "t" }, "abcdefghij klm")], FULL, measure);
    expect(svg).toContain("</tspan><tspan");
    expect(svg).not.toMatch(/<\/tspan>\s+<tspan/);
  });

  it("xml:space=preserve, so leading spaces stay where they are", () => {
    const svg = nodesToSvg([text({ id: "t" }, "  ciao")], FULL, measure);
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain(">  ciao<");
  });

  it("right and center alignment: shifts the line's x", () => {
    const right = nodesToSvg(
      [text({ id: "t", x: 0, width: 100 }, "ciao", style({ align: "right" }))], FULL, measure,
    );
    expect(right).toContain('<tspan x="60"'); // 100 - 4*10
    const center = nodesToSvg(
      [text({ id: "t", x: 0, width: 100 }, "ciao", style({ align: "center" }))], FULL, measure,
    );
    expect(center).toContain('<tspan x="30"'); // (100 - 40) / 2
  });

  it("an EMPTY text produces no element (as the canvas draws nothing)", () => {
    const svg = nodesToSvg([text({ id: "t" }, "")], FULL, measure);
    expect(svg).not.toContain("<text");
  });

  it("an empty line is not drawn but takes its place", () => {
    const svg = nodesToSvg([text({ id: "t", x: 0, y: 0 }, "a\n\nb")], FULL, measure);
    expect(svg).toContain('<tspan x="0" y="14.4">a</tspan>');
    // "b" is the THIRD line: y = ascent + 2 * lineHeight = 14.4 + 38.4
    expect(svg).toContain('<tspan x="0" y="52.8">b</tspan>');
    expect(svg).not.toContain("<tspan></tspan>");
  });

  it("the content gets ESCAPED: &, < and > do not break the document", () => {
    const svg = nodesToSvg([text({ id: "t", width: 1000 }, 'a & b < c > "d"')], FULL, measure);
    expect(svg).toContain("a &amp; b &lt; c &gt; &quot;d&quot;");
    expect(svg).not.toContain("b < c");
  });

  it("the font family is escaped too (it ends up in an attribute)", () => {
    const svg = nodesToSvg(
      [text({ id: "t" }, "x", style({ fontFamily: '"Comic" & co' }))], FULL, measure,
    );
    expect(svg).toContain('font-family="&quot;Comic&quot; &amp; co"');
  });
});

describe("nodesToSvg — numbers", () => {
  it("no floating-point tails", () => {
    const svg = nodesToSvg(
      [node({ id: "a", x: 0.1 + 0.2, width: 1 / 3 })],
      { x: 0, y: 0, width: 1 / 3, height: 1 },
      measure,
    );
    expect(svg).toContain('x="0.3"');
    expect(svg).toContain('width="0.333"');
    expect(svg).not.toContain("0.30000000000000004");
  });

  it("a negative zero is written 0", () => {
    const svg = nodesToSvg([node({ id: "a", x: -0 })], FULL, measure);
    expect(svg).toContain('x="0"');
    expect(svg).not.toContain('x="-0"');
  });
});

// --- images (track 3) --------------------------------------------------------
//
// Before this round an image node fell into `element()`'s fallback branch and
// came out as a GRAY <rect>: a file that does not show what the
// canvas shows, and without a single warning. The two possible outcomes are now
// both explicit -- the image, or the placeholder.

function image(over: Partial<NodeLite> & { id: string }): NodeLite {
  return node({ kind: "image", width: 200, height: 100, image: { assetHash: "abc" }, ...over });
}

describe("nodesToSvg — images", () => {
  it("writes an <image> with the resolved href and the node's box", () => {
    const svg = nodesToSvg([image({ id: "i", x: 10, y: 20 })], FULL, measure, () => "data:image/png;base64,AAA");
    expect(svg).toContain("<image");
    expect(svg).toContain('href="data:image/png;base64,AAA"');
    expect(svg).toContain('x="10"');
    expect(svg).toContain('y="20"');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="100"');
    // No <rect> underneath: the placeholder and the image are alternatives.
    expect(svg).not.toContain("<rect");
  });

  it("the href is requested for the node's HASH", () => {
    const asked: string[] = [];
    nodesToSvg([image({ id: "i", image: { assetHash: "deadbeef" } })], FULL, measure, (h) => {
      asked.push(h);
      return null;
    });
    expect(asked).toEqual(["deadbeef"]);
  });

  it("the node's opacity lands on the <image>", () => {
    const svg = nodesToSvg([image({ id: "i", opacity: 0.5 })], FULL, measure, () => "u");
    expect(svg).toContain('opacity="0.5"');
  });

  it("preserveAspectRatio=none: the box rules, as on the canvas", () => {
    // The canvas draws with drawImage with four coordinates, that is it STRETCHES
    // the image onto the box. The SVG default ("xMidYMid meet") would fit it
    // inside leaving margins: same document, two different results.
    const svg = nodesToSvg([image({ id: "i" })], FULL, measure, () => "u");
    expect(svg).toContain('preserveAspectRatio="none"');
  });

  it("an unresolvable asset becomes the PLACEHOLDER, not a gray rectangle", () => {
    const svg = nodesToSvg([image({ id: "i", x: 0, y: 0, width: 200, height: 100 })], FULL, measure, () => null);
    expect(svg).not.toContain("<image");
    // A group with the rectangle and the cross: it shows an image was there and
    // is missing, exactly as on the canvas.
    expect(svg).toContain("<g");
    expect(svg).toContain("<rect");
    expect(svg).toContain("<path");
    expect(svg).toContain("M0 0L200 100");
  });

  it("without a resolver every image is a placeholder (prudent default)", () => {
    const svg = nodesToSvg([image({ id: "i" })], FULL, measure);
    expect(svg).not.toContain("<image");
    expect(svg).toContain("<g");
  });

  it("the href is ESCAPED: a URL with & must not break the file", () => {
    const svg = nodesToSvg([image({ id: "i" })], FULL, measure, () => "/a?x=1&y=2");
    expect(svg).toContain('href="/a?x=1&amp;y=2"');
  });
});

describe("nodesToSvg — gradients", () => {
  const grad = {
    r: 1, g: 0, b: 0, a: 1,
    gradient: {
      kind: "linear" as const,
      stops: [
        { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
        { color: { r: 0, g: 0, b: 1, a: 0.5 }, position: 1 },
      ],
      x1: 0, y1: 0, x2: 1, y2: 0,
    },
  };

  it("a linear fill writes a <linearGradient> in <defs> in world coordinates", () => {
    const svg = nodesToSvg([node({ id: "a", x: 10, y: 20, width: 100, height: 40, fills: [grad] })], FULL, measure);
    expect(svg).toContain('<defs><linearGradient id="g0" x1="10" y1="20" x2="110" y2="20" gradientUnits="userSpaceOnUse">');
    expect(svg).toContain('<stop offset="0" stop-color="rgb(255,0,0)"/>');
    expect(svg).toContain('<stop offset="1" stop-color="rgb(0,0,255)" stop-opacity="0.5"/>');
    expect(svg).toContain('fill="url(#g0)"');
  });

  it("a radial writes <radialGradient> with cx/cy/r", () => {
    const radial = { ...grad, gradient: { ...grad.gradient, kind: "radial" as const, x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 } };
    const svg = nodesToSvg([node({ id: "a", width: 100, height: 100, fills: [radial] })], FULL, measure);
    expect(svg).toContain('<radialGradient id="g0" cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">');
  });

  it("two nodes with a gradient have distinct ids; without gradients no <defs>", () => {
    const two = nodesToSvg([node({ id: "a", fills: [grad] }), node({ id: "b", fills: [grad] })], FULL, measure);
    expect(two).toContain('id="g0"');
    expect(two).toContain('id="g1"');
    expect(nodesToSvg([node({ id: "a" })], FULL, measure)).not.toContain("<defs>");
  });
});

describe("nodesToSvg — effects", () => {
  const sh = { kind: "dropShadow" as const, color: { r: 0, g: 0, b: 0, a: 0.25 }, offsetX: 2, offsetY: 4, blur: 10 };

  it("a shadow becomes a <filter> with feDropShadow (deviation = blur/2)", () => {
    const svg = nodesToSvg([node({ id: "a", x: 10, y: 20, width: 100, height: 40, effects: [sh] })], FULL, measure);
    expect(svg).toContain('<feDropShadow dx="2" dy="4" stdDeviation="5" flood-color="rgb(0,0,0)" flood-opacity="0.25"/>');
    expect(svg).toContain('filter="url(#f0)"');
    expect(svg).toContain('filterUnits="userSpaceOnUse"');
    // The region contains the offset and the blur: 4 + 15 + 1 = 20 of margin.
    expect(svg).toContain('<filter id="f0" x="-10" y="0" width="140" height="80"');
  });

  it("shadow + blur: first the shadow and then the blur, in the same filter", () => {
    const svg = nodesToSvg([node({ id: "a", effects: [sh, { kind: "layerBlur", radius: 3 }] })], FULL, measure);
    expect(svg.indexOf("<feDropShadow")).toBeLessThan(svg.indexOf("<feGaussianBlur"));
    expect(svg).toContain('<feGaussianBlur stdDeviation="3"/>');
    expect(svg.match(/<filter /g)).toHaveLength(1);
  });

  it("a node without effects writes no filters; gradient and effect coexist with distinct ids", () => {
    expect(nodesToSvg([node({ id: "a" })], FULL, measure)).not.toContain("<filter");
    const grad = {
      r: 1, g: 0, b: 0, a: 1,
      gradient: { kind: "linear" as const, x1: 0, y1: 0, x2: 1, y2: 0, stops: [
        { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
      ] },
    };
    const both = nodesToSvg([node({ id: "a", fills: [grad], effects: [sh] })], FULL, measure);
    expect(both).toContain('fill="url(#g0)"');
    expect(both).toContain('filter="url(#f1)"');
  });
});

describe("nodesToSvg — frame", () => {
  it("a frame without a fill is transparent, not gray", () => {
    const svg = nodesToSvg([node({ id: "f", kind: "frame", fills: [] })], FULL, measure);
    expect(svg).toContain('fill="none"');
    expect(svg).not.toContain("rgb(204,204,204)");
  });

  it("a frame with a fill writes it like any other shape", () => {
    const svg = nodesToSvg([node({ id: "f", kind: "frame", fills: [{ r: 1, g: 1, b: 1, a: 1 }] })], FULL, measure);
    expect(svg).toContain('fill="rgb(255,255,255)"');
  });

  it("a rectangle without a fill stays gray (the exception belongs to frames)", () => {
    const svg = nodesToSvg([node({ id: "r", fills: [] })], FULL, measure);
    expect(svg).toContain('fill="rgb(204,204,204)"');
  });

describe("nodesToSvg — masks", () => {
  it("a mask becomes a <clipPath> and the nodes above it are wrapped; the mask is not drawn", () => {
    const svg = nodesToSvg(
      [node({ id: "m", isMask: true, kind: "ellipse", x: 0, y: 0, width: 20, height: 20 }), node({ id: "a", x: 5, y: 5 })],
      FULL, measure,
    );
    expect(svg).toContain('<clipPath id="m0"><ellipse cx="10" cy="10" rx="10" ry="10"/></clipPath>');
    expect(svg).toContain('<g clip-path="url(#m0)"><rect');
    expect(svg.match(/<ellipse/g)).toHaveLength(1);
  });
});
});
