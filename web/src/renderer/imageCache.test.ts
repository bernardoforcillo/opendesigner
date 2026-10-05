import { describe, it, expect, vi } from "vitest";
import {
  ImageCache,
  imageCache,
  attachImageRecovery,
  retryDelay,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
} from "./imageCache";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

// A fake image element: `new Image()` exists in jsdom but loads
// nothing and never emits load/error, so loading is injectable and the
// tests below decide when (and how) it ends.
interface FakeImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

function fakeLoader() {
  const created: FakeImage[] = [];
  const load = (url: string) => {
    const img: FakeImage = { src: url, naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null };
    created.push(img);
    return img as unknown as HTMLImageElement;
  };
  return { load, created };
}

function settle(img: FakeImage, ok: boolean) {
  if (ok) {
    img.naturalWidth = 40;
    img.naturalHeight = 20;
    img.onload?.();
  } else {
    img.onerror?.();
  }
}

describe("ImageCache", () => {
  it("decodes ONLY once: the render loop asks on every frame, the loading starts once", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);

    // 60 frames of the render loop on the same node.
    for (let i = 0; i < 60; i++) cache.get("doc1", HASH);
    expect(l.created.length).toBe(1);

    settle(l.created[0], true);
    for (let i = 0; i < 60; i++) expect(cache.get("doc1", HASH).status).toBe("ready");
    // Not even AFTER loading does it reload: it is the point of the cache.
    expect(l.created.length).toBe(1);
  });

  it("starts from 'loading' and goes to 'ready' with the decoded image", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);

    const first = cache.get("doc1", HASH);
    expect(first.status).toBe("loading");
    expect(first.image).toBeNull();

    settle(l.created[0], true);
    const after = cache.get("doc1", HASH);
    expect(after.status).toBe("ready");
    expect(after.image?.naturalWidth).toBe(40);
  });

  it("an asset that does not load becomes 'missing', and the render loop does not request it again", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load, () => {}, () => 0);

    cache.get("doc1", HASH);
    settle(l.created[0], false);

    // The render loop keeps asking: without this the cache would retry the
    // fetch 60 times per second on an image that is not there. The clock is stopped,
    // so no attempt expires in here: 60 frames = one frame.
    for (let i = 0; i < 60; i++) expect(cache.get("doc1", HASH).status).toBe("missing");
    expect(l.created.length).toBe(1);
  });

  it("a successful load but with null dimensions is 'missing', not 'ready'", () => {
    // Some browsers emit `load` on a response that is not decodable.
    // Drawing that element produces no pixels: calling it ready would mean
    // showing the void instead of the placeholder.
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc1", HASH);
    l.created[0].onload?.();
    expect(cache.get("doc1", HASH).status).toBe("missing");
  });

  it("requests the document's and the hash's URL", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc-42", HASH);
    expect(l.created[0].src).toBe(`/assets-api/doc-42/${HASH}`);
  });

  it("keeps two hashes and two documents separate", () => {
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    cache.get("doc1", HASH);
    cache.get("doc1", OTHER);
    // The same hash in ANOTHER document is another file on disk: the key
    // must contain both, or opening a second document would show the
    // first's images.
    cache.get("doc2", HASH);
    expect(l.created.map((i) => i.src)).toEqual([
      `/assets-api/doc1/${HASH}`,
      `/assets-api/doc1/${OTHER}`,
      `/assets-api/doc2/${HASH}`,
    ]);
  });

  it("an empty hash is 'missing' and does not touch the network", () => {
    // An ImageNode whose hash got lost (truncated clipboard payload,
    // upload that never succeeded): there is nothing to ask for, and asking would be
    // a GET on /assets-api/doc/ on every frame.
    const l = fakeLoader();
    const cache = new ImageCache(l.load);
    expect(cache.get("doc1", "").status).toBe("missing");
    expect(l.created.length).toBe(0);
  });

  it("does not throw when the loader itself fails", () => {
    // `new Image()` does not exist in every environment (a Node test, a worker):
    // the render loop must not die for this, it must draw the placeholder.
    const cache = new ImageCache(() => {
      throw new Error("no Image in this environment");
    });
    expect(cache.get("doc1", HASH).status).toBe("missing");
  });

  it("the singleton exists and is a cache", () => {
    // It is the one the renderer uses: a second `new ImageCache()` per frame
    // would defeat the cache.
    expect(imageCache).toBeInstanceOf(ImageCache);
    expect(imageCache.get("doc1", "").status).toBe("missing");
  });

  it("redraws only when needed: the change notification fires at the end of loading", () => {
    // App.tsx's render loop runs on every frame anyway, but a consumer
    // outside the loop (a test, a future invalidation-based renderer) must be able to
    // know the image has arrived.
    const l = fakeLoader();
    const onChange = vi.fn();
    const cache = new ImageCache(l.load, onChange);
    cache.get("doc1", HASH);
    expect(onChange).not.toHaveBeenCalled();
    settle(l.created[0], true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

// --- recovering from a failure ------------------------------------------------
//
// "Do not retry on every frame" is the right rule for a 60 fps loop, but
// "never retry" is another thing: a restarted server, a 5xx, a
// request in flight when the tab goes to the background would pin
// that node to the placeholder for the whole life of the page -- with the file still
// there on disk, and (as long as the export read this cache) inside the
// exported files too.

function clocked() {
  const l = fakeLoader();
  let now = 1_000;
  const onChange = vi.fn();
  const cache = new ImageCache(l.load, onChange, () => now);
  return { ...l, cache, onChange, tick: (ms: number) => { now += ms; } };
}

describe("ImageCache — recovery from a transient failure", () => {
  it("after the wait it retries, and the image that became reachable again repairs itself", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    expect(c.cache.get("doc1", HASH).status).toBe("missing");

    // One instant before expiry nothing moves.
    c.tick(RETRY_BASE_MS - 1);
    expect(c.cache.get("doc1", HASH).status).toBe("missing");
    expect(c.created.length).toBe(1);

    // Once the wait expires, the request restarts by itself: nobody has to reload the
    // page to see again an image the server has started serving again.
    c.tick(1);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);
    settle(c.created[1], true);
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
  });

  it("even after expiry the loop does not start twice: one request, not sixty", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.tick(RETRY_BASE_MS);
    // 60 frames after expiry: the first restarts, the other 59 read the "loading"
    // entry it created.
    for (let i = 0; i < 60; i++) c.cache.get("doc1", HASH);
    expect(c.created.length).toBe(2);
  });

  it("the wait doubles on every failure, up to a cap", () => {
    // The doubling distinguishes the two cases without having to recognize them: an
    // instantaneous outage recovers in two seconds, an asset that
    // truly is not there ends up costing one request every half minute.
    expect(retryDelay(1)).toBe(RETRY_BASE_MS);
    expect(retryDelay(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelay(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelay(50)).toBe(RETRY_MAX_MS);
    // ...and the cap never becomes "stop": an asset stays recoverable.
    expect(retryDelay(1_000)).toBe(RETRY_MAX_MS);

    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.tick(RETRY_BASE_MS);
    c.cache.get("doc1", HASH);
    settle(c.created[1], false);

    // Second failure: the first wait is no longer enough.
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("missing");
    expect(c.created.length).toBe(2);
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(3);
  });

  it("retryMissing() brings the wait back to the base: the world changed, it is not a third attempt", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.tick(RETRY_BASE_MS);
    c.cache.get("doc1", HASH);
    settle(c.created[1], false); // two failures: the wait would be 4 * BASE

    c.cache.retryMissing();
    c.cache.get("doc1", HASH);
    settle(c.created[2], false);

    // Restarts from the base and not from where it had reached: after an explicit signal
    // ("the network is back") the accumulated wait spoke of a world that is no
    // longer there.
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(4);
  });

  it("retryMissing() retries IMMEDIATELY, without waiting for expiry", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);

    expect(c.cache.retryMissing()).toBe(1);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);
    settle(c.created[1], true);
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
  });

  it("retryMissing() does NOT throw away the images already ready", () => {
    // The name IS the content: the bytes at that URL cannot have changed, and
    // reloading them would be just a flash of placeholder on every photo of the
    // page at every reconnection.
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], true);
    c.cache.get("doc1", OTHER);
    settle(c.created[1], false);

    expect(c.cache.retryMissing()).toBe(1);
    // The ready image is read with no new request...
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
    expect(c.created.length).toBe(2);
    // ...and only the missing one restarts.
    expect(c.cache.get("doc1", OTHER).status).toBe("loading");
    expect(c.created.length).toBe(3);
  });

  it("a FINAL failure is not retried: neither on expiry nor on command", () => {
    // An environment without `new Image()` does not gain one by waiting, and an empty hash
    // has nothing to ask for: retrying would be just noise.
    let calls = 0;
    let now = 0;
    const cache = new ImageCache(
      () => { calls++; throw new Error("no Image in this environment"); },
      () => {},
      () => now,
    );
    expect(cache.get("doc1", HASH).status).toBe("missing");
    now += RETRY_MAX_MS * 10;
    expect(cache.get("doc1", HASH).status).toBe("missing");
    expect(cache.retryMissing()).toBe(0);
    expect(cache.get("doc1", HASH).status).toBe("missing");
    expect(calls).toBe(1);

    expect(cache.get("doc1", "").status).toBe("missing");
    expect(calls).toBe(1);
  });

  it("the response of an abandoned request does not erase the new attempt", () => {
    // Between the start and the response a retryMissing() and a
    // second attempt may have slipped in: the error that arrives late from the first must not
    // bring back to "missing" an image that is arriving in the meantime.
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.cache.retryMissing();
    c.cache.get("doc1", HASH); // second attempt, in flight

    settle(c.created[0], false); // the OLD response arrives now
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    settle(c.created[1], true);
    expect(c.cache.get("doc1", HASH).status).toBe("ready");
  });

  it("a load with null dimensions is recoverable: a truncated response arrives like this", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    c.created[0].onload?.(); // load, ma 0x0
    expect(c.cache.get("doc1", HASH).status).toBe("missing");
    c.tick(RETRY_BASE_MS);
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);
  });

  it("retrying notifies the redraw, and retrying nothing does not notify it", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);
    c.onChange.mockClear();

    c.cache.retryMissing();
    expect(c.onChange).toHaveBeenCalledTimes(1);
    c.onChange.mockClear();
    c.cache.retryMissing();
    expect(c.onChange).not.toHaveBeenCalled();
  });
});

