import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { DocumentSchema, NodeSchema, OpSchema, ServerMsgSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node as PbNode, Op, ServerMsg } from "../gen/opendesigner/v1/opendesigner_pb";

// Double of the Connect transport: SyncClient imports `docClient` from ./client, and
// that is the only point where it touches the network. vi.hoisted because the factory of
// vi.mock is hoisted above the imports.
const rpc = vi.hoisted(() => ({
  openDocument: vi.fn(),
  submitOp: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("./client", () => ({ docClient: rpc }));

import { MAX_OUTBOX, SyncClient } from "./syncClient";
import { useScene } from "../store/store";

const CLIENT = "client-A";
const OTHER = "client-B";

function rectNode(id: string, x: number, y: number): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
}

function moveOp(opId: string, id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } },
    },
  });
}

function createOp(opId: string, id: string): Op {
  return create(OpSchema, {
    opId, docId: "doc1",
    kind: { case: "createNode", value: { node: rectNode(id, 0, 0) } },
  });
}

function applied(seq: number, clientId: string, op: Op): ServerMsg {
  return create(ServerMsgSchema, {
    kind: { case: "applied", value: { seq: BigInt(seq), clientId, op } },
  });
}

// Server->client stream drivable by hand: `push` delivers a record to the consume()
// loop, `close` makes it end at the end of the test (otherwise it would stay hanging
// on a promise nobody resolves), `fail` makes it DIE with an error --
// exactly the two ways the server ends it on its own initiative
// (subscriber too slow, since_seq out of range).
//
// Records already queued stay deliverable even after `close`: it is the real
// case in which a message has already arrived in the buffer when the client decides
// to detach, and it is the only way to verify that it is the CLIENT refusing to
// apply it (guard on stop) and not the transport no longer delivering it.
function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let failure: unknown = null;
  return {
    push(v: T) {
      queue.push(v);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    fail(err: unknown) {
      failure = err;
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as T;
        if (failure) throw failure;
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

// One macrotask turn: enough to run both the microtask chains
// (submitOp.then/.catch) and the for-await's wake-up on channel.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Deterministic wait of `n` microtask turns. Two chains started
// together end in order of LENGTH, not of start: it is the way (without
// timers, hence without flakiness) to simulate a network that delivers requests
// out of order.
function turns(n: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

// ADVERSARIAL transport. The server assigns the seq in order of ARRIVAL
// (internal/server/hub.go: Submit serializes on the mutex, whoever arrives first
// wins), so the persisted order is the one in which requests reach
// the hub -- NOT the one in which the client emitted them. Here every request
// "travels" for a DECREASING number of turns: if the client leaves more than
// one in flight together, they arrive in INVERTED order. The only way to make
// ops arrive in send order is to send one at a time.
const TRAVEL = 32; // > the number of ops used in the tests, so the turns stay positive

function reorderingTransport() {
  const arrived: string[] = [];
  const failures = new Map<string, unknown>();
  let dispatched = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let seq = 0;
  // mockReset: throws away boot()'s mockResolvedValue and any *Once queue
  // left by a previous test, so the implementation below is
  // the only one that answers.
  rpc.submitOp.mockReset();
  rpc.submitOp.mockImplementation(async (req: { op: Op }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await turns(TRAVEL - dispatched++);
    inFlight -= 1;
    arrived.push(req.op.opId);
    const err = failures.get(req.op.opId);
    if (err) throw err;
    return { ack: { opId: req.op.opId, seq: BigInt(++seq) } };
  });
  return {
    arrived,
    failOn: (opId: string, err: unknown) => failures.set(opId, err),
    maxInFlight: () => maxInFlight,
  };
}

function snapshotOf(nodes: Record<string, PbNode>) {
  return create(DocumentSchema, {
    id: "doc1", name: "Untitled", schemaVersion: 1,
    pages: [{ id: "page1", name: "Page 1" }], nodes,
  });
}

// The live client of the current test. Every SyncClient keeps a stream open and
// (since the lifecycle fix) reconnection timers: without a stop in
// afterEach a client would outlive its own test and keep
// reconnecting INSIDE the next one, writing into the same global store.
let live: SyncClient | null = null;

function resetStore() {
  useScene.setState({
    scene: null, confirmed: null, pending: [], lastError: null, syncError: null,
    notice: null, disowned: [],
    connection: "connecting",
    selection: [], marquee: null, gesture: null, sync: null,
    undoStack: [], redoStack: [], canUndo: false, canRedo: false, history: [],
  });
}

async function boot(nodes: Record<string, PbNode>) {
  const stream = channel<ServerMsg>();
  rpc.openDocument.mockResolvedValue({ snapshot: snapshotOf(nodes), seq: 0n });
  rpc.subscribe.mockReset();
  rpc.subscribe.mockReturnValue(stream);
  rpc.submitOp.mockResolvedValue({ ack: { opId: "", seq: 1n } });
  const sync = new SyncClient("doc1", CLIENT);
  live = sync;
  await sync.start();
  await flush();
  return { sync, stream };
}

describe("SyncClient: confirmed/pending model", () => {
  // The console.error stays (it serves the developer) but is no longer the ONLY
  // place where failures end up: here we silence them and verify them.
  // Shared spy because every test closes its own stream at the end, and the
  // closure is in itself a failure that must be logged.
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    resetStore();
  });

  afterEach(() => {
    live?.stop();
    live = null;
    logged.mockRestore();
  });

  it("an op REJECTED by the server disappears from the view and reports the error", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    let rejectSubmit!: (e: unknown) => void;
    rpc.submitOp.mockReturnValueOnce(
      new Promise((_res, rej) => {
        rejectSubmit = rej;
      }),
    );

    sync.submit(moveOp("op-mine", "n1", 999, 999));
    // Optimistic apply: the change shows right away, before any response.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 999, y: 999 });

    rejectSubmit(new Error("node already exists"));
    await flush();

    // The server never accepted it: the change MUST disappear (in M0 it stayed
    // on screen forever, lost on the next reload).
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().pending).toHaveLength(0);
    // ...and the failure must be VISIBLE, not just a console.error.
    expect(useScene.getState().lastError).toContain("node already exists");
    expect(logged).toHaveBeenCalled();

    stream.close();
    await flush();
  });

  it("a remote op arrived while one's own is in flight does NOT crush the optimistic change (rebase)", async () => {
    const { sync, stream } = await boot({
      n1: rectNode("n1", 0, 0),
      n2: rectNode("n2", 0, 0),
    });

    let resolveSubmit!: (v: unknown) => void;
    rpc.submitOp.mockReturnValueOnce(
      new Promise((res) => {
        resolveSubmit = res;
      }),
    );

    sync.submit(moveOp("op-mine", "n1", 200, 0));

    // The other client won the race: ITS records arrive before our
    // echo. The record on n1 is ordered BEFORE our op.
    stream.push(applied(1, OTHER, moveOp("op-them-1", "n1", 100, 0)));
    stream.push(applied(2, OTHER, moveOp("op-them-2", "n2", 333, 0)));
    await flush();

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333 }); // the remote change is not lost
    expect(scene.nodes.at("n1")).toMatchObject({ x: 200 }); // ...nor is ours

    // Then our echo arrives: the op becomes confirmed and the queue empties.
    resolveSubmit({ ack: { opId: "op-mine", seq: 3n } });
    stream.push(applied(3, CLIENT, moveOp("op-mine", "n1", 200, 0)));
    await flush();

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().pending).toHaveLength(0);

    stream.close();
    await flush();
  });

  it("the own echo confirms the op only ONCE and does not reapply it on top of subsequent records", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    sync.submit(moveOp("op-mine", "n1", 200, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(1);

    // The echo of the OWN op must not be discarded: it is what makes it confirmed.
    stream.push(applied(1, CLIENT, moveOp("op-mine", "n1", 200, 0)));
    await flush();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 200 });

    // A subsequent remote record must be able to overwrite: if the confirmed op
    // had also stayed in the queue, the rebase would reapply it on top and n1
    // would go back to 200 -- double application of the same op.
    stream.push(applied(2, OTHER, moveOp("op-them", "n1", 50, 0)));
    await flush();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 50 });

    stream.close();
    await flush();
  });

  // --- death of the stream ---------------------------------------------------
  // Subscribe is the ONLY thing that advances the confirmed state and empties the queue
  // of in-flight ops: its death cannot stay invisible. Before this
  // fix `void this.consume()` had neither catch nor try/catch, so the end
  // of the stream was an unhandled rejection and NOTHING ELSE -- confirmed state
  // frozen, queue growing with every gesture, and the status pill
  // still saying "connected".

  it("a stream that DIES does not stay silent", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    expect(useScene.getState().syncError).toBeNull();

    // Real case: Subscribe answers CodeOutOfRange when since_seq is older
    // than the now-compacted history (the other is the hub closing a
    // too-slow subscriber). Both start from the SERVER: no network
    // drop is needed for it to happen.
    stream.fail(new ConnectError("since_seq too old", Code.OutOfRange));
    await flush();

    expect(useScene.getState().syncError).toContain("since_seq too old");
    expect(logged).toHaveBeenCalled();

    // From here on no echo can confirm anything anymore: the op stays queued
    // forever. It is the wedge -- which is now OBSERVABLE however ("disconnected"
    // pill + banner in App.tsx) instead of silent.
    sync.submit(moveOp("op-mine", "n1", 200, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(1);
    expect(useScene.getState().syncError).not.toBeNull();
  });

  it("a stream CLOSED by the server is a failure like the others", async () => {
    const { stream } = await boot({ n1: rectNode("n1", 0, 0) });

    // "Clean" end of the for-await: no exception, but the result for the
    // client is identical -- no more records will ever arrive.
    stream.close();
    await flush();

    expect(useScene.getState().syncError).toContain("stream");
    expect(logged).toHaveBeenCalled();
  });

  // --- send order ------------------------------------------------------------
  // The seq is assigned by the SERVER in order of arrival, so the persisted order
  // is decided by the network and not by the user. With fire-and-forget submit several
  // requests are in flight together and the reloaded document can legitimately
  // differ from the one on screen: op19 (x=100) and op20 (x=200) started
  // together, op20 arriving first, oplog [x=200, x=100], reload at x=100
  // while the canvas shows 200.

  it("CONCURRENT submits reach the server in SEND ORDER", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();

    // Five changes in quick succession (two close gestures, or an undo
    // right after a drag): the user's intent IS this order, and x=500 must
    // be the last thing the server persists.
    const ids = ["op-1", "op-2", "op-3", "op-4", "op-5"];
    ids.forEach((opId, i) => sync.submit(moveOp(opId, "n1", (i + 1) * 100, 0)));
    await flush();

    expect(net.arrived).toEqual(ids);
    // ...and the way to get there: a single request in flight at a time.
    // Without this, the order would only be a coincidence of the scheduler.
    expect(net.maxInFlight()).toBe(1);

    stream.close();
    await flush();
  });

  it("if an op FAILS the queue STOPS: the following ones never go out", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();
    net.failOn("op-2", new ConnectError("node already exists", Code.InvalidArgument));

    sync.submit(moveOp("op-1", "n1", 100, 0));
    sync.submit(moveOp("op-2", "n1", 200, 0));
    sync.submit(moveOp("op-3", "n1", 300, 0));
    sync.submit(moveOp("op-4", "n1", 400, 0));
    // Optimistic apply: all four show right away.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 400 });
    await flush();

    // op-3 and op-4 were built on a state (x=200) the server never
    // reached: sending them would mean persisting a change based on a
    // false premise. They do not go out.
    expect(net.arrived).toEqual(["op-1", "op-2"]);
    expect(rpc.submitOp).toHaveBeenCalledTimes(2);

    // op-1 went through and stays in flight waiting for its echo; op-2 (rejected) and
    // the queue behind it leave the view.
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-1"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 100 });
    expect(useScene.getState().lastError).toContain("node already exists");
    expect(logged).toHaveBeenCalled();

    stream.close();
    await flush();
  });

  // Hub.Submit takes writeMu, appends, and BROADCASTS to subscribers BEFORE
  // writing the unary's response (internal/server/hub.go). If the
  // connection dies in that window the client sees a request fail
  // that on the server actually succeeded -- and the echo proves it, because it
  // has already arrived.
  it("a submit that fails AFTER the server has already applied the op does not drag the queue down", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    const sent: string[] = [];
    let killFirst!: (e: unknown) => void;
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation((req: { op: Op }) => {
      sent.push(req.op.opId);
      if (req.op.opId === "op-1") {
        return new Promise((_res, rej) => {
          killFirst = rej;
        });
      }
      return Promise.resolve({ ack: { opId: req.op.opId, seq: 2n } });
    });

    sync.submit(moveOp("op-1", "n1", 100, 0));
    sync.submit(moveOp("op-2", "n1", 200, 0));
    await flush();
    expect(sent).toEqual(["op-1"]); // op-2 waits its turn

    // The broadcast has already passed: op-1 is in the op-log, so DURABLE.
    stream.push(applied(1, CLIENT, moveOp("op-1", "n1", 100, 0)));
    await flush();
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-2"]);

    // ...and only NOW does the HTTP response die.
    killFirst(new ConnectError("connection closed", Code.Unavailable));
    await flush();

    // The premise of op-2 ("op-1 is on the server") is TRUE: stopping it would throw
    // away valid work and would show an error for a successful op.
    expect(sent).toEqual(["op-1", "op-2"]);
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-2"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().lastError).toBeNull();
    expect(logged).toHaveBeenCalled(); // it still ends up in the console

    stream.close();
    await flush();
  });

  // --- deadline and queue cap ------------------------------------------------
  // With the serialized outbox a request that never resolves no longer loses
  // only itself: it blocks the head, and every subsequent gesture is
  // applied optimistically, queued and never sent -- with nothing
  // signaling it (empty lastError, syncError concerns only Subscribe, pill
  // "connected").

  it("a submit that NEVER RESOLVES does not block the queue forever: there is a deadline", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    // Transport that HONORS the call's deadline (like the real one:
    // CallOptions.timeoutMs) and otherwise never answers -- blocked
    // handler, connection vanished into nothing, suspended laptop.
    const sent: { opId: string; timeoutMs?: number }[] = [];
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation(
      (req: { op: Op }, opts?: { timeoutMs?: number }) =>
        new Promise((_res, rej) => {
          sent.push({ opId: req.op.opId, timeoutMs: opts?.timeoutMs });
          if (opts?.timeoutMs && opts.timeoutMs > 0) {
            setTimeout(
              () => rej(new ConnectError("the operation timed out", Code.DeadlineExceeded)),
              opts.timeoutMs,
            );
          }
        }),
    );

    vi.useFakeTimers();
    try {
      sync.submit(moveOp("op-1", "n1", 100, 0));
      await vi.advanceTimersByTimeAsync(0);
      // Without a requested deadline the promise stays hanging and the drain
      // NEVER restarts: it is the only thing that makes the block finite.
      expect(sent[0].timeoutMs).toBeGreaterThan(0);

      // Meanwhile the user keeps working: everything queues, nothing goes out.
      sync.submit(moveOp("op-2", "n1", 200, 0));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(1);
      expect(useScene.getState().pending).toHaveLength(2);

      // Once the deadline expires the request dies: the wedge becomes an
      // observable failure instead of lasting forever in silence.
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(useScene.getState().lastError).toContain("timed out");
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });

    stream.close();
    await flush();
  });

  it("the queue has a CAP: the work at risk stays finite and the block visible", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });

    // Worst case: head blocked and not even the deadline saves it (network that
    // does not answer and stopped timers). Only the cap limits the damage.
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation(() => new Promise(() => {}));

    for (let i = 0; i < MAX_OUTBOX; i++) sync.submit(moveOp(`op-${i}`, "n1", i + 1, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(MAX_OUTBOX);
    expect(useScene.getState().lastError).toBeNull();

    // The op that breaks the cap does not enter: it is rejected right away, with the same
    // rollback and the same banner as a server rejection. Those already queued
    // stay -- they are the oldest intent and can still go out.
    sync.submit(moveOp("op-over", "n1", 999, 0));
    await flush();

    expect(useScene.getState().pending).toHaveLength(MAX_OUTBOX);
    expect(useScene.getState().pending.some((p) => p.opId === "op-over")).toBe(false);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: MAX_OUTBOX });
    expect(useScene.getState().lastError).toContain("too many pending changes");

    stream.close();
    await flush();
  });

  // --- history and rollback --------------------------------------------------
  // endGesture pushes the undo entry BEFORE sending the op: if the tail-drop
  // discards N gestures, without repair N undo entries remain whose inverses
  // invert a state the server never had.

  it("a failure that discards the queue rewinds the undo entries of the WHOLE burst", async () => {
    const { stream } = await boot({});
    const net = reorderingTransport();
    net.failOn("op-a", new ConnectError("node already exists", Code.InvalidArgument));

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([createOp("op-a", "n1")]);
    st.beginGesture();
    st.endGesture([createOp("op-b", "n2")]);
    // The entries are there right away: Ctrl+Z cannot wait for the network round.
    expect(useScene.getState().undoStack).toHaveLength(2);
    await flush();

    // op-a rejected, op-b discarded with it: neither node exists, and
    // neither undo entry makes sense anymore -- undoing them would send
    // deleteNode of nodes the server never saw (ErrNodeNotFound), one
    // at a time, burning the entries of the REAL gestures below.
    expect(net.arrived).toEqual(["op-a"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at("n2")).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);

    stream.close();
    await flush();
  });

  // The tail-drop works per OP, the gesture is the unit of UNDO: the two granules do not
  // coincide, and multi-op gestures are the norm (selectTool sends a setProps
  // per selected node on drag and resize, a deleteNode per node on
  // Delete). If the queue stops mid-group, the front part is already durable:
  // throwing away the whole undo entry would make that part NOT undoable.
  it("a MULTI-OP gesture stopped halfway keeps the undo entry of the part that went through", async () => {
    const { stream } = await boot({
      n1: rectNode("n1", 0, 0),
      n2: rectNode("n2", 300, 0),
    });
    const net = reorderingTransport();
    net.failOn("op-b", new ConnectError("connection closed", Code.Unavailable));

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([moveOp("op-a", "n1", 40, 40), moveOp("op-b", "n2", 340, 40)]);
    expect(useScene.getState().undoStack).toHaveLength(1);
    await flush();

    // op-a went through (200 OK) and its echo has not arrived yet; op-b dies.
    expect(net.arrived).toEqual(["op-a", "op-b"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 300, y: 0 });

    // The entry survives, narrowed to the op that is really on the server.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().undoStack[0]).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);

    // The echo arriving AFTER the rejection does not erase it: before the fix the mark had
    // already disappeared and the confirmation became a no-op.
    stream.push(applied(1, CLIENT, moveOp("op-a", "n1", 40, 40)));
    await flush();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });

    stream.close();
    await flush();
  });

  // Someone ELSE's record does not only advance the document: it can invalidate
  // the undo/redo entries concerning the nodes it touches
  // (store.ts::markStale). It is the ONLY place where a record's provenance
  // matters -- applying it is done anyway, echoes included -- and here it is read
  // from the clientId, which is the proof that the record is not ours.
  it("a record from ANOTHER client invalidates the undo entries on that node", async () => {
    const { stream } = await boot({ n1: rectNode("n1", 0, 0) });

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([moveOp("op-1", "n1", 40, 40)]);
    await flush();
    // Our echo: confirms the op and does NOT touch the history (it is ours, by clientId
    // and because it is still queued).
    stream.push(applied(1, CLIENT, moveOp("op-1", "n1", 40, 40)));
    await flush();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Another client moves n1 elsewhere. The undo entry would put (0,0) back
    // on top of their change, silently: it is no longer valid.
    stream.push(applied(2, OTHER, moveOp("op-them", "n1", 500, 500)));
    await flush();

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 500, y: 500 });
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().notice).not.toBeNull();

    stream.close();
    await flush();
  });

  it("the stop is for the queue, not for the client: a subsequent submit restarts", async () => {
    const { sync, stream } = await boot({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();
    net.failOn("op-1", new ConnectError("disk full", Code.InvalidArgument));

    sync.submit(moveOp("op-1", "n1", 100, 0));
    await flush();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });

    // The rollback brought the view back to what the server REALLY has: a
    // subsequent op is built on a true premise and must be sent. Latching the
    // client forever at the first InvalidArgument (a duplicate id, say)
    // would mean freezing the editor.
    sync.submit(moveOp("op-2", "n1", 700, 0));
    await flush();

    expect(net.arrived).toEqual(["op-1", "op-2"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 700 });

    stream.close();
    await flush();
  });
});

