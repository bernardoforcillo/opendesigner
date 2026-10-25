// THE CORE OF LOCALIZATION: pure functions, no React and no storage, so the tests
// reach every rule directly. The English text IS the key (as in FigCraft): the code
// stays readable (`t("Undo")`) and a key a catalog lacks falls back to its English
// text, so a partial catalog is safe to ship. Plurals are objects keyed by the
// CLDR category (`one`, `other`...), picked with Intl.PluralRules.

/** The CLDR plural categories a catalog entry may give; `other` is the one that must exist. */
export type PluralForms = { other: string } & Partial<Record<Exclude<Intl.LDMLPluralRule, "other">, string>>;
/** One catalog value: plain text, or the forms of a plural. */
export type Message = string | PluralForms;
export type Vars = Record<string, string | number>;

/** The languages with a catalog. `pt-BR` and `zh-Hans` keep their region/script as FigCraft does. */
export type LanguageCode = "en" | "es" | "fr" | "de" | "it" | "pt-BR" | "ja" | "zh-Hans";

/** `{name}` placeholders; a variable the call does not give stays visible as written. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}

/** The placeholders a message uses, sorted and de-duplicated (every plural form counts). Used by the parity test. */
export function placeholders(m: Message): string[] {
  const texts = typeof m === "string" ? [m] : Object.values(m);
  const found = new Set<string>();
  for (const s of texts) for (const x of s.matchAll(/\{(\w+)\}/g)) found.add(x[1]);
  return [...found].sort();
}

const rules = new Map<string, Intl.PluralRules>();
function pluralCategory(lang: string, n: number): Intl.LDMLPluralRule {
  let r = rules.get(lang);
  if (!r) { r = new Intl.PluralRules(lang); rules.set(lang, r); }
  return r.select(n);
}

/** Picks the text of a message; a plural takes the category of `count`, then `other`. */
export function pick(m: Message, lang: string, count?: number): string {
  if (typeof m === "string") return m;
  if (count === undefined) return m.other;
  return m[pluralCategory(lang, count)] ?? m.other;
}

/** A tag from the browser or storage to a language we have a catalog for, or null. */
export function matchLanguage(tag: string, available: readonly LanguageCode[]): LanguageCode | null {
  const t = tag.trim().replace(/_/g, "-");
  if (t === "") return null;
  const [lang, ...rest] = t.toLowerCase().split("-");
  const has = (c: LanguageCode) => (available.includes(c) ? c : null);
  if (lang === "zh") {
    // Traditional Chinese has no catalog: it reads English (or the next language), never Simplified.
    if (rest.includes("hant") || rest.some((r) => r === "tw" || r === "hk" || r === "mo")) return null;
    return has("zh-Hans");
  }
  if (lang === "pt") return has("pt-BR");
  return has(lang as LanguageCode);
}

/** The first of the preferred languages that has a catalog, or null. */
export function firstSupported(preferred: readonly string[], available: readonly LanguageCode[]): LanguageCode | null {
  for (const tag of preferred) {
    const hit = matchLanguage(tag, available);
    if (hit) return hit;
  }
  return null;
}