describe("attachImageRecovery", () => {
  function fakeTarget() {
    const listeners = new Map<string, () => void>();
    return {
      listeners,
      addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
      removeEventListener: (type: string, fn: () => void) => {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
    };
  }

  it("the network back and the tab back in the foreground retry; hidden does not", () => {
    const c = clocked();
    c.cache.get("doc1", HASH);
    settle(c.created[0], false);

    const win = fakeTarget();
    const doc = { ...fakeTarget(), visibilityState: "hidden" };
    const detach = attachImageRecovery(c.cache, win, doc);

    // Hidden: the browser draws nothing, retrying now would mean
    // spending a request for a frame nobody will see.
    doc.listeners.get("visibilitychange")?.();
    expect(c.created.length).toBe(1);

    doc.visibilityState = "visible";
    doc.listeners.get("visibilitychange")?.();
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(2);

    settle(c.created[1], false);
    win.listeners.get("online")?.();
    expect(c.cache.get("doc1", HASH).status).toBe("loading");
    expect(c.created.length).toBe(3);

    detach();
    expect(win.listeners.size).toBe(0);
    expect(doc.listeners.size).toBe(0);
  });

  it("attaches on the shared cache and the real window, without arguments", () => {
    // It is how App.tsx calls it: a single `useEffect`, no parameters.
    const detach = attachImageRecovery();
    expect(() => window.dispatchEvent(new Event("online"))).not.toThrow();
    detach();
  });
});
