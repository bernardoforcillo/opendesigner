package mcp

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/proto"
)

// COMMENT tools: agents read the review threads pinned on the canvas, answer them and
// resolve them. The model is in internal/core/comments.go; a comment has a thread (a root
// plus replies), and is attached to a node or free on a page.

// agentAuthor is the name comments carry when an agent writes them.
const agentAuthor = "Claude"

type CommentView struct {
	Id        string  `json:"id"`
	ParentId  string  `json:"parentId,omitempty" jsonschema:"set on a reply: the root comment of its thread"`
	NodeId    string  `json:"nodeId,omitempty" jsonschema:"the node the thread is pinned to"`
	NodeName  string  `json:"nodeName,omitempty"`
	PageId    string  `json:"pageId,omitempty" jsonschema:"for a free thread: the page it sits on"`
	X         float64 `json:"x,omitempty" jsonschema:"offset from the node's top-left corner, or the world x of a free thread"`
	Y         float64 `json:"y,omitempty"`
	Author    string  `json:"author,omitempty"`
	Text      string  `json:"text"`
	CreatedAt int64   `json:"createdAt,omitempty" jsonschema:"unix seconds"`
	Resolved  bool    `json:"resolved,omitempty"`
}

type ListCommentsInput struct {
	IncludeResolved bool   `json:"includeResolved,omitempty" jsonschema:"also list the resolved threads (default: only open ones)"`
	NodeId          string `json:"nodeId,omitempty" jsonschema:"only the threads pinned to this node"`
}

type ListCommentsOutput struct {
	Comments []CommentView `json:"comments" jsonschema:"roots and their replies, threads oldest first, each reply right after its root"`
}

func commentView(s *Session, c *opendesignerv1.Comment) CommentView {
	v := CommentView{
		Id: c.GetId(), ParentId: c.GetParentId(), NodeId: c.GetNodeId(), PageId: c.GetPageId(),
		X: c.GetX(), Y: c.GetY(), Author: c.GetAuthor(), Text: c.GetText(), CreatedAt: c.GetCreatedAt(), Resolved: c.GetResolved(),
	}
	if c.GetNodeId() != "" {
		v.NodeName = nameOf(s.doc, c.GetNodeId())
	}
	return v
}

func (s *Session) ListComments(_ context.Context, in ListCommentsInput) (ListCommentsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var roots []*opendesignerv1.Comment
	replies := map[string][]*opendesignerv1.Comment{}
	for _, c := range s.doc.GetComments() {
		if c.GetParentId() == "" {
			roots = append(roots, c)
		} else {
			replies[c.GetParentId()] = append(replies[c.GetParentId()], c)
		}
	}
	byAge := func(l []*opendesignerv1.Comment) {
		sort.Slice(l, func(i, j int) bool {
			if l[i].GetCreatedAt() != l[j].GetCreatedAt() {
				return l[i].GetCreatedAt() < l[j].GetCreatedAt()
			}
			return l[i].GetId() < l[j].GetId()
		})
	}
	byAge(roots)
	out := ListCommentsOutput{Comments: []CommentView{}}
	for _, r := range roots {
		if r.GetResolved() && !in.IncludeResolved {
			continue
		}
		if in.NodeId != "" && r.GetNodeId() != in.NodeId {
			continue
		}
		out.Comments = append(out.Comments, commentView(s, r))
		rs := replies[r.GetId()]
		byAge(rs)
		for _, x := range rs {
			out.Comments = append(out.Comments, commentView(s, x))
		}
	}
	return out, nil
}

type AddCommentInput struct {
	Text    string  `json:"text" jsonschema:"1..4000 characters"`
	ReplyTo string  `json:"replyTo,omitempty" jsonschema:"id of the thread's ROOT comment to answer; omit to start a new thread"`
	NodeId  string  `json:"nodeId,omitempty" jsonschema:"new thread: pin it to this node"`
	X       float64 `json:"x,omitempty" jsonschema:"new thread: offset from the node's top-left corner (or the world x when no nodeId)"`
	Y       float64 `json:"y,omitempty"`
	PageId  string  `json:"pageId,omitempty" jsonschema:"new free thread: the page (default: the first)"`
	Author  string  `json:"author,omitempty" jsonschema:"default \"Claude\""`
}

type AddCommentOutput struct {
	CommentId string `json:"commentId"`
	Seq       uint64 `json:"seq"`
}

func (s *Session) AddComment(ctx context.Context, in AddCommentInput) (AddCommentOutput, error) {
	author := in.Author
	if author == "" {
		author = agentAuthor
	}
	c := &opendesignerv1.Comment{Id: uuid.NewString(), Author: author, Text: in.Text, CreatedAt: time.Now().Unix()}
	s.mu.Lock()
	if in.ReplyTo != "" {
		c.ParentId = in.ReplyTo
	} else {
		c.NodeId, c.X, c.Y = in.NodeId, in.X, in.Y
		if in.NodeId == "" {
			c.PageId = in.PageId
			if c.PageId == "" && len(s.doc.GetPages()) > 0 {
				c.PageId = s.doc.GetPages()[0].GetId()
			}
		}
	}
	err := core.ValidateComment(s.doc, c)
	s.mu.Unlock()
	if err != nil {
		return AddCommentOutput{}, fmt.Errorf("add_comment: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComment{SetComment: &opendesignerv1.SetComment{Comment: c}}})
	if err != nil {
		return AddCommentOutput{}, err
	}
	return AddCommentOutput{CommentId: c.GetId(), Seq: seq}, nil
}

type ResolveCommentInput struct {
	Id       string `json:"id" jsonschema:"id of the thread's root comment"`
	Resolved *bool  `json:"resolved,omitempty" jsonschema:"default true; false reopens the thread"`
}

func (s *Session) ResolveComment(ctx context.Context, in ResolveCommentInput) (SeqOutput, error) {
	s.mu.Lock()
	root, ok := s.doc.GetComments()[in.Id]
	var next *opendesignerv1.Comment
	if ok {
		next = cloneComment(root)
	}
	s.mu.Unlock()
	if !ok || root.GetParentId() != "" {
		return SeqOutput{}, fmt.Errorf("resolve_comment: %q is not the root of a thread (list_comments)", in.Id)
	}
	next.Resolved = in.Resolved == nil || *in.Resolved
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComment{SetComment: &opendesignerv1.SetComment{Comment: next}}})
	return SeqOutput{Seq: seq}, err
}

func (s *Session) DeleteComment(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetComments()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_comment: comment %q not found (list_comments)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteComment{DeleteComment: &opendesignerv1.DeleteComment{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

func registerCommentTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_comments", "List the review comments pinned on the canvas: open threads by default (a root comment, then its replies). Read them before changing a design, answer with add_comment, and resolve what you fixed.", s.ListComments)
	addTool(srv, "add_comment", "Start a comment thread pinned to a node (nodeId, x/y offset from its top-left) or free on a page, or answer a thread (replyTo = the root comment id). Signed \"Claude\" unless `author` is given.", s.AddComment)
	addTool(srv, "resolve_comment", "Resolve (or reopen, with resolved:false) a comment thread by its root comment id.", s.ResolveComment)
	addTool(srv, "delete_comment", "Delete a comment; deleting a thread's root deletes its replies.", s.DeleteComment)
}

func cloneComment(c *opendesignerv1.Comment) *opendesignerv1.Comment {
	return proto.Clone(c).(*opendesignerv1.Comment)
}
