import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { interpolate, matchLanguage, pick, placeholders, type Message } from "./core";
import { CATALOGS, LANGUAGES, detectLanguage, translate, useLanguage, useT } from ".";
import { en } from "./locales/en";
import { LanguageSelect } from "./LanguageSelect";

const CODES = LANGUAGES.map((l) => l.code);
const KEYS = Object.keys(en);

function setNavigator(langs: string[]) {
  Object.defineProperty(navigator, "languages", { value: langs, configurable: true });
  Object.defineProperty(navigator, "language", { value: langs[0] ?? "", configurable: true });
}

beforeEach(() => { localStorage.clear(); setNavigator(["en-US"]); useLanguage.getState().set("system"); });
afterEach(() => { cleanup(); });

describe("catalog parity", () => {
  for (const { code } of LANGUAGES) {
    it(`${code} has exactly the English keys and the same placeholders`, () => {
      const cat = CATALOGS[code] as Record<string, Message>;
      expect(Object.keys(cat).sort()).toEqual([...KEYS].sort());
      for (const k of KEYS) {
        const want = placeholders((en as Record<string, Message>)[k]);
        expect(placeholders(cat[k]), `${code}: ${k}`).toEqual(want);
        // Every plural needs its `other` form, and a plain message is never empty.
        const m = cat[k] as string | { other: string };
        expect(typeof m === "string" ? m : m.other, `${code}: ${k}`).not.toBe("");
      }
    });
  }

  it("English values are their keys, except plurals", () => {
    for (const [k, v] of Object.entries(en)) if (typeof v === "string") expect(v).toBe(k);
  });

  it("a plural in English is a plural everywhere that has plural forms, and only uses {n}", () => {
    for (const k of KEYS) {
      if (typeof (en as Record<string, unknown>)[k] === "string") continue;
      for (const code of CODES) expect(typeof (CATALOGS[code] as Record<string, unknown>)[k]).toBe("object");
    }
  });
});

describe("core", () => {
  it("interpolates and leaves unknown placeholders visible", () => {
    expect(interpolate("Open {name} ({n})", { name: "A", n: 2 })).toBe("Open A (2)");
    expect(interpolate("Open {name}", {})).toBe("Open {name}");
    expect(interpolate("plain")).toBe("plain");
  });

  it("picks plural forms with the language's rules", () => {
    const m = { one: "{n} screen", other: "{n} screens" };
    expect(pick(m, "en", 1)).toBe("{n} screen");
    expect(pick(m, "en", 0)).toBe("{n} screens");
    expect(pick(m, "en", 2)).toBe("{n} screens");
    // French treats 0 as singular; Japanese has only `other`.
    expect(pick(m, "fr", 0)).toBe("{n} screen");
    expect(pick({ other: "x" }, "ja", 1)).toBe("x");
    expect(pick(m, "en")).toBe("{n} screens");
  });

  it("matches browser tags to catalogs", () => {
    expect(matchLanguage("fr-CA", CODES)).toBe("fr");
    expect(matchLanguage("pt-PT", CODES)).toBe("pt-BR");
    expect(matchLanguage("pt", CODES)).toBe("pt-BR");
    expect(matchLanguage("zh-CN", CODES)).toBe("zh-Hans");
    expect(matchLanguage("zh-Hans", CODES)).toBe("zh-Hans");
    expect(matchLanguage("zh-TW", CODES)).toBeNull();
    expect(matchLanguage("zh-Hant", CODES)).toBeNull();
    expect(matchLanguage("ko", CODES)).toBeNull();
    expect(matchLanguage("", CODES)).toBeNull();
  });

  it("translates, falls back to English and then to the key", () => {
    expect(translate("es", "Undo")).toBe("Deshacer");
    expect(translate("es", "Open {name}", { name: "X" })).toBe("Abrir X");
    expect(translate("es", "{n} screens", { n: 1 }, 1)).toBe("1 pantalla");
    expect(translate("ja", "{n} screens", { n: 3 }, 3)).toBe("画面 3 枚");
    expect(translate("es", "Not in any catalog")).toBe("Not in any catalog");
    // A partial catalog reads English for what it lacks.
    const saved = CATALOGS.de.Undo;
    delete CATALOGS.de.Undo;
    try { expect(translate("de", "Undo")).toBe("Undo"); } finally { CATALOGS.de.Undo = saved; }
  });
});

describe("language choice", () => {
  it("follows the browser's first supported language", () => {
    setNavigator(["ko-KR", "de-AT", "en"]);
    expect(detectLanguage()).toBe("de");
    setNavigator(["ko"]);
    expect(detectLanguage()).toBe("en");
  });

  it("a forced language wins, is stored, and system clears it", () => {
    useLanguage.getState().set("fr");
    expect(useLanguage.getState().lang).toBe("fr");
    expect(localStorage.getItem("od.language")).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    useLanguage.getState().set("system");
    expect(localStorage.getItem("od.language")).toBeNull();
    expect(useLanguage.getState().lang).toBe("en");
  });

  it("redraws a component live when the language changes", async () => {
    function Probe() {
      const { t, tn } = useT();
      return <p>{t("Undo")} / {tn("{n} flows", 2)}</p>;
    }
    render(<Probe />);
    expect(screen.getByText("Undo / 2 flows")).toBeInTheDocument();
    act(() => useLanguage.getState().set("it"));
    expect(screen.getByText("Annulla / 2 flussi")).toBeInTheDocument();
  });

  it("the picker lists every language in its own name and switches", async () => {
    render(<LanguageSelect />);
    const select = screen.getByRole("combobox", { name: "Language" });
    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /日本語/ })).toBeInTheDocument();
    await userEvent.selectOptions(select, "zh-Hans");
    expect(useLanguage.getState().lang).toBe("zh-Hans");
    expect(screen.getByRole("combobox", { name: "语言" })).toBeInTheDocument();
  });
});
