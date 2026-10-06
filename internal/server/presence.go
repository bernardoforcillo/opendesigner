package server

import (
	"sync"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// Input limits. The server sits on a trusted network (LAN) but that is no
// reason to accept a megabyte-long nickname or an endless selection:
// every update is copied and rebroadcast to everyone.
const (
	maxNicknameRunes = 32
	maxSelectionIDs  = 1000
	presenceChanCap  = 256
	defaultNickname  = "Guest"
)

// presenceRoom holds who is watching ONE document. It is ephemeral on purpose:
// it does not write to the op log, it does not survive the process, and a peer exists as long as
// it has a WatchPresence stream open -- no timeouts to tune, no
// "ghosts" after a tab is closed.
type presenceRoom struct {
	mu       sync.Mutex
	peers    map[string]*opendesignerv1.PresenceState // by client_id
	watchers map[*presenceWatcher]struct{}
}

type presenceWatcher struct {
	clientID string
	ch       chan *opendesignerv1.PresenceEvent
}

func newPresenceRoom() *presenceRoom {
	return &presenceRoom{
		peers:    map[string]*opendesignerv1.PresenceState{},
		watchers: map[*presenceWatcher]struct{}{},
	}
}

func cleanNickname(n string) string {
	if utf8.RuneCountInString(n) > maxNicknameRunes {
		r := []rune(n)
		n = string(r[:maxNicknameRunes])
	}
	if n == "" {
		return defaultNickname
	}
	return n
}

// join registers a client and returns the event channel (already filled with
// whoever was there before it) and the function to leave. Joining and announcing
// itself to the others happen in the same step under the lock, so no update can fall
// between the "initial list" and "live".
func (r *presenceRoom) join(clientID, nickname string) (<-chan *opendesignerv1.PresenceEvent, func()) {
	r.mu.Lock()
	defer r.mu.Unlock()

	w := &presenceWatcher{clientID: clientID, ch: make(chan *opendesignerv1.PresenceEvent, presenceChanCap)}
	// The initial list: all the other peers. The channel has room for the
	// list only if the peers are few -- it is a design room, not a
	// concert -- and whatever does not fit is silently lost, like any update.
	for id, st := range r.peers {
		if id == clientID {
			continue
		}
		r.sendLocked(w, &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_Update{Update: proto.Clone(st).(*opendesignerv1.PresenceState)}})
	}
	st := &opendesignerv1.PresenceState{ClientId: clientID, Nickname: cleanNickname(nickname)}
	r.peers[clientID] = st
	r.watchers[w] = struct{}{}
	r.broadcastLocked(clientID, &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_Update{Update: proto.Clone(st).(*opendesignerv1.PresenceState)}})

	var once sync.Once
	leave := func() {
		once.Do(func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			delete(r.watchers, w)
			// The same client may have a second stream (a reconnection that
			// precedes the closing of the old one): the peer leaves only when
			// none of its streams remain.
			for other := range r.watchers {
				if other.clientID == clientID {
					return
				}
			}
			delete(r.peers, clientID)
			r.broadcastLocked(clientID, &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_LeftClientId{LeftClientId: clientID}})
		})
	}
	return w.ch, leave
}

// update applies cursor/selection/page of a client that has already joined. The
// nickname is NOT changed from here: join set it, and an update cannot
// pass itself off as someone else. It returns false for an unknown client.
func (r *presenceRoom) update(in *opendesignerv1.PresenceState) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, ok := r.peers[in.GetClientId()]
	if !ok {
		return false
	}
	sel := in.GetSelection()
	if len(sel) > maxSelectionIDs {
		sel = sel[:maxSelectionIDs]
	}
	cur.HasCursor = in.GetHasCursor()
	cur.CursorX = in.GetCursorX()
	cur.CursorY = in.GetCursorY()
	cur.PageId = in.GetPageId()
	cur.Selection = append([]string(nil), sel...)
	r.broadcastLocked(cur.GetClientId(), &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_Update{Update: proto.Clone(cur).(*opendesignerv1.PresenceState)}})
	return true
}

// broadcastLocked sends the event to everyone except whoever generated it (it does not
// need to know where its own cursor is).
func (r *presenceRoom) broadcastLocked(from string, ev *opendesignerv1.PresenceEvent) {
	for w := range r.watchers {
		if w.clientID == from {
			continue
		}
		r.sendLocked(w, ev)
	}
}

// sendLocked never blocks: presence is lossy by construction (the next
// update replaces the previous one), so a slow watcher skips an event
// instead of stopping the writer.
func (r *presenceRoom) sendLocked(w *presenceWatcher, ev *opendesignerv1.PresenceEvent) {
	select {
	case w.ch <- ev:
	default:
	}
}
