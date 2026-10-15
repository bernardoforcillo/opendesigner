package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestCommentTools: an agent starts a thread on a node, someone replies, the thread is
// resolved and hidden by default, and bad input is refused with a reason.
func TestCommentTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	card := frame(t, s, "Card")

	root, err := s.AddComment(ctx, odmcp.AddCommentInput{Text: "The radius looks off", NodeId: card, X: 4, Y: 6})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddComment(ctx, odmcp.AddCommentInput{Text: "Fixed", ReplyTo: root.CommentId, Author: "Ada"}); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListComments(ctx, odmcp.ListCommentsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Comments) != 2 || list.Comments[0].Id != root.CommentId || list.Comments[0].NodeName != "Card" ||
		list.Comments[0].Author != "Claude" || list.Comments[1].ParentId != root.CommentId || list.Comments[1].Author != "Ada" {
		t.Fatalf("list = %+v", list.Comments)
	}
	if _, err := s.ResolveComment(ctx, odmcp.ResolveCommentInput{Id: root.CommentId}); err != nil {
		t.Fatal(err)
	}
	if l, _ := s.ListComments(ctx, odmcp.ListCommentsInput{}); len(l.Comments) != 0 {
		t.Fatalf("resolved threads must be hidden by default: %+v", l.Comments)
	}
	if l, _ := s.ListComments(ctx, odmcp.ListCommentsInput{IncludeResolved: true}); len(l.Comments) != 2 || !l.Comments[0].Resolved {
		t.Fatalf("includeResolved = %+v", l.Comments)
	}
	for name, in := range map[string]odmcp.AddCommentInput{
		"empty text":     {Text: "", NodeId: card},
		"unknown node":   {Text: "x", NodeId: "ghost"},
		"unknown thread": {Text: "x", ReplyTo: "ghost"},
		"unknown page":   {Text: "x", PageId: "nope"},
	} {
		if _, err := s.AddComment(ctx, in); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	if _, err := s.DeleteComment(ctx, odmcp.IdInput{Id: root.CommentId}); err != nil {
		t.Fatal(err)
	}
	if l, _ := s.ListComments(ctx, odmcp.ListCommentsInput{IncludeResolved: true}); len(l.Comments) != 0 {
		t.Fatalf("deleting the root must take its replies: %+v", l.Comments)
	}
}
