import { sfntKind, sfntTables } from "@/pdf/sfnt";

// OPENTYPE LAYOUT for the PDF: the glyph substitutions (GSUB) that turn "fi" into one ligature glyph, pick an alternate
// ("salt") or a small-cap form ("smcp"), as the browser does when it draws the text. Supported: lookup types 1 (single),
// 3 (alternate) and 4 (ligature), also through extension lookups (7). NOT supported, and skipped without error: contextual
// and chaining lookups (types 5, 6, 8: `calt`, many Arabic and Indic features), multiple substitution (2), lookup flags
// (mark skipping), GPOS (kerning and mark positioning), and script/language selection (a feature's lookups apply
// whatever the script).

export interface Glyph { gid: number; text: string }

type Rule =
  | { kind: "single"; map: Map<number, number> }
  | { kind: "alternate"; map: Map<number, number[]> }
  | { kind: "ligature"; map: Map<number, { components: number[]; lig: number }[]> };

export interface Gsub {
  /** The feature tags the font offers. */
  tags: ReadonlySet<string>;
  /** Applies the enabled features (tag -> value; 0 is off, 1 the first alternate) to a run of glyphs. */
  apply(glyphs: Glyph[], features: ReadonlyMap<string, number>): Glyph[];
}

/** `"liga" 0, "salt" 2, ss01` (CSS font-feature-settings) as tag -> value. */
export function parseFeatures(css: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!css) return out;
  for (const part of css.split(",")) {
    const m = /^\s*["']?([A-Za-z0-9 ]{4})["']?\s*(on|off|\d+)?\s*$/.exec(part);
    if (!m) continue;
    out.set(m[1]!, m[2] === undefined || m[2] === "on" ? 1 : m[2] === "off" ? 0 : Number(m[2]));
  }
  return out;
}

export function readGsub(data: Uint8Array): Gsub | null {
  if (!sfntKind(data)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    const gsub = sfntTables(v).get("GSUB");
    if (!gsub) return null;
    const base = gsub.offset;
    const u16 = (o: number) => v.getUint16(o);
    const featureList = base + u16(base + 6), lookupList = base + u16(base + 8);

    const featureLookups = new Map<string, number[]>();
    const nFeat = u16(featureList);
    for (let i = 0; i < nFeat; i++) {
      const rec = featureList + 2 + i * 6;
      const tag = String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3));
      const ft = featureList + u16(rec + 4);
      const list = featureLookups.get(tag) ?? [];
      for (let k = 0, n = u16(ft + 2); k < n; k++) list.push(u16(ft + 4 + k * 2));
      featureLookups.set(tag, list);
    }

    const coverage = (o: number): number[] => {
      const out: number[] = [];
      if (u16(o) === 1) {
        for (let i = 0, n = u16(o + 2); i < n; i++) out.push(u16(o + 4 + i * 2));
      } else {
        for (let i = 0, n = u16(o + 2); i < n; i++) {
          const r = o + 4 + i * 6, start = u16(r), end = u16(r + 2), idx = u16(r + 4);
          for (let g = start; g <= end; g++) out[idx + g - start] = g;
        }
      }
      return out;
    };

    const lookups = new Map<number, Rule[]>();
    const lookupRules = (index: number): Rule[] => {
      const cached = lookups.get(index);
      if (cached) return cached;
      const rules: Rule[] = [];
      lookups.set(index, rules);
      const lt = lookupList + u16(lookupList + 2 + index * 2);
      const type = u16(lt);
      for (let s = 0, n = u16(lt + 4); s < n; s++) {
        let st = lt + u16(lt + 6 + s * 2), t = type;
        if (t === 7) { t = u16(st + 2); st += v.getUint32(st + 4); }
        if (t !== 1 && t !== 3 && t !== 4) continue;
        const cov = coverage(st + u16(st + 2));
        if (t === 1) {
          const map = new Map<number, number>();
          if (u16(st) === 1) { const d = v.getInt16(st + 4); cov.forEach((g) => map.set(g, (g + d) & 0xffff)); }
          else cov.forEach((g, i) => map.set(g, u16(st + 6 + i * 2)));
          rules.push({ kind: "single", map });
        } else if (t === 3) {
          const map = new Map<number, number[]>();
          cov.forEach((g, i) => {
            const set = st + u16(st + 6 + i * 2);
            const alts: number[] = [];
            for (let k = 0, c = u16(set); k < c; k++) alts.push(u16(set + 2 + k * 2));
            map.set(g, alts);
          });
          rules.push({ kind: "alternate", map });
        } else {
          const map = new Map<number, { components: number[]; lig: number }[]>();
          cov.forEach((g, i) => {
            const set = st + u16(st + 6 + i * 2);
            const list: { components: number[]; lig: number }[] = [];
            for (let k = 0, c = u16(set); k < c; k++) {
              const lg = set + u16(set + 2 + k * 2);
              const count = u16(lg + 2);
              const components: number[] = [];
              for (let q = 0; q < count - 1; q++) components.push(u16(lg + 4 + q * 2));
              list.push({ components, lig: u16(lg) });
            }
            map.set(g, list);
          });
          rules.push({ kind: "ligature", map });
        }
      }
      return rules;
    };

    return {
      tags: new Set(featureLookups.keys()),
      apply(glyphs, features) {
        const value = new Map<number, number>(); // lookup index -> feature value
        for (const [tag, val] of features) {
          if (val <= 0) continue;
          for (const l of featureLookups.get(tag) ?? []) value.set(l, Math.max(value.get(l) ?? 0, val));
        }
        let run = glyphs;
        for (const l of [...value.keys()].sort((a, b) => a - b)) {
          for (const rule of lookupRules(l)) run = applyRule(run, rule, value.get(l) ?? 1);
        }
        return run;
      },
    };
  } catch {
    return null;
  }
}

function applyRule(run: Glyph[], rule: Rule, val: number): Glyph[] {
  const out: Glyph[] = [];
  for (let i = 0; i < run.length; i++) {
    const g = run[i]!;
    if (rule.kind === "single") {
      const to = rule.map.get(g.gid);
      out.push(to === undefined ? g : { gid: to, text: g.text });
    } else if (rule.kind === "alternate") {
      const pick = rule.map.get(g.gid)?.[val - 1];
      out.push(pick === undefined ? g : { gid: pick, text: g.text });
    } else {
      const hit = rule.map.get(g.gid)?.find((c) => c.components.every((cg, k) => run[i + 1 + k]?.gid === cg));
      if (!hit) { out.push(g); continue; }
      let text = g.text;
      for (let k = 0; k < hit.components.length; k++) text += run[i + 1 + k]!.text;
      out.push({ gid: hit.lig, text });
      i += hit.components.length;
    }
  }
  return out;
}
