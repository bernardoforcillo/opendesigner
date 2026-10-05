import { assetUrl } from "../rpc/assets";

// THE CACHE OF DECODED IMAGES.
//
// It exists for one reason only, and it is the render loop: `drawScene` runs at 60 fps and
// asks for each node's image on EVERY frame. Decoding in there (a
// `new Image()`, or worse a fetch) would mean sixty decodes per
// second per image -- the most direct way to make the canvas stutter.
// Here a request starts only once per (document, hash) and every
// subsequent frame reads an already-ready entry, synchronously.
//
// Redraw does not need to be notified: App.tsx redraws on
// every frame anyway, so the image appears by itself as soon as the entry goes to "ready".
// `onChange` exists for whoever does not run in a loop (tests, and a possible
// invalidation-based renderer).
//
// A FAILURE IS NOT FINAL. "Do not retry on every frame" is the right
// rule for a 60 fps loop, but "NEVER retry" is another thing: a
// restarted server, a 5xx, a request in flight when the tab went to the
// background would pin that (document, hash) to the placeholder for the whole
// life of the page, with the file still there on disk. So a TRANSIENT
// "missing" carries with it the moment when it can be retried, with a wait
// that doubles on every failure up to a cap: the maximum cost is one
// request every RETRY_MAX_MS per broken image, not one per frame.

/**
 * The state of an asset for whoever draws.
 *  - "loading": the request has started, there is nothing to draw yet;
 *  - "ready":   `image` is decoded and has dimensions > 0;
 *  - "missing": it is not there (404, unreadable bytes, empty hash).
 *
 * "missing" is not necessarily final: see `retryAt` on the internal entry and
 * `retryMissing()`.
 */
export type ImageStatus = "loading" | "ready" | "missing";

export interface CachedImage {
  status: ImageStatus;
  image: HTMLImageElement | null;
}

// The entry as the cache holds it. `retryAt` and `failures` are not needed by whoever
// draws (who reads `status` only) but are what distinguishes a failure
// one can come back from from one that is permanent.
interface Entry extends CachedImage {
  /**
   * When this "missing" entry becomes requestable again.
   * `undefined` = NEVER: retrying could not change the answer (empty hash,
   * no loader in this environment).
   */
  retryAt?: number;
  /** Consecutive failures, that is how long to wait before the next one. */
  failures: number;
}

// An empty hash and an environment without `Image` are the only two "missing" ones that
// cannot be recovered from: in the first case there is nothing to ask for, in the second there is
// no one to ask.
const MISSING_FOREVER: Entry = { status: "missing", image: null, failures: 0 };

/** The first wait after a failure, and the cap at which the doubling stops. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;

/**
 * How long to wait after `failures` consecutive failures: 2s, 4s, 8s, 16s,
 * then 30s forever.
 *
 * The doubling serves to distinguish the two cases without having to recognize them: an
 * instantaneous outage recovers within two seconds, an asset that
 * truly is not there ends up costing one request every half minute -- and remains
 * recoverable anyway, because the cap never becomes "stop".
 */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** How to start loading a URL. Injectable: `Image` is not available everywhere. */
export type LoadImage = (url: string) => HTMLImageElement;

function domLoader(url: string): HTMLImageElement {
  const img = new Image();
  // Assets come from the SAME origin as the editor, so crossOrigin is not
  // needed; declaring it would force a preflight on a route that does not
  // need one.
  img.src = url;
  return img;
}

