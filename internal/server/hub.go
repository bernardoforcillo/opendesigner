// Package server: hub per-doc + handler Connect.
package server

import (
	"errors"
	"fmt"
	"log"
	"sync"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/core"
	"github.com/bernardoforcillo/brawt/internal/store"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type subscriber struct {
	ch chan *brawtv1.OpRecord
	// closeOnce guards close(ch) in the cancel func returned by Subscribe:
	// cancel must be safe to call more than once (matching the idiomatic
	// Go convention of idempotent cancel funcs, e.g. context.CancelFunc),
	// since callers with multiple exit paths (e.g. a Sync handler that
	// cancels on both an incoming error and a deferred cleanup) may invoke
	// it more than once. Without this, a second close(ch) panics.
	closeOnce sync.Once
}

// subscriberChanCap is the minimum buffered capacity for a subscriber's
// channel. Subscribe grows it per-subscriber to also fit that subscriber's
// own catch-up backlog (see Subscribe) so registering never blocks.
const subscriberChanCap = 256

// snapshotEveryOps is how many applied ops trigger a snapshot.
//
// The policy is op-count, not a "T seconds of quiet" timer, because every
// cost a snapshot exists to bound is a function of op count and none of them
// is a function of time: the oplog's length, h.history's length, and the
// replay work NewHub does at startup all grow per op. A quiet-period timer
// gets both ends of that wrong. It fires on an idle editor where nothing
// changed (writing the same snapshot again, waking the disk), and it does not
// fire at all during exactly the sustained activity that needs it -- one
// pointer drag emits ~20 ops, so a user who never pauses for T seconds
// accumulates an unbounded log while the timer waits for a quiet moment that
// never comes. An op count makes the bound explicit and checkable: the oplog
// holds at most snapshotEveryOps records plus whatever arrives while a
// snapshot is in flight, and h.history holds the same.
//
// It is also the only policy that is deterministically testable -- the test
// submits N ops and asserts, instead of sleeping and hoping -- and it needs no
// background ticker, so the Hub gains no goroutine that M0 has nowhere to stop.
//
// 256 is about 13 drags' worth of ops: frequent enough that a restart replays
// a trivial log, rare enough that the write is invisible next to the per-op
// fsync Append already does.
const snapshotEveryOps = 256

// ErrHistoryTooOld reports that a subscriber asked to resume from a seq whose
// records have already been folded into a snapshot and dropped -- the hub
// cannot serve that catch-up from either memory or the (compacted) oplog.
//
// It exists because compaction makes the gap reachable: before it, h.history
// held every record ever applied, so any since_seq could be served. Serving a
// partial backlog instead would hand the client a silent hole in its op
// stream, which is precisely how a node created in the missing range never
// appears and every later op on it is dropped on the floor. The client's
// recovery is to re-open the document (OpenDocument returns a snapshot and
// the seq it is current to) and subscribe from there.
var ErrHistoryTooOld = errors.New("since_seq is older than the oldest retained record")

// documentBundle is the persistence one Hub needs, which *store.Bundle
// provides and nothing else implements in production.
//
// It is an interface so the hub's lock discipline can be tested against a
// bundle whose disk work can be held open mid-flight. What has to be proved
// is what the hub does WHILE the bundle is busy, and a real bundle's writes
// finish in microseconds -- there is no way to observe the window from
// outside, and a seam inside the hub cannot model it either, because the
// contention is between two bundle calls: store.Bundle serialises Append and
// Snapshot on b.mu (compaction rewrites the very file Append appends to), so
// a Submit landing during a snapshot waits for it.
type documentBundle interface {
	Load() (*brawtv1.Document, uint64, error)
	History() ([]*brawtv1.OpRecord, error)
	Append(rec *brawtv1.OpRecord) error
	Snapshot(doc *brawtv1.Document, seq uint64) error
}

// Hub serializza gli Op di UN documento e li ritrasmette ai subscriber.
type Hub struct {
	// writeMu admits one submitter at a time and is held for the whole of
	// Submit, bundle.Append included, so the order in which records are
	// assigned seqs is the order in which they are appended and published.
	//
	// It is deliberately not h.mu. Append fsyncs, and it waits on the bundle
	// lock whenever a background snapshot is compacting the same document --
	// a wait no lock discipline can remove, since the compaction rewrites the
	// file Append appends to. Splitting the two locks means that wait delays
	// other WRITERS to this one document and nothing else: h.mu, which is
	// what OpenDocument's Snapshot() and Subscribe need, is never held across
	// any disk work.
	//
	// Lock order is writeMu -> mu, and never the reverse. Nothing takes
	// writeMu while holding mu (runSnapshot takes mu alone, after
	// Bundle.Snapshot has returned).
	writeMu sync.Mutex

	mu      sync.Mutex
	bundle  documentBundle
	doc     *brawtv1.Document
	seq     uint64
	history []*brawtv1.OpRecord // record dallo snapshot in poi (per catch-up)
	subs    map[*subscriber]struct{}

	// historyBase is the seq of the newest record NOT in history: everything
	// at or below it has been snapshotted and dropped. Subscribe uses it to
	// tell "you are up to date" from "what you are asking for is gone".
	historyBase uint64

	// snapshotEvery is snapshotEveryOps, per-hub so tests can pick a small
	// threshold instead of paying for hundreds of real fsyncs.
	snapshotEvery int
	sinceSnapshot int  // ops applied since the last snapshot was started
	snapshotting  bool // a snapshot goroutine is running
	// snapshotErr is the last background snapshot's outcome. A failed
	// snapshot loses nothing (the oplog still holds every op) so it must not
	// fail the Submit that triggered it, but it must not vanish either.
	snapshotErr error
	// snapshots tracks in-flight snapshot goroutines, so a test -- or a
	// graceful shutdown, when there is one -- can wait for the disk work to
	// finish instead of racing it.
	snapshots sync.WaitGroup
}

func NewHub(b *store.Bundle) (*Hub, error) { return newHub(b) }

// newHub is NewHub over the bundle behaviour the Hub actually uses; see
// documentBundle.
func newHub(b documentBundle) (*Hub, error) {
	doc, seq, err := b.Load()
	if err != nil {
		return nil, err
	}
	// Load only replays the persisted oplog into doc; it doesn't hand back
	// the individual records. Reconstruct history from the bundle too, so
	// Subscribe's catch-up still works for sinceSeq below this hub's
	// startup seq after a server restart/reopen of an existing document.
	history, err := b.History()
	if err != nil {
		return nil, err
	}
	// b.History() returns exactly the records the persisted snapshot does not
	// already contain, so the first one marks where the retained history
	// starts; with none, everything on disk is folded into the snapshot and
	// the base is the loaded seq. Deriving it from the records themselves
	// keeps it true even for a bundle recovering from a crash between the
	// snapshot and its compaction.
	base := seq
	if len(history) > 0 {
		base = history[0].GetSeq() - 1
	}
	return &Hub{
		bundle:        b,
		doc:           doc,
		seq:           seq,
		history:       history,
		historyBase:   base,
		subs:          map[*subscriber]struct{}{},
		snapshotEvery: snapshotEveryOps,
	}, nil
}

func (h *Hub) Submit(clientID string, op *brawtv1.Op) (*brawtv1.OpRecord, error) {
	// One submitter at a time, for the whole call: the seq a record is
	// assigned must be the order it is appended to the oplog and published
	// in. See writeMu for why this is not h.mu.
	h.writeMu.Lock()
	defer h.writeMu.Unlock()

	// h.doc and h.seq are written only by a Submit, so writeMu already pins
	// them for the rest of this call; h.mu is taken for the read itself so a
	// concurrent reader never sees a torn (doc, seq) pair -- and so the two
	// goroutines' accesses are properly ordered.
	h.mu.Lock()
	base, baseSeq := h.doc, h.seq
	h.mu.Unlock()

	// core.Apply mutates its Document argument in place, and for CreateNode
	// it aliases op's Node straight into doc.Nodes without copying it. Apply
	// to a scratch clone of the published document first, and publish it as
	// the new h.doc only after the record has been durably appended: if
	// Append fails, h.doc/h.seq must be left exactly as they were, or the
	// in-memory document would silently diverge from the persisted oplog for
	// the rest of the process's life. As a side benefit, every successful generation
	// of h.doc is now a fresh proto.Clone, so a node object touched while
	// applying one op can never again be the same Go object touched while
	// applying a later op on that same node id.
	//
	// Apply a clone of op (never the caller's op) to next: core.Apply's
	// CreateNode aliases its op's Node straight into doc.Nodes, so applying
	// the caller's own op would leave h.doc aliasing caller-owned objects
	// post-commit, contradicting the promise that the caller is free to
	// reuse or mutate op once Submit returns.
	next := proto.Clone(base).(*brawtv1.Document)
	if err := core.Apply(next, proto.Clone(op).(*brawtv1.Op)); err != nil {
		return nil, err
	}

	rec := &brawtv1.OpRecord{
		Seq:      baseSeq + 1,
		Ts:       timestamppb.Now(),
		ClientId: clientID,
		// A second, independent clone of op — not the pointer applied to
		// next above, and not the caller's op. rec is retained in h.history
		// and handed to subscriber goroutines that read/marshal it outside
		// h.mu, so it must not alias a node object living inside h.doc
		// (which a later SetProps on that node would mutate in place and so
		// silently corrupt this historical record), nor the caller's op.
		Op: proto.Clone(op).(*brawtv1.Op),
	}
	// Durable before published, and outside h.mu. Append fsyncs, and it blocks
	// on the bundle lock for the length of a whole snapshot whenever one is
	// compacting this document. Holding the state lock across that is what
	// made OpenDocument and Subscribe -- which need nothing but memory --
	// stall behind another client's drag.
	if err := h.bundle.Append(rec); err != nil {
		return nil, err
	}

	// Publish: the new document generation, the record and the broadcast all
	// become visible in one hold of h.mu, so a Subscribe either registers
	// before it (and receives rec on its channel) or after it (and finds rec
	// in its catch-up backlog), never neither and never both.
	h.mu.Lock()
	defer h.mu.Unlock()
	h.doc = next
	h.seq = rec.Seq
	h.history = append(h.history, rec)
	for s := range h.subs {
		select {
		case s.ch <- rec:
		default: // subscriber lento: drop, si riallinea via since_seq alla riconnessione
		}
	}
	h.maybeSnapshotLocked()
	return rec, nil
}

// maybeSnapshotLocked starts a snapshot when enough ops have been applied
// since the last one. h.mu must be held.
//
// The disk work runs on its own goroutine and takes no hub lock, so the
// Submit that triggered it returns as soon as its own op is durable: a
// snapshot marshals the whole document, writes it, fsyncs it, then rewrites
// and fsyncs the oplog, and doing that inline would add all of it to the
// latency of one client's pointermove.
//
// h.doc is handed over without a clone. That is safe because Submit never
// mutates a published document: it applies to a fresh proto.Clone and only
// then publishes it, so the generation captured here is frozen for good.
// Cloning it anyway would be an O(document) copy under the lock -- the exact
// cost this indirection exists to avoid.
func (h *Hub) maybeSnapshotLocked() {
	h.sinceSnapshot++
	if h.snapshotEvery <= 0 || h.sinceSnapshot < h.snapshotEvery || h.snapshotting {
		return
	}
	// Reset before starting, so ops applied while this snapshot is in flight
	// count towards the next one rather than being lost or double-counted.
	h.sinceSnapshot = 0
	h.snapshotting = true
	doc, seq := h.doc, h.seq
	h.snapshots.Add(1)
	go h.runSnapshot(doc, seq)
}

// runSnapshot persists doc as the snapshot at seq and, once it is durable,
// drops the records it now covers from the in-memory history.
//
// It holds no hub lock while writing, so OpenDocument, Subscribe and every
// other reader keep working throughout -- but only because Submit does not
// hold one across bundle.Append either. A Submit landing in this window can
// still wait on the bundle's own lock, and irreducibly so: the compaction
// rewrites the very file Append appends to. What that wait must not do is
// spread, and it does not -- it is taken holding writeMu alone, so it delays
// other writers to this one document and no reader anywhere. Bundle.Snapshot
// keeps it short by writing and fsyncing the document (the part that grows
// with the drawing) before it takes that lock at all.
func (h *Hub) runSnapshot(doc *brawtv1.Document, seq uint64) {
	defer h.snapshots.Done()
	err := h.bundle.Snapshot(doc, seq)
	// Whether the snapshot is ON DISK is not the same question as whether the
	// call succeeded. Its last step -- refreshing meta.json's updatedAt --
	// runs after the document and the compacted oplog have both been fsynced,
	// and reports its own failure as store.ErrSnapshotCommitted. Reading that
	// as "no snapshot happened" would keep every record the snapshot already
	// covers in h.history for the life of the process while historyBase fell
	// permanently behind the seq on disk: the unbounded-history fix would
	// silently stop applying, for a stale timestamp.
	committed := err == nil || errors.Is(err, store.ErrSnapshotCommitted)

	// h.mu is taken only after Bundle.Snapshot has returned, i.e. after it has
	// released the bundle lock. That keeps one lock order everywhere (h.mu then
	// b.mu, as in Submit -> Append); holding h.mu across the call would invert
	// it here and deadlock against any concurrent Submit.
	h.mu.Lock()
	defer h.mu.Unlock()
	h.snapshotting = false
	h.snapshotErr = err
	switch {
	case err == nil:
	case committed:
		// Logged, not swallowed: the document is as durable as after a clean
		// snapshot, but its recorded "last modified" is stale until the next
		// one, and a workspace whose identity files cannot be written is
		// worth knowing about.
		log.Printf("brawt: snapshot of document %s at seq %d committed, but its identity file was not refreshed: %v", doc.GetId(), seq, err)
	default:
		// Not fatal: every op is already in the oplog, so the document is
		// intact and simply stays uncompacted. Retrying immediately would
		// hammer a disk that is out of space or failing, so the reset in
		// maybeSnapshotLocked already gives this a full snapshotEvery-op
		// backoff. Logged because a durability failure that only ever shows
		// up as unexplained memory growth is worse than a noisy line.
		log.Printf("brawt: snapshot of document %s at seq %d failed: %v", doc.GetId(), seq, err)
		return
	}
	h.trimHistoryLocked(seq)
}

// trimHistoryLocked drops the records at or below seq: the snapshot on disk
// now contains them, so no catch-up can still need them. h.mu must be held.
//
// Without this, h.history is every record ever applied and grows for the life
// of the process (and Manager never evicts a hub, so it is never released) --
// which also made Subscribe allocate and fill a channel sized to that entire
// backlog, under the hub lock.
func (h *Hub) trimHistoryLocked(seq uint64) {
	if seq <= h.historyBase {
		return
	}
	i := 0
	for i < len(h.history) && h.history[i].GetSeq() <= seq {
		i++
	}
	h.historyBase = seq
	if i == 0 {
		return
	}
	// Copy into a right-sized slice rather than re-slicing: h.history[i:]
	// keeps the whole original backing array (and every dropped record)
	// reachable, so the memory this exists to release would never be freed.
	rest := make([]*brawtv1.OpRecord, len(h.history)-i)
	copy(rest, h.history[i:])
	h.history = rest
}

// waitSnapshots blocks until every in-flight background snapshot has
// finished. Tests use it to assert on the state a snapshot leaves behind
// without racing it.
func (h *Hub) waitSnapshots() { h.snapshots.Wait() }

// Subscribe registers a subscriber and returns its channel, a cancel func,
// and an error when the requested catch-up cannot be served (ErrHistoryTooOld).
func (h *Hub) Subscribe(sinceSeq uint64) (<-chan *brawtv1.OpRecord, func(), error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Everything at or below historyBase has been snapshotted away. Refuse
	// rather than deliver a backlog with a hole in it: see ErrHistoryTooOld.
	if sinceSeq < h.historyBase {
		return nil, nil, fmt.Errorf("%w: since_seq %d, oldest retained record %d", ErrHistoryTooOld, sinceSeq, h.historyBase+1)
	}

	var backlog []*brawtv1.OpRecord
	for _, rec := range h.history {
		if rec.Seq > sinceSeq {
			backlog = append(backlog, rec)
		}
	}

	// Size the channel to fit the whole catch-up backlog up front so
	// registering a subscriber can never block. The backlog is bounded by
	// the snapshot policy now, but it is still routinely larger than
	// subscriberChanCap between snapshots; a blocking send here — while
	// still holding h.mu, before the caller has any chance to drain a
	// channel it hasn't even received yet — would deadlock this call
	// forever and, because h.mu is held, every other Submit/Subscribe/
	// Snapshot on the Hub right along with it.
	capacity := subscriberChanCap
	if n := len(backlog); n > capacity {
		capacity = n
	}
	s := &subscriber{ch: make(chan *brawtv1.OpRecord, capacity)}
	for _, rec := range backlog {
		s.ch <- rec
	}

	h.subs[s] = struct{}{}
	cancel := func() {
		h.mu.Lock()
		delete(h.subs, s)
		h.mu.Unlock()
		// Idempotent: cancel is a func(), not a method, so nothing stops a
		// caller from invoking it more than once (e.g. once on an error
		// path and once in a deferred cleanup); sync.Once makes a repeat
		// call a no-op instead of a close-of-closed-channel panic.
		s.closeOnce.Do(func() { close(s.ch) })
	}
	return s.ch, cancel, nil
}

func (h *Hub) Snapshot() (*brawtv1.Document, uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return proto.Clone(h.doc).(*brawtv1.Document), h.seq
}
