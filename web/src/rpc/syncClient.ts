import { Code, ConnectError } from "@connectrpc/connect";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "./client";
import { useScene } from "../store/store";
import { fromDocument } from "../store/types";

// DEADLINE of a single SubmitOp. createConnectTransport has none by
// default (rpc/client.ts) and with the serialized outbox a fetch that NEVER
// resolves no longer loses only itself: it blocks the drain, and every
// subsequent gesture is applied optimistically, queued and never sent. A blocked
// handler, a TCP connection that vanished into nothing or a laptop going to
// sleep produce exactly this, for minutes or forever.
//
// The deadline is on the CALL and not on the transport's `defaultTimeoutMs`:
// the latter would also apply to Subscribe, which is a long-lived stream and must
// be able to stay open for hours. 10s is an order of magnitude above a healthy
// SubmitOp (append to the local op-log + broadcast) and well below the threshold at
// which the user has already drawn half a page on top of an invisible backlog.
const SUBMIT_TIMEOUT_MS = 10_000;

// Cap on the queue: how much work can be at risk at the same time.
// With the deadline above the backlog is already limited in TIME; this limits it
// in QUANTITY too, because it is the quantity the user loses all at once
// if the request at the head really fails. 64 is generous compared to a burst
// of real gestures (M1a's coalescing reduces a whole drag to one op) and tight
// compared to "grows as long as there is memory".
// Exported so the cap's test can verify it without copying the value.
export const MAX_OUTBOX = 64;

// RECONNECTION. The Subscribe stream is not an extra: it is the only channel that
// advances the confirmed document and that empties the in-flight ops queue. The
// backend CLOSES it on its own initiative when a subscriber falls behind
// (internal/server/hub.go: full channel -> endSubscriberLocked) precisely so that
// the client reconnects with since_seq at the last applied record and
// catches up on the backlog: without reconnection this design does not work, and the
// first somewhat dense burst detaches the client for the rest of the session.
//
// Exponential backoff, without jitter: here there is a single browser per user against
// a local server, not a fleet that can synchronize into a thundering
// herd, and a deterministic delay is what makes the tests a specification
// instead of a bet.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
// Cap on CONSECUTIVE attempts without progress. Retrying forever
// would drain battery and, above all, would hide a real problem behind
// a pill that says "reconnecting" for half an hour: at some point the honest
// answer is "I can't manage on my own, reload".
const MAX_RECONNECT_ATTEMPTS = 6;
// A stream that lived at least this long counts as progress even if it did not
// deliver a single record: a quiet document (nobody is drawing) is
// silent by definition, and without this clause six network drops
// scattered over a working day would be enough to declare dead a
// connection that recovers every time.
const RECONNECT_STABLE_MS = 60_000;

function backoffMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
}

const CLOSED_BY_SERVER = "the server closed the updates stream";
const SEQUENCE_GAP = "gap in the updates sequence";

// Rollback message when the authoritative snapshot replaces the document
// mid-session: the in-flight queue can no longer be placed and disappears from the canvas.
// Without a message the user would see their own changes vanish with the
// pill on "connected" and no explanation anywhere.
const RESYNCED =
  "the server resynchronized the document and the changes not yet confirmed were lost";

// Rejection message when the client has given up: from here on no op
// can be confirmed anymore, so accepting it would mean keeping it on screen
// (and in the queue) until the reload that will erase it.
const GAVE_UP = "connection to the server lost: reload the page to resume working";

