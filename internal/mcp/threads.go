package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// Threaded text frames. The link is the meta key below on every frame but the last of a chain; the
// editor derives the flow (see web/src/store/threads.ts). These tools apply the same rules as the editor:
// both ends are text nodes, a frame flows into one other frame, a frame is followed by at most one, and a
// link never closes a cycle.
const metaTextNext = "text.next"

func isTextNode(n *opendesignerv1.Node) bool { return n != nil && n.GetText() != nil }

// nextFrame is the frame n flows into (nil when none, dangling or not a text node).
func nextFrame(doc *opendesignerv1.Document, n *opendesignerv1.Node) *opendesignerv1.Node {
	id := n.GetMeta()[metaTextNext]
	if id == "" || id == n.GetId() {
		return nil
	}
	t := doc.GetNodes()[id]
	if !isTextNode(t) {
		return nil
	}
	return t
}

func followedFrames(doc *opendesignerv1.Document) map[string]bool {
	out := map[string]bool{}
	for _, n := range doc.GetNodes() {
		if t := nextFrame(doc, n); t != nil {
			out[t.GetId()] = true
		}
	}
	return out
}

func headFrame(doc *opendesignerv1.Document, id string) *opendesignerv1.Node {
	prev := map[string]string{}
	for _, n := range doc.GetNodes() {
		if t := nextFrame(doc, n); t != nil {
			prev[t.GetId()] = n.GetId()
		}
	}
	cur := id
	for i := 0; i < len(doc.GetNodes())+1; i++ {
		p, ok := prev[cur]
		if !ok || p == id {
			break
		}
		cur = p
	}
	return doc.GetNodes()[cur]
}

type ThreadTextFramesInput struct {
	Ids []string `json:"ids" jsonschema:"text frames in reading order: each flows into the next. Pairs that cannot be linked are skipped"`
}

type ThreadTextFramesOutput struct {
	Linked int    `json:"linked" jsonschema:"how many links were made"`
	Seq    uint64 `json:"seq"`
}

// ThreadTextFrames chains text frames so the first one's text flows through them. The text of the frames
// that become followers is appended to the first frame's text (nothing is lost) and cleared on them.
func (s *Session) ThreadTextFrames(ctx context.Context, in ThreadTextFramesInput) (ThreadTextFramesOutput, error) {
	type link struct{ from, to string }
	var links []link
	var ops []*opendesignerv1.Op
	s.mu.Lock()
	doc := s.doc
	seen := map[string]bool{}
	var ids []string
	for _, id := range in.Ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if !isTextNode(doc.GetNodes()[id]) {
			s.mu.Unlock()
			return ThreadTextFramesOutput{}, fmt.Errorf("thread_text_frames: %q is not a text node", id)
		}
		ids = append(ids, id)
	}
	next := map[string]string{}
	nextNow := func(id string) string {
		if v, ok := next[id]; ok {
			return v
		}
		if t := nextFrame(doc, doc.GetNodes()[id]); t != nil {
			return t.GetId()
		}
		return ""
	}
	targets := followedFrames(doc)
	var stories []string
	var first *opendesignerv1.Node
	for i := 0; i+1 < len(ids); i++ {
		a, b := ids[i], ids[i+1]
		if nextNow(a) != "" || targets[b] {
			continue
		}
		cycle := false
		for cur, guard := b, 0; cur != "" && guard < len(doc.GetNodes())+2; cur, guard = nextNow(cur), guard+1 {
			if cur == a {
				cycle = true
				break
			}
		}
		if cycle {
			continue
		}
		next[a], targets[b] = b, true
		links = append(links, link{a, b})
		na, nb := doc.GetNodes()[a], doc.GetNodes()[b]
		meta := map[string]string{}
		for k, v := range na.GetMeta() {
			meta[k] = v
		}
		meta[metaTextNext] = b
		ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: a, Patch: &opendesignerv1.Node{Meta: meta}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"meta"}},
		}}})
		if first == nil {
			first = headFrame(doc, a)
			stories = append(stories, first.GetText().GetContent())
		}
		if strings.TrimSpace(nb.GetText().GetContent()) != "" {
			stories = append(stories, nb.GetText().GetContent())
			ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{Id: b, Content: ""}}})
		}
	}
	if first != nil && len(stories) > 1 {
		ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{Id: first.GetId(), Content: strings.Join(stories, "\n")}}})
	}
	s.mu.Unlock()
	if len(ops) == 0 {
		return ThreadTextFramesOutput{}, errors.New("thread_text_frames: nothing to link (needs two or more text frames that are not already linked, and no cycle)")
	}
	var seq uint64
	for _, op := range ops {
		var err error
		if seq, err = s.submit(ctx, op); err != nil {
			return ThreadTextFramesOutput{}, err
		}
	}
	return ThreadTextFramesOutput{Linked: len(links), Seq: seq}, nil
}

// UnlinkTextFrame cuts the chain after a frame; the text stays with the first part.
func (s *Session) UnlinkTextFrame(ctx context.Context, in PageIdInput) (SeqOutput, error) {
	s.mu.Lock()
	n := s.doc.GetNodes()[in.Id]
	if n == nil || n.GetMeta()[metaTextNext] == "" {
		s.mu.Unlock()
		return SeqOutput{}, fmt.Errorf("unlink_text_frame: %q is not a frame that flows into another", in.Id)
	}
	meta := map[string]string{}
	for k, v := range n.GetMeta() {
		if k != metaTextNext {
			meta[k] = v
		}
	}
	s.mu.Unlock()
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: in.Id, Patch: &opendesignerv1.Node{Meta: meta}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"meta"}},
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

func registerThreadTools(srv *mcp.Server, s *Session) {
	addTool(srv, "thread_text_frames", "Chain text frames: the first frame's text flows into the next as each one fills, in the first frame's style (like linked text frames in a layout tool). Pass the frames in reading order; text already in the later frames is appended to the first frame's. The link is the node meta text.next. Editing a frame of a chain means editing the first frame's text (set_text on it).", s.ThreadTextFrames)
	addTool(srv, "unlink_text_frame", "Cut a text chain after the given frame (removes its text.next); the text stays with the first part.", s.UnlinkTextFrame)
}
