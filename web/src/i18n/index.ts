import { create } from "zustand";
import { firstSupported, interpolate, matchLanguage, pick, type LanguageCode, type Message, type Vars } from "@/i18n/core";
import { en, type MessageKey } from "@/i18n/locales/en";
import { es } from "@/i18n/locales/es";
import { fr } from "@/i18n/locales/fr";
import { de } from "@/i18n/locales/de";
import { it } from "@/i18n/locales/it";
import { ptBR } from "@/i18n/locales/pt-BR";
import { ja } from "@/i18n/locales/ja";
import { zhHans } from "@/i18n/locales/zh-Hans";

export type { LanguageCode, MessageKey, Vars };

// THE LANGUAGE LAYER (docs/localization.md): one catalog per language, a store that
// holds the choice, and `useT()` for components. Like the theme (ui/shell/theme.ts),
// "system" follows the browser and a language forces itself; the choice survives a
// reload, and without localStorage (private window, jsdom) it stays on "system".
// There is no provider to mount: the store is global and every component that
// calls `useT()` redraws when the language changes.

export type LanguageChoice = "system" | LanguageCode;

/** The picker's rows. `name` is the language's own name and is never translated. */
export const LANGUAGES: readonly { code: LanguageCode; name: string; draft: boolean }[] = [
  { code: "en", name: "English", draft: false },
  { code: "es", name: "Español", draft: true },
  { code: "fr", name: "Français", draft: true },
  { code: "de", name: "Deutsch", draft: true },
  { code: "it", name: "Italiano", draft: true },
  { code: "pt-BR", name: "Português (Brasil)", draft: true },
  { code: "ja", name: "日本語", draft: true },
  { code: "zh-Hans", name: "简体中文", draft: true },
];

/** Every catalog by language. A missing key reads English, so partial catalogs are safe. */
export const CATALOGS: Record<LanguageCode, Partial<Record<string, Message>>> = {
  en, es, fr, de, it, "pt-BR": ptBR, ja, "zh-Hans": zhHans,
};

const CODES = LANGUAGES.map((l) => l.code);
const KEY = "od.language";

function readChoice(): LanguageChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v && matchLanguage(v, CODES) === v ? (v as LanguageCode) : "system";
  } catch { return "system"; }
}

/** The language "system" means: the first browser language that has a catalog, else English. */
export function detectLanguage(): LanguageCode {
  const prefs = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  return firstSupported(prefs, CODES) ?? "en";
}

const resolve = (c: LanguageChoice): LanguageCode => (c === "system" ? detectLanguage() : c);

function apply(lang: LanguageCode) {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export const useLanguage = create<{
  choice: LanguageChoice;
  /** The language in force (the choice, or what "system" resolved to). */
  lang: LanguageCode;
  set: (c: LanguageChoice) => void;
}>((set) => {
  const choice = readChoice();
  return {
    choice,
    lang: resolve(choice),
    set: (c) => {
      try { if (c === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, c); } catch { /* no storage */ }
      const lang = resolve(c);
      apply(lang);
      set({ choice: c, lang });
    },
  };
});

// To be called once at startup, next to initTheme(): sets <html lang>.
export function initLanguage() {
  apply(useLanguage.getState().lang);
}

/** Translates `key` into `lang`: the catalog's text, else the English one, else the key itself. */
export function translate(lang: LanguageCode, key: string, vars?: Vars, count?: number): string {
  const m = CATALOGS[lang][key] ?? CATALOGS.en[key];
  return interpolate(m === undefined ? key : pick(m, lang, count), vars);
}

export interface Translator {
  lang: LanguageCode;
  /** A literal key, checked by the compiler against the English catalog. */
  t: (key: MessageKey, vars?: Vars) => string;
  /** A plural key: `count` picks the form and fills `{n}`. */
  tn: (key: MessageKey, count: number, vars?: Vars) => string;
  /** A key only known at run time (a label passed down as a prop); an unknown one shows as written. */
  tx: (key: string, vars?: Vars) => string;
}

export function translator(lang: LanguageCode): Translator {
  return {
    lang,
    t: (key, vars) => translate(lang, key, vars),
    tn: (key, count, vars) => translate(lang, key, { n: count, ...vars }, count),
    tx: (key, vars) => translate(lang, key, vars),
  };
}

/** For components: the translator of the language in force, redrawn on a switch. */
export function useT(): Translator {
  const lang = useLanguage((s) => s.lang);
  return translator(lang);
}

/** For code outside React (a notice, a menu action): the translator right now. */
export function currentT(): Translator {
  return translator(useLanguage.getState().lang);
}