// The client keeps the CONFIRMED state (what the server applied and
// re-emitted) plus the PENDING ops (submitted, not yet returned). The
// view is confirmed + pending. Every record arriving from Subscribe advances
// the confirmed state and the view is recomputed: this is what makes order,
// rollback and rebase defined instead of ad hoc.
//
// The split lives in the store (store/store.ts) because the store owns the
// view and the gestures; SyncClient is only the wiring between the transport and the three
// entry points of the model: applyPending (submit), apply (authoritative record),
// rejectPending (rejection).
export class SyncClient {
  private seq = 0;
  // OUTBOX: the ops still to be sent, in sending order. The first element is
  // the one in flight (or the next to go); ONE AT A TIME goes out.
  //
  // The seq is assigned by the SERVER in order of ARRIVAL (internal/server/hub.go:
  // Submit serializes on the mutex and whoever enters first gets the lowest seq).
  // While submits were fire-and-forget, the persisted order was the one in
  // which requests reached the hub -- decided by the scheduler, not
  // by the user: two unaries started together are two independent goroutines
  // even on the same multiplexed connection. With op19 = x=100 and op20 =
  // x=200 emitted together, the oplog could end up [x=200, x=100], the document
  // reloaded at x=100 and the canvas at x=200. There is nothing in the protocol that
  // could notice: SubmitOpRequest carries only doc_id/client_id/op.
  //
  // The queue is normally short -- M1a's coalescing reduces a whole drag to
  // a single final op (store.endGesture) -- so here obvious correctness
  // is worth more than throughput: no pipeline, no batching.
  private outbox: Op[] = [];
  private draining = false;

  // --- lifecycle -------------------------------------------------------------
  // `started` makes start() idempotent: React in StrictMode invokes the bootstrap
  // effect twice, and a second subscription would mean two goroutines
  // on the server and EVERY record applied twice in the same global store.
  // `stopped` is final: a stopped client does not restart (a new one is built),
  // so a React cleanup can never leave a loop around
  // that keeps writing into the store of an unmounted app.
  private started = false;
  private stopped = false;
  // GENERATION of the document. It changes at every resynchronization (open() from the
  // CodeOutOfRange branch): the snapshot replaces the document wholesale and empties
  // `pending`, so everything that was in flight belongs to a world that no
  // longer exists. A request started in the previous generation must not be able to
  // decide anything when it returns -- neither remove the head from the queue (which in the
  // meantime is ANOTHER op) nor, worse, read `pending` to deduce whether it
  // landed: after a resync `pending` is empty and `landed()` would say "yes" for
  // any op, reopening the way to ops built on a premise the
  // server never reached.
  private epoch = 0;
  // The client has given up (reconnection attempts exhausted). It is not `stopped`:
  // the transport slot in the store stays OURS -- removing it would make
  // endGesture take the wireless branch (`get().apply(op)`), which applies changes
  // locally as if they were confirmed and sends them to no one. Here instead
  // every submit is visibly REJECTED: same rollback and same banner as
  // a server rejection.
  private givenUp = false;
  // The CURRENT subscription's controller: it is the only way to really close
  // the HTTP request: without abort the fetch stays open, the server
  // keeps the subscriber registered and the for-await never ends.
  private controller: AbortController | null = null;
  // Early wake-up of the backoff wait, so stop() is immediate and does not
  // have to wait up to 10s to take effect.
  private wake: (() => void) | null = null;
  // CONSECUTIVE attempts WITHOUT progress (see RECONNECT_STABLE_MS).
  private attempts = 0;

  // Building a client has no effects: registration as the transport happens
  // in start() (see there why).
  constructor(private docId: string, private clientId: string) {}

