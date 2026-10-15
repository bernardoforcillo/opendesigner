package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
)

func recv(t *testing.T, ch <-chan *opendesignerv1.PresenceEvent) *opendesignerv1.PresenceEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a presence event")
		return nil
	}
}

func none(t *testing.T, ch <-chan *opendesignerv1.PresenceEvent) {
	t.Helper()
	select {
	case ev := <-ch:
		t.Fatalf("unexpected event %v", ev)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPresenceJoinSeesExistingAndAnnouncesItself(t *testing.T) {
	r := newPresenceRoom()
	aCh, leaveA := r.join("a", "Ada")
	defer leaveA()
	none(t, aCh) // nobody else yet, and a never hears about itself

	bCh, leaveB := r.join("b", "Bob")
	defer leaveB()

	if got := recv(t, bCh).GetUpdate(); got.GetClientId() != "a" || got.GetNickname() != "Ada" {
		t.Fatalf("b's initial roster = %v, want a/Ada", got)
	}
	if got := recv(t, aCh).GetUpdate(); got.GetClientId() != "b" || got.GetNickname() != "Bob" {
		t.Fatalf("a was told %v, want b/Bob", got)
	}
}

func TestPresenceUpdateGoesToOthersOnly(t *testing.T) {
	r := newPresenceRoom()
	aCh, leaveA := r.join("a", "Ada")
	defer leaveA()
	bCh, leaveB := r.join("b", "Bob")
	defer leaveB()
	recv(t, bCh) // roster
	recv(t, aCh) // b joined

	ok := r.update(&opendesignerv1.PresenceState{
		ClientId: "a", Nickname: "HACKER", HasCursor: true, CursorX: 10, CursorY: 20,
		PageId: "p1", Selection: []string{"n1", "n2"},
	})
	if !ok {
		t.Fatal("update for a joined client was refused")
	}
	got := recv(t, bCh).GetUpdate()
	if got.GetCursorX() != 10 || got.GetCursorY() != 20 || !got.GetHasCursor() || len(got.GetSelection()) != 2 || got.GetPageId() != "p1" {
		t.Fatalf("b saw %v", got)
	}
	if got.GetNickname() != "Ada" {
		t.Fatalf("an update changed the nickname to %q; only join may set it", got.GetNickname())
	}
	none(t, aCh)
}

func TestPresenceUnknownClientIsIgnored(t *testing.T) {
	r := newPresenceRoom()
	if r.update(&opendesignerv1.PresenceState{ClientId: "ghost"}) {
		t.Fatal("update from a client that never joined was accepted")
	}
	if len(r.peers) != 0 {
		t.Fatalf("a ghost update created a peer: %v", r.peers)
	}
}

func TestPresenceLeaveAnnouncesAndReconnectDoesNot(t *testing.T) {
	r := newPresenceRoom()
	aCh, leaveA := r.join("a", "Ada")
	defer leaveA()
	_, leaveB := r.join("b", "Bob")
	recv(t, aCh) // b joined

	// b reconnects: the new stream joins before the old one ends. Closing the
	// old one must NOT make b vanish for everyone.
	_, leaveB2 := r.join("b", "Bob")
	recv(t, aCh) // b's re-join update
	leaveB()
	none(t, aCh)

	leaveB2()
	if got := recv(t, aCh).GetLeftClientId(); got != "b" {
		t.Fatalf("left event = %q, want b", got)
	}
	leaveB2() // idempotent
	none(t, aCh)
}

func TestPresenceLimits(t *testing.T) {
	r := newPresenceRoom()
	_, leave := r.join("a", strings.Repeat("é", 100))
	defer leave()
	if n := []rune(r.peers["a"].GetNickname()); len(n) != maxNicknameRunes {
		t.Fatalf("nickname has %d runes, want it cut to %d", len(n), maxNicknameRunes)
	}
	_, leave2 := r.join("b", "")
	defer leave2()
	if r.peers["b"].GetNickname() != defaultNickname {
		t.Fatalf("empty nickname became %q, want the default", r.peers["b"].GetNickname())
	}
	sel := make([]string, maxSelectionIDs+50)
	r.update(&opendesignerv1.PresenceState{ClientId: "a", Selection: sel})
	if got := len(r.peers["a"].GetSelection()); got != maxSelectionIDs {
		t.Fatalf("selection kept %d ids, want %d", got, maxSelectionIDs)
	}
}

// Over the real transport: two browsers' worth of clients on one document see
// each other, and closing a stream removes the peer.
func TestPresenceOverTheWire(t *testing.T) {
	svc := NewDocumentService(NewManager(t.TempDir()))
	path, handler := opendesignerv1connect.NewDocumentServiceHandler(svc)
	srv := httptest.NewUnstartedServer(httpMux(path, handler))
	srv.Config.Protocols = serverProtocols()
	srv.Start()
	t.Cleanup(srv.Close)
	client := opendesignerv1connect.NewDocumentServiceClient(
		&http.Client{Transport: &http.Transport{Protocols: clientProtocols()}}, srv.URL)

	ctx := context.Background()
	info, err := client.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "P"}))
	if err != nil {
		t.Fatal(err)
	}
	doc := info.Msg.GetId()

	watch := func(id, nick string) (*connect.ServerStreamForClient[opendesignerv1.PresenceEvent], context.CancelFunc) {
		c, cancel := context.WithCancel(ctx)
		st, err := client.WatchPresence(c, connect.NewRequest(&opendesignerv1.WatchPresenceRequest{DocId: doc, ClientId: id, Nickname: nick}))
		if err != nil {
			t.Fatalf("WatchPresence %s: %v", id, err)
		}
		return st, cancel
	}
	// The first message is always the empty "ready"; we consume it in the
	// helper so the tests only read real events.
	ready := func(st *connect.ServerStreamForClient[opendesignerv1.PresenceEvent]) {
		t.Helper()
		if !st.Receive() || st.Msg().GetKind() != nil {
			t.Fatalf("first message = %v (err %v), want the empty ready event", st.Msg(), st.Err())
		}
	}
	next := func(st *connect.ServerStreamForClient[opendesignerv1.PresenceEvent]) *opendesignerv1.PresenceEvent {
		t.Helper()
		type res struct {
			ev *opendesignerv1.PresenceEvent
			ok bool
		}
		ch := make(chan res, 1)
		go func() { ok := st.Receive(); ch <- res{st.Msg(), ok} }()
		select {
		case r := <-ch:
			if !r.ok {
				t.Fatalf("stream ended: %v", st.Err())
			}
			return r.ev
		case <-time.After(3 * time.Second):
			t.Fatal("timed out")
			return nil
		}
	}

	a, cancelA := watch("a", "Ada")
	defer cancelA()
	ready(a)
	// a is alone; join b and a must hear about it.
	b, cancelB := watch("b", "Bob")
	ready(b)
	if got := next(a).GetUpdate(); got.GetNickname() != "Bob" {
		t.Fatalf("a heard %v, want Bob", got)
	}
	if got := next(b).GetUpdate(); got.GetNickname() != "Ada" {
		t.Fatalf("b's roster = %v, want Ada", got)
	}

	if _, err := client.UpdatePresence(ctx, connect.NewRequest(&opendesignerv1.UpdatePresenceRequest{
		DocId: doc, State: &opendesignerv1.PresenceState{ClientId: "b", HasCursor: true, CursorX: 5, CursorY: 6},
	})); err != nil {
		t.Fatalf("UpdatePresence: %v", err)
	}
	if got := next(a).GetUpdate(); got.GetCursorX() != 5 || got.GetCursorY() != 6 {
		t.Fatalf("a saw cursor %v, want 5,6", got)
	}

	cancelB()
	if got := next(a).GetLeftClientId(); got != "b" {
		t.Fatalf("a heard left=%q, want b", got)
	}
}

