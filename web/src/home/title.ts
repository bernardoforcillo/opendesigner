const APP_TITLE = "opendesigner";

/** The browser tab title: `Name — opendesigner` (or just the app, in Home). */
export function documentTitleFor(docName: string | null): string {
  return docName ? `${docName} — ${APP_TITLE}` : APP_TITLE;
}