  submit(op: Op) {
    if (this.stopped) {
      // Detached client: the queue no longer starts and the store, in StrictMode, is
      // already another client's. Applying optimistically would leave an op in
      // `pending` forever -- visible on the scene, sent to no one and
      // impossible to confirm, because the only live stream is the new
      // client's, which knows nothing about this op.
      console.warn("opendesigner: submit on a stopped SyncClient — op ignored", op.opId);
      return;
    }
    // OPTIMISTIC apply: it enters the in-flight ops queue and shows up immediately.
    // It is not confirmed yet: it will become so when its echo returns from
    // Subscribe. It stays SYNCHRONOUS -- only the sending is serialized, the
    // on-screen feedback is not.
    useScene.getState().applyPending(op);
    if (this.givenUp) {
      // Given up: the stream will not come back, so NOTHING can confirm
      // this op anymore. Sending it anyway would have it applied durably on the
      // server while here it stays forever in `pending` -- replayed by viewOf on
      // every store update (quadratic in the session length)
      // and with a history mark that will never be decided. Rejecting it
      // costs one edit; accepting it costs the session.
      useScene.getState().rejectPending(op.opId, GAVE_UP);
      return;
    }
    if (this.outbox.length >= MAX_OUTBOX) {
      // Queue saturated: the head has not moved for a while. We reject the NEW op
      // instead of throwing away those already queued -- they are the oldest
      // intent, and might go out at any moment. The rejection goes through the
      // same door as a server rejection (applyPending followed by
      // rejectPending): same view rollback, same rewinding
      // of the undo entry, same banner. An op that does not go out must cost
      // exactly like an op that goes out and is rejected.
      useScene.getState().rejectPending(
        op.opId,
        `too many pending changes (${MAX_OUTBOX}): the server is not responding`,
      );
      return;
    }
    this.outbox.push(op);
    void this.drain();
  }

  // Is the op still in the store's in-flight ops queue? If it is NO longer there, its
  // echo has already arrived from Subscribe: the server applied it and put it
  // in the op-log, so it is DURABLE even if the HTTP response never came back.
  // Hub.Submit broadcasts to subscribers BEFORE writing the response
  // (internal/server/hub.go), so this window is not theoretical.
  //
  // An empty opId never enters `pending` (applyPending treats it as already
  // confirmed): it would not distinguish the two cases, so the cautious
  // reading is chosen -- "not landed". A null `confirmed` means the store is not yet
  // initialized: same.
  private landed(op: Op): boolean {
    const st = useScene.getState();
    if (op.opId === "" || !st.confirmed) return false;
    return !st.pending.some((p) => p.opId === op.opId);
  }