export class ImageCache {
  private entries = new Map<string, Entry>();
  // Whoever wants to know that something changed (an image ready, an entry
  // forgotten): the invalidation-based draw loop of ui/App.tsx. In addition to the
  // constructor's `onChange`, which stays for tests.
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.onChange();
    for (const l of this.listeners) l();
  }

  constructor(
    private readonly load: LoadImage = domLoader,
    private readonly onChange: () => void = () => {},
    // The clock is injectable because an attempt's expiry is a
    // behavior, and a behavior that depends on time can only be verified
    // if time is decided by the test.
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * An asset's image, IMMEDIATELY and never throwing: it is meant to be
   * called inside the render loop. The first call starts the loading and
   * returns "loading"; the following ones just read -- except when the entry is
   * a transient "missing" whose wait has expired, which restarts by itself.
   */
  get(docId: string, hash: string): CachedImage {
    // An empty hash identifies nothing: asking for /assets-api/doc/ on every
    // frame would be a request per second per node, all 404s.
    if (hash === "") return MISSING_FOREVER;
    const key = `${docId}/${hash}`;
    const found = this.entries.get(key);
    if (found && !this.expired(found)) return found;
    return this.start(key, assetUrl(docId, hash), found?.failures ?? 0);
  }

  /**
   * Forgets TRANSIENT failures, without waiting for their expiry: the
   * next `get` restarts immediately and from scratch (the wait goes back to the base).
   *
   * It is called by whoever has a reason to believe the world has changed -- the
   * network back, the tab back in the foreground (see
   * `attachImageRecovery`). Ready entries stay: the name IS the content,
   * so the bytes at that URL cannot have changed and reloading them
   * would just be a flash of placeholder.
   *
   * Returns how many entries it forgot, which is what makes "there was nothing to
   * retry" observable.
   */
  retryMissing(): number {
    let forgotten = 0;
    for (const [key, entry] of this.entries) {
      if (entry.status === "missing" && entry.retryAt !== undefined) {
        this.entries.delete(key);
        forgotten++;
      }
    }
    if (forgotten > 0) this.changed();
    return forgotten;
  }

  private expired(entry: Entry): boolean {
    return entry.status === "missing" && entry.retryAt !== undefined && this.now() >= entry.retryAt;
  }

  private start(key: string, url: string, failures: number): Entry {
    const loading: Entry = { status: "loading", image: null, failures };
    this.entries.set(key, loading);
    let img: HTMLImageElement;
    try {
      img = this.load(url);
    } catch {
      // No way to load images in this environment: retrying would not
      // change the answer, so the entry is final. And above all
      // no exception inside the draw loop.
      const dead: Entry = { status: "missing", image: null, failures: failures + 1 };
      this.entries.set(key, dead);
      return dead;
    }
    img.onload = () => {
      // A `load` on undecodable bytes exists (some browsers
      // emit it anyway): a zero-size element produces no pixels,
      // so it counts as missing -- better the placeholder than nothing. It is
      // transient like a network error: a response truncated halfway arrives
      // exactly like this.
      const ok = img.naturalWidth > 0 && img.naturalHeight > 0;
      this.settle(key, loading, ok ? { status: "ready", image: img, failures: 0 } : this.retryable(failures));
    };
    img.onerror = () => this.settle(key, loading, this.retryable(failures));
    return loading;
  }

  private retryable(failures: number): Entry {
    const next = failures + 1;
    return {
      status: "missing",
      image: null,
      failures: next,
      retryAt: this.now() + retryDelay(next),
    };
  }

  // The entry is updated only if it is STILL the one that started this
  // load: between the start and the response a `retryMissing()` and a
  // second attempt may have passed, and the old response (an error
  // on a request now abandoned) must not erase the new one.
  private settle(key: string, started: Entry, next: Entry): void {
    if (this.entries.get(key) !== started) return;
    this.entries.set(key, next);
    this.changed();
  }
}

// The minimum needed to attach and detach a listener. Declared
// like this instead of `Window`/`Document` because it is all this function
// uses, and it is what allows it to be verified without either.
interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface VisibilitySource extends Listenable {
  readonly visibilityState: string;
}

/**
 * Attaches the two signals that make it sensible to retry IMMEDIATELY, instead of
 * waiting for the attempt's expiry:
 *
 *  - `online`: the network is back, so every failure accumulated while it was not
 *    there is by definition to be redone;
 *  - the tab coming back to the foreground: a browser suspends (and sometimes
 *    interrupts) a background tab's requests, and those
 *    interruptions arrive here as `error`.
 *
 * Returns the function that detaches, because it is mounted by a `useEffect`.
 */
export function attachImageRecovery(
  cache: ImageCache = imageCache,
  win: Listenable = window,
  doc: VisibilitySource = document,
): () => void {
  const onOnline = () => {
    cache.retryMissing();
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") cache.retryMissing();
  };
  win.addEventListener("online", onOnline);
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    win.removeEventListener("online", onOnline);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}

// The cache the renderer uses. One per page: building one per frame
// (or per component) would cancel exactly what it exists for.
//
// The EXPORT does not use it: an exported file must not depend on which images
// this session has already seen go by (see export/exportScene.ts, which resolves
// the bytes by itself and WAITS for them).
export const imageCache = new ImageCache();
