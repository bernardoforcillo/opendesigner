import { docClient } from "./client";
import { usePresence } from "../store/presence";

// What this client says about itself to the others. All ephemeral: cursor (in
// WORLD coordinates, so everyone sees it at the right spot with their own camera),
// page and selection.
export interface LocalPresence {
  hasCursor: boolean;
  cursorX: number;
  cursorY: number;
  pageId: string;
  selection: string[];
}

// No more than one send every 50 ms (20 Hz): a cursor does not need more, and
// pointermove produces hundreds per second. The last value wins.
const SEND_INTERVAL_MS = 50;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;

/**
 * The presence channel: a WatchPresence stream (who is here) and a unary
 * UpdatePresence (where I am). It never touches the document or the ops.
 *
 * It ALWAYS retries, with backoff: presence is an extra, and losing it must
 * never ruin an edit. Unlike SyncClient it has no cap on
 * attempts and no error message -- someone working alone does not notice.
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

  // The nickname is fixed by the server on entry, so changing it means
  // leaving and re-entering: the stream reopens from scratch with the new name.
  setNickname(nickname: string): void {
    if (nickname === this.nickname) return;
    this.nickname = nickname;
    if (this.stopped) return;
    this.abort?.abort(); // run() sees it as end of stream and reopens right away
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
      .catch(() => { /* ephemeral: the next update replaces this one */ });
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
            // The server's "ready": from here UpdatePresence is accepted, and
            // whoever just (re)connected says right away where they are.
            this.joined = true;
            attempt = 0;
            this.schedule();
            continue;
          }
          usePresence.getState().apply(ev);
        }
      } catch { /* deliberate abort or network: same treatment, retry */ }
      this.joined = false;
      usePresence.getState().clear();
      if (this.stopped) return;
      // A deliberate abort (nickname change) restarts right away; a real error does not.
      if (this.abort.signal.aborted) continue;
      attempt = Date.now() - startedAt > 10_000 ? 1 : attempt + 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      await new Promise<void>((resolve) => {
        this.retry = setTimeout(resolve, delay);
      });
    }
  }
}
