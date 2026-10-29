import { useLanguage } from "@/i18n";

// DATES AND NUMBERS BY LANGUAGE (docs/localization.md): the formatters read the interface language, not the
// browser's, so a person who picked Deutsch sees "29. Okt." and "1,5". Called while rendering, they follow a
// language switch for every component that redraws on it (everything that uses `useT()`).

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>();
function memo<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(key: string, make: () => T): T {
  let f = cache.get(key) as T | undefined;
  if (!f) { f = make(); cache.set(key, f); }
  return f;
}

/** The language in force as a BCP 47 tag for Intl. */
export const intlLocale = (): string => useLanguage.getState().lang;

/** A date or date and time given in unix seconds (a bigint from the wire is fine). */
export function formatDate(sec: number | bigint, opts: Intl.DateTimeFormatOptions): string {
  const loc = intlLocale();
  return memo(`d|${loc}|${JSON.stringify(opts)}`, () => new Intl.DateTimeFormat(loc, opts)).format(new Date(Number(sec) * 1000));
}

export function formatNumber(n: number, opts: Intl.NumberFormatOptions = {}): string {
  const loc = intlLocale();
  return memo(`n|${loc}|${JSON.stringify(opts)}`, () => new Intl.NumberFormat(loc, opts)).format(n);
}

/** "5 minutes ago", "yesterday" in the interface language. `value` is negative for the past. */
export function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  const loc = intlLocale();
  return memo(`r|${loc}`, () => new Intl.RelativeTimeFormat(loc, { numeric: "auto" })).format(value, unit);
}
