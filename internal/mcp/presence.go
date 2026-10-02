package mcp

import (
	"context"
	"time"

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
	backoff := minBackoff
	for ctx.Err() == nil {
		started := time.Now()
		err := s.watchOnce(ctx, nickname)
		s.setJoined(false)
		if ctx.Err() != nil {
			return
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
	for stream.Receive() {
		// The first message is the server's empty "you are in" marker; the
		// others describe the people, which an agent has no use for.
		if stream.Msg().GetKind() == nil {
			s.setJoined(true)
		}
	}
	return stream.Err()
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