  // Empties the outbox one request at a time. Reentrancy-safe: `draining` ensures
  // there is only one live drain, so a submit made while a
  // request is in flight just queues up and will be picked up by the current round.
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      // `stopped` closes this half too: after stop() no other op goes out and
      // no rollback touches the store anymore (see the catch).
      while (this.outbox.length > 0 && !this.stopped) {
        const op = this.outbox[0];
        // The generation in which this request starts. If it changes while it is in
        // flight, the document was replaced by a snapshot: this
        // request has nothing left to say about a queue that is no longer its own.
        const epoch = this.epoch;
        try {
          await docClient.submitOp(
            { docId: this.docId, clientId: this.clientId, op },
            { timeoutMs: SUBMIT_TIMEOUT_MS },
          );
          // The unary's Ack confirms NOTHING: it only carries the assigned seq.
          // The real confirmation is the echo on Subscribe, the only point where the
          // client knows the ORDER the server decided relative to other
          // people's ops. Here it only serves to know that it arrived, that is that the
          // next one can go out without overtaking it.
          //
          // ...unless a resync arrived in the meantime: the queue
          // was emptied and at the head there is, if anything, an op built on the NEW
          // document. A shift() here would throw away the wrong one.
          if (this.epoch !== epoch) continue;
          this.outbox.shift();
        } catch (err) {
          // FAILURE POLICY: the queue STOPS and is emptied.
          // The failed op leaves the view (rollback, as the previous .catch
          // already did), and with it ALL those still queued behind it: they were
          // built on a state that included its effect, that is on a
          // premise the server never reached. Sending them anyway would
          // persist a change based on a document that does not exist
          // (e.g. a setProps on a node whose createNode was just
          // rejected). Better to lose the changes, visibly, than
          // write inconsistent ones silently.
          //
          // The stop is the QUEUE's, not the client's: after the rollback the view
          // goes back to "confirmed + truly accepted ops", so a subsequent
          // submit is again built on a true premise and goes out
          // normally. Latching forever at the first InvalidArgument (a duplicate
          // id, say) would freeze the editor for no reason.
          //
          // And it applies only if the premise is REALLY false: `landed()` below
          // is the case where it is not.
          const message = ConnectError.from(err).message;
          console.error("submitOp failed", err);
          // Client stopped while the request was in flight (fetch abort on
          // page close, typically): there is no one left to show a
          // rollback to, and writing it while a new client has already taken over
          // would make an op that is not even its own disappear from the scene.
          if (this.stopped) return;
          // Resync while the request was in flight: the queue was already thrown
          // away and the user has already seen the rollback (setScene with its
          // message). Above all: `landed()` is NOT usable here, because it
          // reads `pending` -- which the resync emptied -- and would answer
          // "landed" for any op, making the queue behind it start as if
          // its premise were true.
          if (this.epoch !== epoch) continue;
          if (this.landed(op)) {
            // The request died AFTER the server had applied and
            // rebroadcast the op: the echo has already arrived, the op is durable. The
            // premise of the queue behind ("the predecessor is on the server")
            // is therefore TRUE and stopping it would throw away valid work while showing an
            // error for a successful op. We proceed: no rollback, no
            // banner, only the log line.
            this.outbox.shift();
            continue;
          }
          const dropped = this.outbox.splice(0, this.outbox.length);
          // From the bottom: so no intermediate state shows an op applied
          // on top of a base missing its predecessor.
          //
          // Only the HEAD is revocable (store.ts::DisownedOp): it is the only one that was
          // really in flight, so the only one the server may have applied
          // even though the request died. The queue behind never went out:
          // no echo can ever arrive, and marking it revocable would only
          // take up slots in the rollback memory.
          for (let i = dropped.length - 1; i >= 0; i--) {
            useScene.getState().rejectPending(dropped[i].opId, message, i === 0);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // Opens the document and starts the stream loop. Idempotent: two consecutive
  // calls (StrictMode) leave ONE single subscription alive.
  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    // REGISTRATION as the store's transport. Here and not in the constructor: the
    // slot is single and whoever registers LAST takes it, so
    // registering at construction means a never-started client can
    // steal the slot from a live one -- and its stop(), which clears the slot only if
    // it is still its own, finds it its own and leaves the editor without a transport.
    //
    // It is not theoretical: it is the shape of ui/App.tsx's bootstrap on first load
    // (no `opendesigner.docId` in localStorage) under StrictMode. The two rounds
    // of the effect each wait for their own createDocument; if the second
    // response arrives first, the FIRST round's client is built after
    // the second's has already registered, and immediately stopped by the
    // `if (cancelled)` guard. From then on `sync` is null, every endGesture
    // takes the wireless branch (store.ts: `get().apply(op)`) and every edit
    // is applied locally as confirmed, never sent and lost on reload,
    // with the pill still saying "connected".
    useScene.getState().setSync(this);
    await this.open();
    // stop() may have arrived during the await (quick unmount): do not start
    // a loop that no one will ever stop.
    if (this.stopped) return;
    // The loop runs in the background: start() must resolve as soon as the snapshot is
    // loaded, not when the subscription ends (that is: never).
    void this.loop();
  }

  // Detaches everything: the subscription in progress (abort of the signal, which is what
  // really closes the HTTP request and frees the subscriber on the server),
  // the backoff wait, and the transport slot in the store. To be called from the
  // bootstrap effect's cleanup: without it, an unmount leaves a loop that
  // keeps reconnecting and writing into a store nobody is looking at anymore.
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.wake?.();
    // Only if the slot is still OURS: in StrictMode the next client has
    // already registered before this cleanup runs, and clearing it would leave
    // the editor without a transport (every gesture applied locally and never sent).
    if (useScene.getState().sync === this) useScene.getState().setSync(null);
  }

  // Authoritative snapshot: aligns view, confirmed state and starting seq. It is also
  // the only possible answer to CodeOutOfRange (the history we wanted to
  // restart from was compacted), and in that case setScene empties `pending`:
  // the ops still in flight remain legitimate on the server -- if they landed
  // their echo will arrive and put them back in the scene -- but the client no longer has
  // a way to place them relative to a snapshot that does not know at which point
  // of history it stands.
  //
  // `resync` distinguishes bootstrap from mid-session replacement, which is
  // another thing: there is a live document underneath, with a queue, a history and --
  // outside the store -- an OUTBOX. Emptying the queue without also emptying
  // the outbox misaligns them, and from then on `landed()` ("it is not in pending, so
  // the server has it") answers "landed" for ops that never left the browser.
  // The generation (`epoch`) is what makes that misalignment
  // impossible even for the request already in flight.
  //
  // CodeOutOfRange is not hypothetical: the hub compacts every 256 ops
  // (internal/server/hub.go: snapshotEveryOps) and a restarted hub starts with
  // historyBase at the loaded seq (internal/server/bundle.go), so it is enough
  // to resume a session from an older point.
  private async open(resync = false) {
    const open = await docClient.openDocument({ docId: this.docId });
    if (this.stopped) return;
    if (resync) {
      this.epoch += 1;
      // These ops never left and will not leave: they were built
      // on a document that the snapshot has just replaced. setScene removes them
      // from the view (and shows why); here their sending is removed.
      this.outbox.length = 0;
    }
    if (open.snapshot) {
      useScene.getState().setScene(fromDocument(open.snapshot), resync ? RESYNCED : undefined);
    }
    this.seq = Number(open.seq);
    useScene.getState().setConnection("connected");
  }

  // The stream's life loop: it consumes, and when the stream ends (in
  // any way) it waits and resubscribes from `this.seq`, that is from AFTER the last
  // applied record -- since_seq is exclusive (hub.go: `rec.Seq > sinceSeq`),
  // so the backlog restarts exactly from the first record we are missing.
  //
  // Before this fix `void this.consume()` had neither catch nor retry: the
  // end of the stream was an unhandled rejection and nothing else, the confirmed
  // document stayed frozen forever and every subsequent gesture queued up in
  // `pending` with nothing able to remove it from there anymore.
  private async loop() {
    while (!this.stopped) {
      const controller = new AbortController();
      this.controller = controller;
      const openedAt = Date.now();
      let reason: string;
      let reopen = false;
      try {
        const end = await this.consume(controller.signal);
        if (this.stopped) return;
        // for-await ended without an error: the server closed the stream. It is not
        // less serious than an error -- from here on no record arrives anymore.
        reason = end === "gap" ? SEQUENCE_GAP : CLOSED_BY_SERVER;
        console.error("subscribe stream ended:", reason);
      } catch (err) {
        if (this.stopped) return;
        const ce = ConnectError.from(err);
        reason = ce.message;
        // OutOfRange = "the records you want to restart from were compacted into
        // a snapshot" (documentservice.go). Resubscribing at the same since_seq
        // would give the same error forever: the only way out is to
        // reopen the document and restart from the seq OpenDocument reports.
        reopen = ce.code === Code.OutOfRange;
        console.error("subscribe stream failed", err);
      } finally {
        // Also when WE exit the for-await (gap): the stream has not
        // ended, and without abort the request would stay open with the server
        // still pushing records into a channel nobody reads.
        controller.abort();
        this.controller = null;
      }

      // A long-lived stream did its job even if the document
      // was idle: the attempts budget applies to CONSECUTIVE drops.
      if (Date.now() - openedAt >= RECONNECT_STABLE_MS) this.attempts = 0;
      this.attempts += 1;
      if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
        // GAVE UP. The loop ends here, and with it the only thing that can confirm
        // an op: from now on `submit()` rejects instead of queueing (see
        // `givenUp`). Without this the client stays "half alive" -- it accepts ops,
        // sends them, the server applies them durably -- and the pending
        // queue, the doubtful history and viewOf's replay grow for the whole
        // rest of the session, with MAX_OUTBOX unable to step in
        // (the outbox empties on every success, `pending` does not).
        //
        // What is ALREADY queued goes out anyway: it is at most MAX_OUTBOX ops, it
        // has already passed the rollback's point of no return, and the server is
        // the only place where it can still survive the reload.
        this.givenUp = true;
        useScene.getState().setConnection("error", reason);
        return;
      }
      useScene.getState().setConnection("reconnecting", reason);

      await this.wait(backoffMs(this.attempts));
      if (this.stopped) return;
      if (reopen) {
        try {
          // RESYNCHRONIZATION, not bootstrap: there is a live document that the
          // snapshot is about to replace (see open()).
          await this.open(true);
        } catch (err) {
          // If not even OpenDocument answers, the server is down: the next
          // subscribe round will fail in turn and consume an
          // attempt like all the others, so the cap applies here too.
          console.error("resync (openDocument) failed", err);
        }
        if (this.stopped) return;
      }
    }
  }