// ---------------------------------------------------------------------------
// LIFECYCLE of the stream: abort, reconnection, gap.
//
// Subscribe is the only thing that advances the confirmed document, and the
// backend CLOSES on its own initiative the stream of a subscriber that fell behind
// (internal/server/hub.go: the full channel does endSubscriberLocked) precisely
// so that the client reconnects with since_seq at the last applied record and
// catches up on the backlog. Without reconnection this design does not work: the
// first somewhat dense burst detaches the client for the rest of the session.
//
// Here every call to Subscribe opens a NEW channel, so the tests can
// look at how many subscriptions exist, from which since_seq they restart and whether the
// previous transport was really aborted.
describe("SyncClient: stream lifecycle", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  let warned: ReturnType<typeof vi.spyOn>;

  // Longer than a reconnection's maximum backoff and shorter than the
  // window beyond which a stream is considered "stable" (and so the
  // attempts budget resets): an advance of this length
  // triggers exactly one attempt.
  const RETRY_WINDOW = 15_000;

  interface Opened {
    since: bigint;
    signal: AbortSignal | undefined;
    stream: ReturnType<typeof channel<ServerMsg>>;
  }

  function liveStreams(): Opened[] {
    const opened: Opened[] = [];
    rpc.subscribe.mockReset();
    rpc.subscribe.mockImplementation(
      (req: { sinceSeq: bigint }, opts?: { signal?: AbortSignal }) => {
        const stream = channel<ServerMsg>();
        // The real transport dies when the signal is aborted: here the
        // double does the same, so "aborted" and "stream ended" stay linked
        // as in reality.
        opts?.signal?.addEventListener("abort", () => stream.close());
        opened.push({ since: req.sinceSeq, signal: opts?.signal, stream });
        return stream;
      },
    );
    return opened;
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);

  async function bootLive(nodes: Record<string, PbNode>, seq = 0) {
    rpc.openDocument.mockResolvedValue({ snapshot: snapshotOf(nodes), seq: BigInt(seq) });
    rpc.submitOp.mockResolvedValue({ ack: { opId: "", seq: 1n } });
    const opened = liveStreams();
    const sync = new SyncClient("doc1", CLIENT);
    live = sync;
    await sync.start();
    await settle();
    return { sync, opened };
  }

  const last = (opened: Opened[]) => opened[opened.length - 1];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetStore();
  });

  afterEach(() => {
    live?.stop();
    live = null;
    vi.useRealTimers();
    logged.mockRestore();
    warned.mockRestore();
  });

  it("a stream CLOSED by the server restarts the subscription from the last applied seq", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });
    expect(opened).toHaveLength(1);
    expect(opened[0].since).toBe(0n);
    expect(useScene.getState().connection).toBe("connected");

    last(opened).stream.push(applied(1, OTHER, moveOp("op-them-1", "n1", 100, 0)));
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 100 });

    // The subscriber fell behind: the hub closes the channel. In M0 the client
    // simply stopped receiving for the rest of the session.
    last(opened).stream.close();
    await settle();
    expect(useScene.getState().connection).toBe("reconnecting");
    // ...but not in a tight loop: a server restart must not turn
    // into a burst of POSTs.
    expect(opened).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
    expect(opened).toHaveLength(2);
    // THE point: we restart from AFTER the last applied record (since_seq is
    // exclusive, hub.go: `rec.Seq > sinceSeq`), not from scratch and not from the future.
    expect(opened[1].since).toBe(1n);
    expect(useScene.getState().connection).toBe("connected");
    expect(useScene.getState().syncError).toBeNull();

    // And the new subscription is really alive.
    last(opened).stream.push(applied(2, OTHER, moveOp("op-them-2", "n1", 200, 0)));
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
  });

  it("a GAP in the sequence is not silently accepted: it resynchronizes from the last good seq", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    last(opened).stream.push(applied(1, OTHER, moveOp("op-1", "n1", 100, 0)));
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 100 });

    // seq 2 never arrived. Applying 3 would mean proceeding with a
    // document missing an op: if the gap contained a CreateNode, every
    // subsequent SetProps on that node is swallowed by applyOp and the shape
    // no longer appears (and nobody notices).
    last(opened).stream.push(applied(3, OTHER, moveOp("op-3", "n1", 300, 0)));
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 100 });
    expect(logged).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
    expect(opened).toHaveLength(2);
    // We restart from the last GOOD seq, so the server resends the missing
    // record together with those after it.
    expect(opened[1].since).toBe(1n);
    expect(opened[0].signal!.aborted).toBe(true);

    last(opened).stream.push(applied(2, OTHER, moveOp("op-2", "n1", 200, 0)));
    last(opened).stream.push(applied(3, OTHER, moveOp("op-3", "n1", 300, 0)));
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 300 });
    expect(useScene.getState().connection).toBe("connected");
  });

  it("stop() detaches the transport and prevents any further store mutation", async () => {
    const { sync, opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    // Record already in the transport's buffer when the user leaves the page (or
    // React unmounts the component): the client must refuse to apply it.
    last(opened).stream.push(applied(1, OTHER, moveOp("op-them", "n1", 999, 0)));
    sync.stop();
    await settle();

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });
    // ...and the transport was ABORTED, not just ignored: without the signal the
    // HTTP request stays open and the server keeps holding the subscriber.
    expect(opened[0].signal!.aborted).toBe(true);
    // No stop turned into a reconnection: a stopped client stays stopped.
    expect(useScene.getState().connection).not.toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(RETRY_WINDOW * 4);
    expect(opened).toHaveLength(1);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });

    // The other half too: an op submitted on a stopped client must not
    // enter the view. Nobody would send it (the queue is stopped) and in
    // StrictMode the store now belongs to ANOTHER client: it would stay in `pending`
    // forever, visible and never confirmed by anything.
    sync.submit(moveOp("op-late", "n1", 42, 0));
    await settle();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });
    expect(rpc.submitOp).not.toHaveBeenCalled();
  });

  it("two consecutive start() calls (StrictMode) leave ONE single subscription", async () => {
    rpc.openDocument.mockResolvedValue({
      snapshot: snapshotOf({ n1: rectNode("n1", 0, 0) }), seq: 0n,
    });
    const opened = liveStreams();
    const sync = new SyncClient("doc1", CLIENT);
    live = sync;

    // StrictMode invokes the effect twice: before the fix the second start()
    // opened a second stream (two goroutines on the server, two copies of every
    // record applied in the same global store).
    await Promise.all([sync.start(), sync.start()]);
    await settle();

    expect(opened).toHaveLength(1);
    expect(rpc.subscribe).toHaveBeenCalledTimes(1);
  });

  it("PENDING ops survive a reconnection and are not applied twice", async () => {
    const { sync, opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    sync.submit(moveOp("op-mine", "n1", 200, 0));
    await settle();
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-mine"]);

    // The stream dies BEFORE the echo comes back: the op is not confirmed but
    // may well already be in the op-log (Hub.Submit broadcasts before
    // answering). Throwing it away would invent a rollback nobody asked for.
    last(opened).stream.close();
    await settle();
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-mine"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });

    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
    expect(opened).toHaveLength(2);
    // Nothing is confirmed yet: we restart from 0.
    expect(opened[1].since).toBe(0n);

    // The backlog replays the in-flight op's echo: it is its CONFIRMATION, not a
    // second application -- it must leave the queue.
    last(opened).stream.push(applied(1, CLIENT, moveOp("op-mine", "n1", 200, 0)));
    await settle();
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 200 });

    // If it had stayed queued, the rebase would put it back on top of every subsequent
    // record and this remote move would never show.
    last(opened).stream.push(applied(2, OTHER, moveOp("op-them", "n1", 50, 0)));
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 50 });
  });

  it("reconnection is not infinite: after a cap of attempts it gives up and declares it", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    // Server down: every attempt dies right away. Retrying forever
    // would drain battery and hide the problem behind a pill that
    // says "reconnecting" for half an hour.
    let guard = 0;
    while (useScene.getState().connection !== "error" && guard < 40) {
      last(opened).stream.fail(new ConnectError("connection refused", Code.Unavailable));
      await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
      guard += 1;
    }

    expect(useScene.getState().connection).toBe("error");
    expect(useScene.getState().syncError).toContain("connection refused");
    expect(opened.length).toBeGreaterThan(1); // it really retried...
    expect(opened.length).toBeLessThanOrEqual(20); // ...but not forever

    const attempts = opened.length;
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW * 10);
    expect(opened).toHaveLength(attempts);
  });

  // --- mid-session resynchronization -----------------------------------------
  // The CodeOutOfRange branch is the first place where setScene is called with
  // a document ALREADY LIVE underneath: there is an in-flight queue, a doubtful history and --
  // outside the store -- an outbox. Emptying only part of that stuff
  // misaligns them, and the misalignment is not visible until the
  // response of the request left in flight arrives.
  //
  // It is not a lab case: the hub compacts every 256 ops
  // (internal/server/hub.go, snapshotEveryOps) and a restarted hub starts with
  // historyBase at the loaded seq (internal/server/bundle.go), so any
  // client that resumes from further back ends up in it.

  it("a resynchronization also empties the OUTBOX: the queue behind does not go out for a ghost", async () => {
    const { sync, opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    const sent: string[] = [];
    let killFirst!: (e: unknown) => void;
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation((req: { op: Op }) => {
      sent.push(req.op.opId);
      if (req.op.opId === "op-1") {
        return new Promise((_res, rej) => {
          killFirst = rej;
        });
      }
      return Promise.resolve({ ack: { opId: req.op.opId, seq: 2n } });
    });

    sync.submit(moveOp("op-1", "n1", 100, 0));
    sync.submit(moveOp("op-2", "n1", 200, 0));
    await settle();
    expect(sent).toEqual(["op-1"]); // op-2 waits its turn
    expect(useScene.getState().pending).toHaveLength(2);

    // The history we wanted to restart from was compacted: the only way
    // out is to reopen the document and adopt its snapshot.
    rpc.openDocument.mockResolvedValue({
      snapshot: snapshotOf({ n1: rectNode("n1", 7, 0) }), seq: 42n,
    });
    last(opened).stream.fail(new ConnectError("since_seq too old", Code.OutOfRange));
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);

    // The snapshot replaced the document: the two optimistic changes
    // vanished from the canvas. The user must be able to READ it somewhere --
    // before this fix they vanished with `lastError` null and the pill on
    // "connected", that is without any explanation anywhere.
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 7 });
    expect(useScene.getState().lastError).not.toBeNull();

    // ...and only NOW does op-1's request die. `pending` is empty, so
    // `landed()` ("it is no longer queued, so the server has it") would say yes
    // for an op that never left the browser, and op-2 -- built on
    // x=100, a state the server never had -- would go out anyway,
    // silently and durably.
    killFirst(new ConnectError("connection closed", Code.Unavailable));
    await settle();

    expect(sent).toEqual(["op-1"]);
    expect(rpc.submitOp).toHaveBeenCalledTimes(1);
  });

  it("a resynchronization also throws away undo/redo: they inverted a replaced document", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([moveOp("op-1", "n1", 40, 40)]);
    await settle();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().history).toHaveLength(1);

    // The snapshot no longer even contains the node the undo entry
    // worked on (another client deleted it before the compaction).
    rpc.openDocument.mockResolvedValue({
      snapshot: snapshotOf({ n2: rectNode("n2", 0, 0) }), seq: 42n,
    });
    last(opened).stream.fail(new ConnectError("since_seq too old", Code.OutOfRange));
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);

    expect(useScene.getState().scene!.nodes.at("n1")).toBeUndefined();
    // A surviving entry would send the inverse of an op computed on a
    // state the snapshot just threw away -- and without its mark
    // (`history` was emptied) not even a rejection could rewind it anymore.
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().history).toHaveLength(0);
  });

  // --- rollback revocation ----------------------------------------------------
  // Hub.Submit broadcasts BEFORE answering the unary: a dead request
  // does not say the op was not applied. As long as the stream did not come back
  // the difference was not observable; with reconnection the echo arrives, and
  // says the rollback was a lie.

  it("the LATE echo of a rolled-back op revokes the rollback: change and undo come back", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    let killSubmit!: (e: unknown) => void;
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          killSubmit = rej;
        }),
    );

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([moveOp("op-mine", "n1", 200, 0)]);
    await settle();
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-mine"]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Server restart: both the stream AND the in-flight request die. The op however may
    // well already be in the op-log.
    last(opened).stream.close();
    await settle();
    killSubmit(new ConnectError("connection closed", Code.Unavailable));
    await settle();

    // Policy unchanged: visible rollback (client-fix-3). What changes is
    // that now it is REVOCABLE.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().lastError).toContain("connection closed");

    // The reconnection replays the backlog: the op was on the server from the start.
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
    expect(opened).toHaveLength(2);
    last(opened).stream.push(applied(1, CLIENT, moveOp("op-mine", "n1", 200, 0)));
    await settle();

    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 200 });
    // The change is durable and back on screen: the banner that gave it as
    // undone must be withdrawn, and it must be said that it is instead saved.
    expect(useScene.getState().lastError).toBeNull();
    expect(useScene.getState().notice).not.toBeNull();
    // And it must become UNDOABLE again: without an entry, the next Ctrl+Z would silently
    // undo the previous gesture instead of this one.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);

    // ...and the restored entry really undoes THIS change.
    useScene.getState().undo();
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });
  });

  // The revocation REBUILDS an undo entry, but the live stacks are not an autonomous
  // state while there is a transition in doubt: they are the replay of
  // `history` on top of its head, photographed BEFORE the revocation.
  // Writing the entry only onto the stacks gets it erased by the first subsequent
  // rejection -- and the window is the normal one, not an acrobatic one: the user
  // keeps drawing while the pill says "reconnecting…", so when the
  // backlog replays the disowned op there is almost always one of their gestures in flight.
  it("the entry RETURNED by the revocation survives the rejection of an op still in flight", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    const kill = new Map<string, (e: unknown) => void>();
    rpc.submitOp.mockReset();
    rpc.submitOp.mockImplementation(
      (req: { op: Op }) => new Promise((_res, rej) => kill.set(req.op.opId, rej)),
    );

    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([moveOp("op-a", "n1", 200, 0)]);
    await settle();

    // Server restart: the stream dies and with it the in-flight request. The op
    // however may well already be in the op-log (broadcast before the response).
    last(opened).stream.close();
    await settle();
    kill.get("op-a")!(new ConnectError("connection closed", Code.Unavailable));
    await settle();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().disowned.map((d) => d.opId)).toEqual(["op-a"]);

    // The user keeps working during the reconnection: gesture B goes out and
    // stays in flight, so its transition is in doubt (history not empty).
    st.beginGesture();
    st.endGesture([moveOp("op-b", "n1", 300, 0)]);
    await settle();
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-b"]);
    expect(useScene.getState().history).toHaveLength(1);

    // The reconnection's backlog replays op-a: the rollback was a lie, and
    // its undo entry comes back.
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
    last(opened).stream.push(applied(1, CLIENT, moveOp("op-a", "n1", 200, 0)));
    await settle();
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().undoStack).toHaveLength(2);

    // ...and NOW op-b dies too. Its rollback must rewind ITS own
    // transition and nothing else: the entry just returned describes a change
    // the server confirmed and is on screen: erasing it would make it
    // again durable, visible and not undoable -- the exact state the
    // revocation exists to remove.
    kill.get("op-b")!(new ConnectError("connection closed", Code.Unavailable));
    await settle();

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);

    // ...and it is the RIGHT entry: it undoes op-a's change, not another one.
    useScene.getState().undo();
    await settle();
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });
  });

  it("an op REJECTED by the server is not revocable: no echo can ever arrive", async () => {
    const { sync, opened } = await bootLive({ n1: rectNode("n1", 0, 0) });
    const net = reorderingTransport();
    net.failOn("op-1", new ConnectError("node already exists", Code.InvalidArgument));

    sync.submit(moveOp("op-1", "n1", 100, 0));
    sync.submit(moveOp("op-2", "n1", 200, 0));
    await settle();
    // op-1 rejected by the server, op-2 never went out: two rollbacks, but only the
    // first was in flight, so only the first has an unknown outcome.
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().disowned.map((d) => d.opId)).toEqual(["op-1"]);

    last(opened).stream.close();
    await settle();
  });

  // --- lifecycle and transport slot -------------------------------------------

  it("building a client does not give it the transport slot: stopping it does not detach the live one", async () => {
    const { sync } = await bootLive({ n1: rectNode("n1", 0, 0) });
    expect(useScene.getState().sync).toBe(sync);

    // It is the shape of ui/App.tsx's bootstrap on first load (no
    // `opendesigner.docId` in localStorage) under StrictMode: the two rounds of the effect
    // each wait for their own createDocument, and if the second response
    // arrives first the FIRST round's client is built AFTER the second's
    // has already registered.
    const stale = new SyncClient("doc1", CLIENT);
    expect(useScene.getState().sync).toBe(sync);

    // ...and immediately stopped by the `if (cancelled)` guard (App.tsx). The guard
    // "clear the slot only if it is still mine" is not enough if the constructor has
    // just stolen it.
    stale.stop();
    expect(useScene.getState().sync).toBe(sync);

    // Without a transport every gesture would take endGesture's `get().apply(op)` branch:
    // applied locally as if confirmed, never sent,
    // lost on reload -- with the pill still saying "connected".
    const st = useScene.getState();
    st.beginGesture();
    st.endGesture([moveOp("op-1", "n1", 40, 40)]);
    await settle();
    expect(rpc.submitOp).toHaveBeenCalledTimes(1);
    expect(useScene.getState().pending.map((p) => p.opId)).toEqual(["op-1"]);
  });

  it("given up means stopped: ops submitted after giving up are REJECTED, not queued", async () => {
    const { sync, opened } = await bootLive({ n1: rectNode("n1", 0, 0) });

    let guard = 0;
    while (useScene.getState().connection !== "error" && guard < 40) {
      last(opened).stream.fail(new ConnectError("connection refused", Code.Unavailable));
      await vi.advanceTimersByTimeAsync(RETRY_WINDOW);
      guard += 1;
    }
    expect(useScene.getState().connection).toBe("error");
    const before = rpc.submitOp.mock.calls.length;

    // From here on the stream does not come back: NOTHING can confirm an op anymore.
    // Accepting them would mean sending them (the server applies them durably)
    // and keeping them in `pending` forever -- replayed by viewOf on every
    // store update, with a history mark that is never decided.
    // MAX_OUTBOX is not a barrier: the outbox empties on every success.
    const st = useScene.getState();
    for (let i = 0; i < 5; i++) {
      st.beginGesture();
      st.endGesture([moveOp(`op-${i}`, "n1", i + 1, 0)]);
    }
    await settle();

    expect(rpc.submitOp).toHaveBeenCalledTimes(before);
    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().history).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0 });
    expect(useScene.getState().lastError).toContain("reload");

    // The transport slot stays OURS: freeing it (stop()) would make every gesture be
    // applied locally as confirmed without sending it to anyone, which is the
    // silent loss that the rejection above serves to avoid.
    expect(useScene.getState().sync).toBe(sync);
  });

  it("CodeOutOfRange (compacted history) makes the document REOPEN and restart from the snapshot's seq", async () => {
    const { opened } = await bootLive({ n1: rectNode("n1", 0, 0) });
    last(opened).stream.push(applied(1, OTHER, moveOp("op-1", "n1", 100, 0)));
    await settle();

    // The server says: the records you want to restart from no longer exist, reopen the
    // document (internal/server/documentservice.go). Resubscribing at the same
    // since_seq would give the same error forever.
    rpc.openDocument.mockResolvedValue({
      snapshot: snapshotOf({ n1: rectNode("n1", 777, 0) }), seq: 42n,
    });
    last(opened).stream.fail(new ConnectError("since_seq too old", Code.OutOfRange));
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW);

    expect(rpc.openDocument).toHaveBeenCalledTimes(2);
    expect(opened).toHaveLength(2);
    expect(opened[1].since).toBe(42n);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 777 });
    expect(useScene.getState().connection).toBe("connected");
  });
});
