import { describe, it, expect, afterEach } from "vitest";
import { useLanguage } from "@/i18n";
import { formatDate, formatNumber, formatRelative } from "@/i18n/format";
import { relativeTime } from "@/home/route";

afterEach(() => useLanguage.getState().set("en"));

const SEC = Date.UTC(2026, 9, 29, 12, 0) / 1000;

describe("dates and numbers follow the interface language", () => {
  it("formats a date in the language, not the browser's", () => {
    const opts = { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" } as const;
    expect(formatDate(SEC, opts)).toBe("October 29, 2026");
    useLanguage.getState().set("de");
    expect(formatDate(SEC, opts)).toBe("29. Oktober 2026");
    useLanguage.getState().set("ja");
    expect(formatDate(SEC, opts)).toBe("2026年10月29日");
  });

  it("formats numbers with the language's separators", () => {
    expect(formatNumber(1234.5)).toBe("1,234.5");
    useLanguage.getState().set("de");
    expect(formatNumber(1234.5)).toBe("1.234,5");
    useLanguage.getState().set("fr");
    expect(formatNumber(1234.5).replace(/\s/g, " ")).toBe("1 234,5");
  });

  it("says relative times in the language", () => {
    useLanguage.getState().set("es");
    expect(formatRelative(-1, "day")).toBe("ayer");
    expect(relativeTime(SEC, (SEC + 3 * 3600) * 1000)).toBe("hace 3 horas");
  });

  it("keeps the English wording in English", () => {
    expect(relativeTime(SEC, (SEC + 3 * 3600) * 1000)).toBe("3 hours ago");
  });
});
