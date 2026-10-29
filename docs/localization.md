# Localization

The editor's interface can be shown in another language, switched live from the document menu
(Language) or, on the Home, from the language box in the header. The approach follows
[FigCraft](https://github.com/storytold/figcraft)'s (one catalog per language, English text as the key,
language from preferences or the browser, plural forms), written from scratch for the web UI.

## What exists

- **Core** (`web/src/i18n/core.ts`): `{name}` interpolation, plural selection with `Intl.PluralRules`,
  and the matching of a browser tag to a catalog. Pure functions, no React.
- **Catalogs** (`web/src/i18n/locales/<code>.ts`): one typed file per language. `en.ts` is the source;
  its keys are the English text as the code writes it. The other files are typed
  `Record<MessageKey, Message>`, so a missing key is a compile error.
- **Store and hook** (`web/src/i18n/index.ts`): `useLanguage` holds the choice (`system` or a code) and
  the language in force; `useT()` returns `{ t, tn, tx, lang }` and redraws the component on a switch;
  `currentT()` is the same outside React. No provider is needed. Also sets `<html lang>`.
- **Language choice**: stored in `localStorage` (`od.language`); `system` (the default) takes the first
  of `navigator.languages` that has a catalog, else English. `fr-CA` reads `fr`, any `pt` reads `pt-BR`,
  `zh`, `zh-CN`, `zh-SG` and `zh-Hans` read `zh-Hans`; Traditional Chinese (`zh-Hant`, `zh-TW`,
  `zh-HK`, `zh-MO`) has no catalog and reads English or the next browser language.
- **Pickers**: the document menu section Language (`ui/shell/DocMenu.tsx`) and the select on the Home
  (`i18n/LanguageSelect.tsx`). Each language shows in its own name, and a draft says so.

## Editor only

The language is a **per-person browser setting** (`od.language` in `localStorage`, or the browser's languages for
`system`), not part of the document, so MCP cannot switch it and an agent never sees a translated interface. MCP has
one read-only tool, `list_ui_languages` (code, own name, whether the catalog is still a machine draft), kept in step
with `LANGUAGES` by a test. Document content (layer names, text) is never translated, and what the server or MCP
returns stays English.

## Languages and their status

| Code | Language | Status |
| --- | --- | --- |
| `en` | English | source |
| `es` | Spanish | machine draft, needs native review |
| `fr` | French | machine draft, needs native review |
| `de` | German (Sie) | machine draft, needs native review |
| `it` | Italian | machine draft, needs native review |
| `pt-BR` | Brazilian Portuguese | machine draft, needs native review |
| `ja` | Japanese | machine draft, needs native review |
| `zh-Hans` | Simplified Chinese | machine draft, needs native review |

The non-English catalogs were drafted by a machine and nobody has reviewed them. Flip `draft` to `false`
in `LANGUAGES` (`i18n/index.ts`) once a native speaker has approved a catalog. Style notes: French puts a
no-break space before `: ; ? !`; German uses formal address; Brazilian Portuguese uses Brazilian words
(arquivo, tela, você); Japanese is concise without です/ます and with full-width punctuation; Chinese uses
full-width punctuation. Japanese and Chinese have no plural forms, so their plurals give only `other`.

## Dates and numbers

`i18n/format.ts` formats with the **interface language**, not the browser's: `formatDate(seconds, options)`,
`formatNumber(n, options)` and `formatRelative(value, unit)` wrap `Intl` (formats are cached per language and options).
The comment, version, share and Dev-mode dates and the Home's "Edited ..." line use them, and `relativeTime` (Home) says
"hace 3 horas" in Spanish; in English it keeps its short wording ("3 hours ago"). Time labels on the animation timeline
(`animation/timelineLogic.ts`) and the properties panel's percent field are still formatted for English / the browser.

## What is translated so far

The top bar, the tool dock (labels, tooltips, undo/redo, Present), the document menu, the Home (headings,
empty state, join field, document cards with plural counts) and the headings of the properties-panel
sections (the `Section` component translates its title), the Versions dialog (all but the merge-back section), the Share dialog, Insert table, the Comments panel, Page setup, Fonts, Variables and the prototype player's controls. Everything else is still English: other dialogs,
the layers panel, comments, prototype player, dev mode, notices, MCP and server messages. A string with no
catalog entry shows as written, so the interface is never half-blank.

## Migrating more strings

1. Add the English text to `PLAIN` in `locales/en.ts` (or to `PLURALS` with `one` / `other` forms, using
   `{n}` for the count). The text is the key: keep it exactly as the code would show it.
2. Add the same key to every other catalog. The compiler lists the ones you missed; the parity test
   (`i18n.test.tsx`) fails if a catalog has different keys or a different set of `{placeholders}`.
3. In the component, `const { t, tn, tx } = useT();` and replace the literal:
   `t("Undo")`, `t("Open {name}", { name })`, `tn("{n} screens", count)`. Use `tx(label)` only for a
   label that arrives as a prop or comes from a table, where the key is not a literal.
   Do not build a sentence from pieces (`"Delete " + name`): translate the whole sentence with a
   placeholder, since word order differs.
4. If the component is used in a loop or has a local variable called `t`, destructure under another name
   (`const i18n = useT()`), as `ToolDock` does.
5. Attributes count too: `aria-label`, `title`, `placeholder`. Tests that look elements up by their
   English name keep working, because the default language in a test is English.
6. A string read when the page loads (a module constant) will not follow a switch; keep the key in the
   constant and call `tx` at render time, as `TopBar` does for the mode hints.

Not translated on purpose: the language names, product and file-format names (SVG, PDF, Mermaid), command
and tool ids, and anything the server or MCP returns.

## Adding a language

1. Copy `locales/es.ts` to `locales/<code>.ts`, translate the values, keep the keys and placeholders.
2. Add the code to `LanguageCode` (`core.ts`), the catalog to `CATALOGS` and a row to `LANGUAGES`
   (`index.ts`), and mark it `draft: true` until a native speaker approves it.
3. If browser tags need mapping (`pt` → `pt-BR`), add the rule to `matchLanguage` with a test.
4. A script that needs a font the UI does not load (Arabic, Korean...) needs that font first; the
   Japanese and Chinese catalogs rely on the system's CJK fonts.

## Not done

- Right-to-left layout, locale-aware dates and numbers (relative times on the Home are still English),
  and translated server errors.
- Command-palette and shortcut labels, dialogs and most panels (see above).
- A language setting kept with the account rather than the browser.
