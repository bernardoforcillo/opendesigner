// LE PREFERENZE PER DOCUMENTO dell'onboarding, nel localStorage del browser:
// la scheda chiusa e i due passi che il documento non sa dire da solo
// (prototipo aperto, codice esportato). Sono convenienze per-utente: non
// viaggiano agli altri collaboratori e vanno bene se si perdono.

export interface DocPrefs {
  dismissed: boolean;
  presented: boolean;
  shipped: boolean;
}

const NONE: DocPrefs = { dismissed: false, presented: false, shipped: false };
const key = (docId: string) => `opendesigner.onboarding.${docId}`;

export function loadDocPrefs(docId: string): DocPrefs {
  try {
    const raw = localStorage.getItem(key(docId));
    if (!raw) return NONE;
    const v = JSON.parse(raw) as Partial<DocPrefs>;
    return { dismissed: v.dismissed === true, presented: v.presented === true, shipped: v.shipped === true };
  } catch {
    return NONE;
  }
}

export function saveDocPrefs(docId: string, patch: Partial<DocPrefs>): DocPrefs {
  const next = { ...loadDocPrefs(docId), ...patch };
  try {
    localStorage.setItem(key(docId), JSON.stringify(next));
  } catch {
    /* storage non disponibile: la preferenza vale per questa sessione */
  }
  return next;
}

/**
 * L'evento con cui il resto dell'app dice "il codice di questo documento è
 * stato esportato" (la modalità Sviluppo lo emette dopo lo zip): ticchetta
 * l'ultimo passo della checklist senza che le due parti si importino.
 */
export const SHIPPED_EVENT = "opendesigner:shipped";
