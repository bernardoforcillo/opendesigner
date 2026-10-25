// OpenType features as the panel edits them: the CSS font-feature-settings string kept in
// TextStyle.fontFeatures (validated by store/typography.ts::isValidFontFeatures).

/** The value of feature `tag` in a font-feature-settings string: 1/0, or null when it is not mentioned. */
export function featureValue(features: string | undefined, tag: string): number | null {
  for (const item of (features ?? "").split(",")) {
    const m = /^\s*"([A-Za-z0-9]{4})"(?:\s+(\d{1,4}))?\s*$/.exec(item);
    if (m && m[1] === tag) return m[2] === undefined ? 1 : Number(m[2]);
  }
  return null;
}

/** `features` with `tag` set to `value` (null removes it); the other items keep their order. Empty becomes undefined. */
export function withFeature(features: string | undefined, tag: string, value: number | null): string | undefined {
  const kept = (features ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "" && !new RegExp(`^"${tag}"(\\s|$)`).test(s));
  if (value !== null) kept.push(value === 1 ? `"${tag}"` : `"${tag}" ${value}`);
  return kept.length === 0 ? undefined : kept.join(", ");
}
