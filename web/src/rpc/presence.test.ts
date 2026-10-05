import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { PresenceEventSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { usePresence } from "../store/presence";

// A stream controllable by hand: the test decides when events arrive.
function makeStream(signal?: AbortSignal) {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  // Like fetch: an abort makes the iteration fail.
  signal?.addEventListener("abort", () => { done = true; wake?.(); });
  return {
    push(ev: unknown) { queue.push(ev); wake?.(); },
    end() { done = true; wake?.(); },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) { yield queue.shift(); continue; }
          if (done) return;
          await new Promise<void>((r) => { wake = r; });
          wake = null;
        }
      },
    },
  };
}

const watchPresence = vi.fn();
const updatePresence = vi.fn(async (_req: unknown) => ({}));
vi.mock("./client", () => ({
  docClient: { watchPresence: (...a: unknown[]) => watchPresence(...a), updatePresence: (req: unknown) => updatePresence(req) },
}));

import { PresenceClient } from "./presence";

const ready = () => create(PresenceEventSchema, {});
const joined = (id: string) =>
  create(PresenceEventSchema, { kind: { case: "update", value: { clientId: id, nickname: id } } } as never);

const flushMicro = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("PresenceClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchPresence.mockReset();
    updatePresence.mockClear();
    usePresence.getState().clear();
  });
  afterEach(() => vi.useRealTimers());

  it("sends nothing until the server says 'ready', then sends the local state", async () => {
    const s = makeStream();
    watchPresence.mockReturnValue(s.iterable);
    const c = new PresenceClient("doc", "me", "Ada");
    c.start();
    c.setLocal({ hasCursor: true, cursorX: 3, cursorY: 4, selection: ["n1"], pageId: "p1" });
    await vi.advanceTimersByTimeAsync(200);
    expect(updatePresence).not.toHaveBeenCalled();

    s.push(ready());
    await vi.advanceTimersByTimeAsync(200);
    expect(updatePresence).toHaveBeenCalledTimes(1);
    expect(updatePresence.mock.calls[0][0]).toMatchObject({
      docId: "doc",
      state: { clientId: "me", hasCursor: true, cursorX: 3, cursorY: 4, selection: ["n1"], pageId: "p1" },
    });
    c.stop();
  });

  it("batches a burst of movements: the last value wins, at most one every 50 ms", async () => {
    const s = makeStream();
    watchPresence.mockReturnValue(s.iterable);
    const c = new PresenceClient("doc", "me", "Ada");
    c.start();
    s.push(ready());
    await vi.advanceTimersByTimeAsync(100);
    updatePresence.mockClear();

    for (let i = 1; i <= 30; i++) c.setLocal({ hasCursor: true, cursorX: i, cursorY: i });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(updatePresence.mock.calls.length).toBeLessThanOrEqual(2);
    const last = updatePresence.mock.calls.at(-1)![0] as { state: { cursorX: number } };
    expect(last.state.cursorX).toBe(30);
    c.stop();
  });

  it("peer events end up in the store and stop() empties it", async () => {
    const s = makeStream();
    watchPresence.mockReturnValue(s.iterable);
    const c = new PresenceClient("doc", "me", "Ada");
    c.start();
    s.push(ready());
    s.push(joined("bob"));
    await vi.advanceTimersByTimeAsync(10);
    expect(Object.keys(usePresence.getState().peers)).toEqual(["bob"]);
    c.stop();
    expect(usePresence.getState().peers).toEqual({});
  });

  it("if the stream drops it retries on its own and empties the peers in the meantime", async () => {
    const first = makeStream();
    const second = makeStream();
    watchPresence.mockReturnValueOnce(first.iterable).mockReturnValue(second.iterable);
    const c = new PresenceClient("doc", "me", "Ada");
    c.start();
    first.push(ready());
    first.push(joined("bob"));
    await vi.advanceTimersByTimeAsync(10);
    expect(Object.keys(usePresence.getState().peers)).toEqual(["bob"]);

    first.end();
    await flushMicro();
    expect(usePresence.getState().peers).toEqual({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchPresence).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it("changing the nickname reopens the stream with the new name", async () => {
    watchPresence.mockImplementation((_req: unknown, opts?: { signal?: AbortSignal }) => makeStream(opts?.signal).iterable);
    const c = new PresenceClient("doc", "me", "Ada");
    c.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watchPresence.mock.calls[0][0]).toMatchObject({ nickname: "Ada" });
    c.setNickname("Bea");
    await vi.advanceTimersByTimeAsync(10);
    expect(watchPresence.mock.calls.at(-1)![0]).toMatchObject({ nickname: "Bea" });
    c.stop();
  });

  it("a network error does not blow up: no unhandled exception", async () => {
    watchPresence.mockImplementation(() => { throw new Error("network"); });
    const c = new PresenceClient("doc", "me", "Ada");
    c.start();
    await vi.advanceTimersByTimeAsync(2_000);
    c.stop();
    expect(watchPresence).toHaveBeenCalled();
  });
});
