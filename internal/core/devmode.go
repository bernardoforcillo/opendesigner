package core

import (
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// DEV MODE: annotations and "ready for dev" frames (see the proto). The invariants, mirrored by
// web/src/store/devMode.ts:
//
//  1. an annotation has an id, an existing node, one of AnnotationCategories, a non-empty text of
//     up to MaxAnnotationRunes characters and an author of up to MaxDevAuthorRunes;
//  2. only a FRAME can be marked ready; marking it again replaces the entry, i.e. takes a new
//     baseline; the note has up to MaxReadyNoteRunes characters;
//  3. the server writes the snapshot (the frame and its descendants as they are NOW); whatever
//     snapshot an op carries is ignored, so the baseline is always the document's own history.
//
// A node that disappears does not take its annotations or its ready entry along: undoing the
// deletion brings them back, and the editor and the tools list them as orphaned.
var (
	ErrAnnotation         = errors.New("core: invalid annotation")
	ErrAnnotationNotFound = errors.New("core: annotation not found")
	ErrReadyForDev        = errors.New("core: invalid ready-for-dev entry")
	ErrReadyNotFound      = errors.New("core: frame is not marked ready for dev")
)

const (
	MaxAnnotationRunes = 2000
	MaxReadyNoteRunes  = 500
	MaxDevAuthorRunes  = 80
)

// AnnotationCategories are the categories an annotation can have, in display order.
var AnnotationCategories = []string{"note", "interaction", "accessibility", "content", "animation", "layout"}

// AnnotationColors is the colour each category is drawn with (hex), in Dev Mode and in the
// handoff. Mirrored by web/src/store/devMode.ts.
var AnnotationColors = map[string]string{
	"note": "#8a8f98", "interaction": "#3b82f6", "accessibility": "#22c55e",
	"content": "#f59e0b", "animation": "#a855f7", "layout": "#ef4444",
}

// ValidAnnotationCategory reports whether c is one of AnnotationCategories.
func ValidAnnotationCategory(c string) bool {
	for _, x := range AnnotationCategories {
		if x == c {
			return true
		}
	}
	return false
}

// ValidateAnnotation is validateAnnotation for callers outside the package (the MCP tools).
func ValidateAnnotation(doc *opendesignerv1.Document, a *opendesignerv1.Annotation) error {
	return validateAnnotation(doc, a)
}

func validateAnnotation(doc *opendesignerv1.Document, a *opendesignerv1.Annotation) error {
	if a == nil || a.GetId() == "" {
		return fmt.Errorf("%w: missing id", ErrAnnotation)
	}
	if !ValidAnnotationCategory(a.GetCategory()) {
		return fmt.Errorf("%w: category %q is not one of %v (annotation %s)", ErrAnnotation, a.GetCategory(), AnnotationCategories, a.GetId())
	}
	if n := utf8.RuneCountInString(a.GetText()); n == 0 || n > MaxAnnotationRunes {
		return fmt.Errorf("%w: text must have 1..%d characters (annotation %s)", ErrAnnotation, MaxAnnotationRunes, a.GetId())
	}
	if utf8.RuneCountInString(a.GetAuthor()) > MaxDevAuthorRunes {
		return fmt.Errorf("%w: author too long (annotation %s)", ErrAnnotation, a.GetId())
	}
	if a.GetCreatedAt() < 0 {
		return fmt.Errorf("%w: negative creation time (annotation %s)", ErrAnnotation, a.GetId())
	}
	if !nodeExists(doc, a.GetNodeId()) {
		return fmt.Errorf("%w: %s (annotation %s node)", ErrNodeNotFound, a.GetNodeId(), a.GetId())
	}
	return nil
}

func applySetAnnotation(doc *opendesignerv1.Document, s *opendesignerv1.SetAnnotation) error {
	a := s.GetAnnotation()
	if err := validateAnnotation(doc, a); err != nil {
		return err
	}
	if doc.Annotations == nil {
		doc.Annotations = map[string]*opendesignerv1.Annotation{}
	}
	doc.Annotations[a.GetId()] = proto.Clone(a).(*opendesignerv1.Annotation)
	return nil
}

func applyDeleteAnnotation(doc *opendesignerv1.Document, d *opendesignerv1.DeleteAnnotation) error {
	if _, ok := doc.GetAnnotations()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrAnnotationNotFound, d.GetId())
	}
	delete(doc.Annotations, d.GetId())
	return nil
}