  // Interruptible wait: stop() wakes it immediately instead of leaving a
  // timer standing that would resolve inside an already unmounted app.
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  // One subscription round. Returns "closed" if the stream ended (the server
  // closed it), "gap" if the client detached because of a hole in the
  // sequence; a transport error comes out as an exception.
  private async consume(signal: AbortSignal): Promise<"closed" | "gap"> {
    const stream = docClient.subscribe(
      { docId: this.docId, clientId: this.clientId, sinceSeq: BigInt(this.seq) },
      { signal },
    );
    // "Connected" as soon as the subscription is open, not at the first record: a
    // document on which nobody is drawing is silent by definition, and
    // waiting for a record would mean leaving the pill on "reconnecting"
    // indefinitely with a perfectly healthy connection. The price is
    // a flash of "connected" on every attempt while the server is down --
    // but the attempt lasts milliseconds and the backoff wait, which is what the
    // user sees, stays "reconnecting".
    useScene.getState().setConnection("connected");
    for await (const msg of stream) {
      // A record may already be in the buffer when stop arrives: the guard
      // here is what guarantees that after stop() NOTHING enters the store anymore.
      if (this.stopped || signal.aborted) return "closed";
      if (msg.kind.case !== "applied") continue;
      const rec = msg.kind.value;
      const seq = Number(rec.seq);

      if (seq <= this.seq) {
        // Already seen. It should not happen (since_seq is exclusive and the hub
        // delivers exactly once), but reapplying an op because the
        // backlog overlapped would be a silent mutation of the
        // document: it is discarded and we move on.
        console.warn(`opendesigner: duplicate record seq=${seq} (already at ${this.seq}), ignored`);
        continue;
      }
      if (seq !== this.seq + 1) {
        // GAP. Proceeding would mean keeping a document that is missing an
        // op, permanently and invisibly: if the gap contained a
        // CreateNode, every subsequent SetProps on that node is swallowed
        // by applyOp (`if (!cur) return state`) and the shape never appears.
        // We detach and resubscribe from the last GOOD seq, which is what
        // makes the server resend the missing records.
        console.error(`opendesigner: gap in the stream (expected ${this.seq + 1}, received ${seq})`);
        return "gap";
      }

      // ALSO our own echoes. Discarding them by clientId (as in M0) means
      // never adopting the authoritative version of our own ops: the client never
      // knows how the server ordered them relative to other people's, and
      // its ops stay optimistic forever. It is the echo that confirms them --
      // store.apply removes them from the queue precisely based on the opId,
      // so the op is not applied twice, not even when it is the backlog of a
      // reconnection that brings it back.
      //
      // The clientId is still needed, though, for another decision: someone ELSE's record may
      // have invalidated undo/redo entries (store.ts::markStale),
      // ours cannot. It is the only place where provenance matters, and the
      // comparison is deliberately strict -- an empty clientId is not proof of
      // anything, so the record must be treated as someone else's.
      const own = rec.clientId !== "" && rec.clientId === this.clientId;
      if (rec.op) useScene.getState().apply(rec.op, own);
      this.seq = seq;
      // Progress: the attempts budget restarts from zero.
      this.attempts = 0;
    }
    return "closed";
  }
}
