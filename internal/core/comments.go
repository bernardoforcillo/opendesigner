package core

import (
	"fmt"
	"math"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// COMMENTS pinned on the canvas (see the proto). The invariants, mirrored by
// web/src/store/comments.ts:
//
//  1. a comment has an id and a non-empty text of up to MaxCommentRunes characters, and an
//     author of up to MaxCommentAuthorRunes;
//  2. a REPLY (parent_id set) points to an existing ROOT -- replies do not nest -- and
//     carries no node, page or position; a root cannot become a reply or the reverse;
//  3. a root attached to a node points to an existing node; a free root points to an
//     existing page; coordinates are finite;
//  4. a root cannot be edited into a reply of itself, and deleting a root takes its
//     replies with it.
//
// A node that disappears does NOT take its comments along: they stay in the document with
// their node_id (undoing the deletion brings the pins back) and the editor lists them as
// orphaned.
const (
	MaxCommentRunes       = 4000
	MaxCommentAuthorRunes = 80
)

// ValidateComment is validateComment for callers outside the package (the MCP tools).
func ValidateComment(doc *opendesignerv1.Document, c *opendesignerv1.Comment) error {
	return validateComment(doc, c)
}

func validateComment(doc *opendesignerv1.Document, c *opendesignerv1.Comment) error {
	if c == nil || c.GetId() == "" {
		return fmt.Errorf("%w: missing id", ErrComment)
	}
	if n := utf8.RuneCountInString(c.GetText()); n == 0 || n > MaxCommentRunes {
		return fmt.Errorf("%w: text must have 1..%d characters (comment %s)", ErrComment, MaxCommentRunes, c.GetId())
	}
	if utf8.RuneCountInString(c.GetAuthor()) > MaxCommentAuthorRunes {
		return fmt.Errorf("%w: author too long (comment %s)", ErrComment, c.GetId())
	}
	if c.GetCreatedAt() < 0 {
		return fmt.Errorf("%w: negative creation time (comment %s)", ErrComment, c.GetId())
	}
	prev := doc.GetComments()[c.GetId()]
	if prev != nil && prev.GetParentId() != c.GetParentId() {
		return fmt.Errorf("%w: a comment cannot change its thread (comment %s)", ErrComment, c.GetId())
	}
	if c.GetParentId() != "" {
		if c.GetParentId() == c.GetId() {
			return fmt.Errorf("%w: a comment cannot reply to itself (comment %s)", ErrComment, c.GetId())
		}
		root := doc.GetComments()[c.GetParentId()]
		if root == nil || root.GetParentId() != "" {
			return fmt.Errorf("%w: a reply needs an existing root comment (comment %s)", ErrComment, c.GetId())
		}
		if c.GetNodeId() != "" || c.GetPageId() != "" || c.GetX() != 0 || c.GetY() != 0 || c.GetResolved() {
			return fmt.Errorf("%w: a reply carries no position, node, page or resolved flag (comment %s)", ErrComment, c.GetId())
		}
		return nil
	}
	if math.IsNaN(c.GetX()) || math.IsInf(c.GetX(), 0) || math.IsNaN(c.GetY()) || math.IsInf(c.GetY(), 0) {
		return fmt.Errorf("%w: non-finite position (comment %s)", ErrComment, c.GetId())
	}
	if c.GetNodeId() != "" {
		if !nodeExists(doc, c.GetNodeId()) {
			return fmt.Errorf("%w: %s (comment %s node)", ErrNodeNotFound, c.GetNodeId(), c.GetId())
		}
		if c.GetPageId() != "" {
			return fmt.Errorf("%w: a comment on a node has no page (comment %s)", ErrComment, c.GetId())
		}
		return nil
	}
	for _, p := range doc.GetPages() {
		if p.GetId() == c.GetPageId() {
			return nil
		}
	}
	return fmt.Errorf("%w: page %q does not exist (comment %s)", ErrComment, c.GetPageId(), c.GetId())
}

func applySetComment(doc *opendesignerv1.Document, s *opendesignerv1.SetComment) error {
	c := s.GetComment()
	if err := validateComment(doc, c); err != nil {
		return err
	}
	if doc.Comments == nil {
		doc.Comments = map[string]*opendesignerv1.Comment{}
	}
	doc.Comments[c.GetId()] = proto.Clone(c).(*opendesignerv1.Comment)
	return nil
}

func applyDeleteComment(doc *opendesignerv1.Document, d *opendesignerv1.DeleteComment) error {
	c, ok := doc.GetComments()[d.GetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrCommentNotFound, d.GetId())
	}
	delete(doc.Comments, d.GetId())
	if c.GetParentId() == "" {
		for id, r := range doc.GetComments() {
			if r.GetParentId() == d.GetId() {
				delete(doc.Comments, id)
			}
		}
	}
	return nil
}
