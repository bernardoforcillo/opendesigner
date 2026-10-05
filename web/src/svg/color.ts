// CSS/SVG COLORS -> RGBA float 0..1 (the proto's Color).
//
// Pure function, no DOM: the importer must run identically in jsdom, in the
// browser and (one day) in a worker. It covers what a real SVG contains:
// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` (values and
// percentages, syntax with commas and with spaces/slash), `hsl()/hsla()`, the CSS
// names and `transparent`. `none`, `currentColor` and `url(...)` are NOT
// colors: the paint parser in importSvg.ts tells them apart.

export interface Rgba { r: number; g: number; b: number; a: number }

// The 148 CSS names in compact "name:rrggbb" form: written out in full they would be
// 148 lines of noise in a file whose logic lives elsewhere.
const NAMED =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000," +
  "blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00," +
  "chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b," +
  "darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b," +
  "darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a," +
  "darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1," +
  "darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff," +
  "firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff," +
  "gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0," +
  "hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5," +
  "lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff," +
  "lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1," +
  "lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899," +
  "lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff," +
  "maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db," +
  "mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc," +
  "mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5," +
  "navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500," +
  "orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093," +
  "papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080," +
  "rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072," +
  "sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb," +
  "slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4," +
  "tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3," +
  "white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";

const NAMED_MAP: Map<string, string> = new Map(
  NAMED.split(",").map((p) => p.split(":") as [string, string]),
);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hex(h: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const n = (s: string) => parseInt(s, 16) / 255;
  if (h.length === 3 || h.length === 4) {
    const [r, g, b, a] = h.split("").map((c) => n(c + c));
    return { r, g, b, a: h.length === 4 ? a : 1 };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: n(h.slice(0, 2)), g: n(h.slice(2, 4)), b: n(h.slice(4, 6)),
      a: h.length === 8 ? n(h.slice(6, 8)) : 1,
    };
  }
  return null;
}

// "50%" -> 0.5; "128" con scale 255 -> 128/255.
function component(tok: string, scale: number): number | null {
  const t = tok.trim();
  if (t === "") return null;
  const pct = t.endsWith("%");
  const v = parseFloat(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(v)) return null;
  return pct ? v / 100 : v / scale;
}

function alpha(tok: string | undefined): number {
  if (tok === undefined) return 1;
  const v = component(tok, 1);
  return v === null ? 1 : clamp01(v);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

/** A CSS color, or null if the string is not a color we can read. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === "") return null;
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith("#")) return hex(s.slice(1));
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
  if (fn) {
    // Syntax with commas ("1, 2, 3, .5") and modern ("1 2 3 / .5").
    const parts = fn[2].split(/[\s,/]+/).filter((p) => p !== "");
    if (parts.length < 3 || parts.length > 4) return null;
    if (fn[1].startsWith("rgb")) {
      const c = parts.slice(0, 3).map((p) => component(p, 255));
      if (c.some((v) => v === null)) return null;
      return {
        r: clamp01(c[0] as number), g: clamp01(c[1] as number), b: clamp01(c[2] as number),
        a: alpha(parts[3]),
      };
    }
    const h = parseFloat(parts[0]);
    const sat = component(parts[1], 100);
    const lig = component(parts[2], 100);
    if (!Number.isFinite(h) || sat === null || lig === null) return null;
    const [r, g, b] = hslToRgb(h, clamp01(sat), clamp01(lig));
    return { r, g, b, a: alpha(parts[3]) };
  }
  const named = NAMED_MAP.get(s);
  return named ? hex(named) : null;
}
