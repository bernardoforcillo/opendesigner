import { docClient } from "./client";
import { usePresence } from "../store/presence";

// Cosa questo client dice di sé agli altri. Tutto effimero: cursore (in
// coordinate MONDO, così ognuno lo vede al punto giusto con la propria camera),
// pagina e selezione.
export interface LocalPresence {
  hasCursor: boolean;
  cursorX: number;
  cursorY: number;
  pageId: string;
  selection: string[];
}

// Non più di un invio ogni 50 ms (20 Hz): un cursore non ha bisogno di più, e
// il pointermove ne produce centinaia al secondo. L'ultimo valore vince.
const SEND_INTERVAL_MS = 50;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;

/**
 * Il canale di presenza: uno stream WatchPresence (chi c'è) e un unary
 * UpdatePresence (dove sono io). Non tocca mai il documento né gli op.
 *
 * Ritenta SEMPRE, con backoff: la presenza è un di più, e perderla non deve
 * mai rovinare la modifica. A differenza di SyncClient non ha un tetto ai
 * tentativi né un messaggio d'errore -- chi lavora da solo non se ne accorge.
 */
export class PresenceClient {
  private abort: AbortController | null = null;
  private stopped = true;
  private joined = false;
  private local: LocalPresence = { hasCursor: false, cursorX: 0, cursorY: 0, pageId: "", selection: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private docId: string, private clientId: string, private nickname: string) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    usePresence.getState().clear();
  }

  // Il nickname lo fissa il server all'ingresso, quindi cambiarlo vuol dire
  // uscire e rientrare: lo stream si riapre da capo con il nome nuovo.
  setNickname(nickname: string): void {
    if (nickname === this.nickname) return;
    this.nickname = nickname;
    if (this.stopped) return;
    this.abort?.abort(); // run() lo vede come fine stream e si riapre subito
  }

  setLocal(patch: Partial<LocalPresence>): void {
    this.local = { ...this.local, ...patch };
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || !this.joined || this.timer) return;
    const wait = Math.max(0, this.lastSent + SEND_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.stopped || !this.joined) return;
    this.lastSent = Date.now();
    const l = this.local;
    void Promise.resolve()
      .then(() => docClient.updatePresence({
        docId: this.docId,
        state: {
          clientId: this.clientId, nickname: "", hasCursor: l.hasCursor,
          cursorX: l.cursorX, cursorY: l.cursorY, pageId: l.pageId, selection: l.selection,
        },
      }))
      .catch(() => { /* effimero: il prossimo update rimpiazza questo */ });
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      this.abort = new AbortController();
      const startedAt = Date.now();
      try {
        const stream = docClient.watchPresence(
          { docId: this.docId, clientId: this.clientId, nickname: this.nickname },
          { signal: this.abort.signal },
        );
        for await (const ev of stream) {
          if (ev.kind.case === undefined) {
            // Il "pronto" del server: da qui UpdatePresence viene accettato, e
            // chi si è appena (ri)connesso dice subito dove si trova.
            this.joined = true;
            attempt = 0;
            this.schedule();
            continue;
          }
          usePresence.getState().apply(ev);
        }
      } catch { /* abort volontario o rete: stesso trattamento, si riprova */ }
      this.joined = false;
      usePresence.getState().clear();
      if (this.stopped) return;
      // Un abort voluto (cambio nickname) riparte subito; un errore vero no.
      if (this.abort.signal.aborted) continue;
      attempt = Date.now() - startedAt > 10_000 ? 1 : attempt + 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      await new Promise<void>((resolve) => {
        this.retry = setTimeout(resolve, delay);
      });
    }
  }
}