// ValidateReady is the check applySetReadyForDev makes, for callers outside the package.
func ValidateReady(doc *opendesignerv1.Document, r *opendesignerv1.ReadyForDev) error {
	return validateReady(doc, r)
}

func validateReady(doc *opendesignerv1.Document, r *opendesignerv1.ReadyForDev) error {
	if r == nil || r.GetNodeId() == "" {
		return fmt.Errorf("%w: missing node id", ErrReadyForDev)
	}
	n := doc.GetNodes()[r.GetNodeId()]
	if n == nil {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, r.GetNodeId())
	}
	if _, ok := n.GetShape().(*opendesignerv1.Node_Frame); !ok {
		return fmt.Errorf("%w: %q is not a frame", ErrReadyForDev, n.GetName())
	}
	if utf8.RuneCountInString(r.GetNote()) > MaxReadyNoteRunes {
		return fmt.Errorf("%w: note longer than %d characters", ErrReadyForDev, MaxReadyNoteRunes)
	}
	if utf8.RuneCountInString(r.GetMarkedBy()) > MaxDevAuthorRunes {
		return fmt.Errorf("%w: marked_by too long", ErrReadyForDev)
	}
	if r.GetMarkedAt() < 0 {
		return fmt.Errorf("%w: negative marking time", ErrReadyForDev)
	}
	return nil
}

func applySetReadyForDev(doc *opendesignerv1.Document, s *opendesignerv1.SetReadyForDev) error {
	r := s.GetReady()
	if err := validateReady(doc, r); err != nil {
		return err
	}
	entry := &opendesignerv1.ReadyForDev{NodeId: r.GetNodeId(), Note: r.GetNote(), MarkedBy: r.GetMarkedBy(), MarkedAt: r.GetMarkedAt()}
	for _, n := range SubtreeOf(doc, r.GetNodeId()) {
		entry.Snapshot = append(entry.Snapshot, proto.Clone(n).(*opendesignerv1.Node))
	}
	if doc.ReadyForDev == nil {
		doc.ReadyForDev = map[string]*opendesignerv1.ReadyForDev{}
	}
	doc.ReadyForDev[entry.GetNodeId()] = entry
	return nil
}

func applyClearReadyForDev(doc *opendesignerv1.Document, c *opendesignerv1.ClearReadyForDev) error {
	if _, ok := doc.GetReadyForDev()[c.GetNodeId()]; !ok {
		return fmt.Errorf("%w: %s", ErrReadyNotFound, c.GetNodeId())
	}
	delete(doc.ReadyForDev, c.GetNodeId())
	return nil
}

// ReadyFrames returns the node ids marked ready, sorted by marking time (oldest first) then id.
func ReadyFrames(doc *opendesignerv1.Document) []string {
	ids := make([]string, 0, len(doc.GetReadyForDev()))
	for id := range doc.GetReadyForDev() {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := doc.ReadyForDev[ids[i]], doc.ReadyForDev[ids[j]]
		if a.GetMarkedAt() != b.GetMarkedAt() {
			return a.GetMarkedAt() < b.GetMarkedAt()
		}
		return ids[i] < ids[j]
	})
	return ids
}

// AnnotationsOf returns the annotations of a node, oldest first (then by id).
func AnnotationsOf(doc *opendesignerv1.Document, nodeID string) []*opendesignerv1.Annotation {
	var out []*opendesignerv1.Annotation
	for _, a := range doc.GetAnnotations() {
		if a.GetNodeId() == nodeID {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].GetCreatedAt() != out[j].GetCreatedAt() {
			return out[i].GetCreatedAt() < out[j].GetCreatedAt()
		}
		return out[i].GetId() < out[j].GetId()
	})
	return out
}