func TestPresenceFacilitationIsRelayedAndBounded(t *testing.T) {
	r := newPresenceRoom()
	_, leaveA := r.join("a", "Ada")
	defer leaveA()
	bCh, leaveB := r.join("b", "Bob")
	defer leaveB()
	recv(t, bCh) // a's join

	votes := make([]string, maxVotes+10)
	for i := range votes {
		votes[i] = "n"
	}
	r.update(&opendesignerv1.PresenceState{
		ClientId: "a", HasView: true, ViewX: 10, ViewY: 20, ViewZoom: 2,
		Chat: strings.Repeat("é", maxChatRunes+30), Reaction: "👍", EmoteSeq: 3, Votes: votes,
		TimerStartedMs: 1000, TimerEndMs: 301000, TimerLabel: "Brainstorm",
	})
	got := recv(t, bCh).GetUpdate()
	if !got.GetHasView() || got.GetViewX() != 10 || got.GetViewZoom() != 2 {
		t.Fatalf("view not relayed: %v", got)
	}
	if n := len([]rune(got.GetChat())); n != maxChatRunes {
		t.Fatalf("chat kept %d runes, want %d", n, maxChatRunes)
	}
	if got.GetReaction() != "👍" || got.GetEmoteSeq() != 3 {
		t.Fatalf("reaction = %q/%d", got.GetReaction(), got.GetEmoteSeq())
	}
	if len(got.GetVotes()) != maxVotes {
		t.Fatalf("votes kept %d, want %d", len(got.GetVotes()), maxVotes)
	}
	if got.GetTimerEndMs() != 301000 || got.GetTimerLabel() != "Brainstorm" {
		t.Fatalf("timer = %d/%q", got.GetTimerEndMs(), got.GetTimerLabel())
	}

	// A timer that ends before it starts, or lasts more than a day, is dropped.
	r.update(&opendesignerv1.PresenceState{ClientId: "a", TimerStartedMs: 5000, TimerEndMs: 1000, TimerLabel: "x"})
	if got := recv(t, bCh).GetUpdate(); got.GetTimerEndMs() != 0 || got.GetTimerLabel() != "" {
		t.Fatalf("a backwards timer was kept: %v", got)
	}
	r.update(&opendesignerv1.PresenceState{ClientId: "a", TimerStartedMs: 1, TimerEndMs: 1 + maxTimerMillis + 1})
	if got := recv(t, bCh).GetUpdate(); got.GetTimerEndMs() != 0 {
		t.Fatalf("a week-long timer was kept: %v", got)
	}
}
