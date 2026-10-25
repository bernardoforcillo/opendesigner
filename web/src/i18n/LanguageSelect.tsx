import { LANGUAGES, useLanguage, useT, type LanguageChoice } from ".";

// The language picker for places without the document menu (the Home): a native
// select, so it works with the keyboard and screen readers for free. Each language
// is written in its own name; a machine-drafted one says so.
export function LanguageSelect({ className = "" }: { className?: string }) {
  const { t } = useT();
  const choice = useLanguage((s) => s.choice);
  return (
    <select
      aria-label={t("Language")}
      value={choice}
      onChange={(e) => useLanguage.getState().set(e.target.value as LanguageChoice)}
      className={`h-8 rounded-md border border-transparent bg-surface-2 px-2 text-[13px] text-fg hover:border-line-strong focus:border-accent focus:outline-none ${className}`}
    >
      <option value="system">{t("System")}</option>
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code} lang={l.code}>{l.draft ? `${l.name} (${t("machine draft")})` : l.name}</option>
      ))}
    </select>
  );
}
