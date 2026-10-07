package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// DefaultNickname is how the agent appears to the people in the document.
const DefaultNickname = "Claude"

// PresenceLoop makes the agent show up in the document like another person: it
// joins the presence room under nickname and keeps the stream open, so the web
// clients list it and, through announce, outline the nodes it is working on.
// It blocks until ctx ends and reconnects with backoff; presence is a nicety,
// so a failure here is logged and never touches editing.
func (s *Session) PresenceLoop(ctx context.Context, nickname string) {
	if nickname == "" {
		nickname = DefaultNickname
	}
	s.mu.Lock()
	s.nickname = nickname
	s.mu.Unlock()
	backoff := minBackoff
	for ctx.Err() == nil {
		started := time.Now()
		// Each stream has its own context, so a name change can end it and the loop rejoins under the new name.
		sctx, cancel := context.WithCancel(ctx)
		s.mu.Lock()
		s.restart = cancel
		name := s.nickname
		s.mu.Unlock()
		err := s.watchOnce(sctx, name)
		cancel()
		s.setJoined(false)
		if ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		renamed := s.nickname != name
		s.mu.Unlock()
		if renamed {
			backoff = minBackoff
			continue // a deliberate rejoin: no waiting
		}
		s.logf("presence stream ended: %v (reconnecting)", err)
		if time.Since(started) > maxBackoff {
			backoff = minBackoff
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (s *Session) watchOnce(ctx context.Context, nickname string) error {
	stream, err := s.client.WatchPresence(ctx, connect.NewRequest(&opendesignerv1.WatchPresenceRequest{
		DocId: s.docID, ClientId: s.clientID, Nickname: nickname,
	}))
	if err != nil {
		return err
	}
	defer stream.Close()
	// A reconnect starts from a clean roster: the stream replays whoever is
	// there, and anyone who left meanwhile must not linger.
	s.mu.Lock()
	s.peers = map[string]*opendesignerv1.PresenceState{}
	s.mu.Unlock()
	for stream.Receive() {
		switch k := stream.Msg().GetKind().(type) {
		case nil:
			// The server's empty "you are in" marker.
			s.setJoined(true)
		case *opendesignerv1.PresenceEvent_Update:
			s.mu.Lock()
			s.peers[k.Update.GetClientId()] = k.Update
			s.mu.Unlock()
		case *opendesignerv1.PresenceEvent_LeftClientId:
			s.mu.Lock()
			delete(s.peers, k.LeftClientId)
			s.mu.Unlock()
		}
	}
	return stream.Err()
}

// PeerView is one other participant, as list_peers reports it.
type PeerView struct {
	ClientId  string   `json:"clientId"`
	Nickname  string   `json:"nickname"`
	PageId    string   `json:"pageId,omitempty" jsonschema:"the page they are looking at"`
	Selection []string `json:"selection" jsonschema:"node ids they have selected or just edited"`
	IsAgent   bool     `json:"isAgent" jsonschema:"true when this participant is another MCP agent rather than a person in the browser"`
}

type ListPeersOutput struct {
	Peers []PeerView `json:"peers"`
}

// ListPeers says who else is in the document and which nodes they are on, so an
// agent can steer clear of what a person or another agent is working on. It
// reports only what the presence stream has delivered; before the agent has
// joined the room it is empty. Nothing is locked or reserved -- it is
// information, not a lock.
func (s *Session) ListPeers(_ context.Context, _ struct{}) (ListPeersOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListPeersOutput{Peers: []PeerView{}}
	for _, p := range s.peers {
		sel := p.GetSelection()
		if sel == nil {
			sel = []string{}
		}
		out.Peers = append(out.Peers, PeerView{
			ClientId: p.GetClientId(), Nickname: p.GetNickname(), PageId: p.GetPageId(), Selection: sel,
			IsAgent: strings.HasPrefix(p.GetClientId(), "mcp-") || p.GetClientId() == s.clientID,
		})
	}
	sort.Slice(out.Peers, func(i, j int) bool { return out.Peers[i].ClientId < out.Peers[j].ClientId })
	return out, nil
}

func (s *Session) setJoined(v bool) {
	s.mu.Lock()
	s.joined = v
	s.mu.Unlock()
}

// opTargets lists the nodes an op is about: what the agent is "looking at"
// right after submitting it. A delete targets nothing, which clears the
// outline; page ops have no node to point at and are skipped by announce.
func opTargets(op *opendesignerv1.Op) (ids []string, relevant bool) {
	switch k := op.GetKind().(type) {
	case *opendesignerv1.Op_CreateNode:
		return []string{k.CreateNode.GetNode().GetId()}, true
	case *opendesignerv1.Op_SetProps:
		return []string{k.SetProps.GetId()}, true
	case *opendesignerv1.Op_SetText:
		return []string{k.SetText.GetId()}, true
	case *opendesignerv1.Op_ReparentNode:
		return []string{k.ReparentNode.GetId()}, true
	case *opendesignerv1.Op_SetVectorPath:
		return []string{k.SetVectorPath.GetId()}, true
	case *opendesignerv1.Op_SetInstanceOverride:
		return []string{k.SetInstanceOverride.GetInstanceId()}, true
	case *opendesignerv1.Op_DeleteNode:
		return nil, true
	}
	return nil, false
}

// announce tells the room which node the agent just touched, so people see a
// coloured outline with its name appear where it is working. Best effort and
// short-lived: an error is dropped, and it does nothing before the agent has
// joined the room.
func (s *Session) announce(ctx context.Context, op *opendesignerv1.Op) {
	ids, relevant := opTargets(op)
	if !relevant {
		return
	}
	s.mu.Lock()
	joined := s.joined
	page := ""
	var sel []string
	for _, id := range ids {
		if _, ok := s.nodeLocked(id); ok {
			sel = append(sel, id)
			if page == "" {
				page = s.pageOfLocked(id)
			}
		}
	}
	s.mu.Unlock()
	if !joined {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := s.client.UpdatePresence(cctx, connect.NewRequest(&opendesignerv1.UpdatePresenceRequest{
		DocId: s.docID,
		State: &opendesignerv1.PresenceState{ClientId: s.clientID, PageId: page, Selection: sel},
	}))
	if err != nil {
		s.logf("presence update: %v", err)
	}
}

func (s *Session) nodeLocked(id string) (*opendesignerv1.Node, bool) {
	for _, n := range s.doc.GetNodes() {
		if n.GetId() == id {
			return n, true
		}
	}
	return nil, false
}

// pageOfLocked walks up from a node to its page: the first parent id that is
// not itself a node. Guarded against a cycle the hub should never allow.
func (s *Session) pageOfLocked(id string) string {
	byID := make(map[string]*opendesignerv1.Node, len(s.doc.GetNodes()))
	for _, n := range s.doc.GetNodes() {
		byID[n.GetId()] = n
	}
	cur := id
	for i := 0; i <= len(byID); i++ {
		n, ok := byID[cur]
		if !ok {
			return cur
		}
		cur = n.GetParentId()
	}
	return ""
}

// PresenceJoined reports whether the agent is currently in the presence room.
func (s *Session) PresenceJoined() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.joined
}

// maxNicknameRunes matches the server's limit (internal/server/presence.go).
const maxNicknameRunes = 32

// SetNicknameInput is the set_nickname tool's input.
type SetNicknameInput struct {
	Nickname string `json:"nickname" jsonschema:"the name to show to the other people in the document (1 to 32 characters)"`
}

// SetNicknameOutput says what name is now in use.
type SetNicknameOutput struct {
	Nickname string `json:"nickname"`
	Joined   bool   `json:"joined" jsonschema:"whether the presence stream is open: the new name is visible to others only once it is"`
}

// SetNickname changes the name this agent shows in the document. The server fixes a name when a
// client joins the room, so the agent leaves and rejoins under the new one (a moment in which it
// is not listed). People change theirs in the top bar; this is the same for an agent.
func (s *Session) SetNickname(_ context.Context, in SetNicknameInput) (SetNicknameOutput, error) {
	name := strings.TrimSpace(in.Nickname)
	if name == "" {
		return SetNicknameOutput{}, errors.New("the nickname cannot be empty")
	}
	if n := utf8.RuneCountInString(name); n > maxNicknameRunes {
		return SetNicknameOutput{}, fmt.Errorf("the nickname is too long (%d characters, at most %d)", n, maxNicknameRunes)
	}
	s.mu.Lock()
	changed := s.nickname != name
	s.nickname = name
	restart := s.restart
	joined := s.joined
	s.mu.Unlock()
	if changed && restart != nil {
		restart()
	}
	return SetNicknameOutput{Nickname: name, Joined: joined && !changed}, nil
}
