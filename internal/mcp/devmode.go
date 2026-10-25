package mcp

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/devmode"
)

// DEV MODE tools: frames marked ready for development, the annotations that tell the developer what
// the picture does not, and Compare changes (a ready frame against its state when it was marked).
// The model is in internal/core/devmode.go; the diff in internal/devmode.

type AnnotationView struct {
	Id        string `json:"id"`
	NodeId    string `json:"nodeId"`
	NodeName  string `json:"nodeName,omitempty"`
	Category  string `json:"category"`
	Color     string `json:"color" jsonschema:"the colour the category is drawn with"`
	Text      string `json:"text"`
	Author    string `json:"author,omitempty"`
	CreatedAt int64  `json:"createdAt,omitempty" jsonschema:"unix seconds"`
}

func annotationView(doc *opendesignerv1.Document, a *opendesignerv1.Annotation) AnnotationView {
	return AnnotationView{
		Id: a.GetId(), NodeId: a.GetNodeId(), NodeName: nameOf(doc, a.GetNodeId()), Category: a.GetCategory(),
		Color: core.AnnotationColors[a.GetCategory()], Text: a.GetText(), Author: a.GetAuthor(), CreatedAt: a.GetCreatedAt(),
	}
}

type ListAnnotationsInput struct {
	NodeId   string `json:"nodeId,omitempty" jsonschema:"only the annotations of this node"`
	Category string `json:"category,omitempty" jsonschema:"only this category: note, interaction, accessibility, content, animation or layout"`
}

type ListAnnotationsOutput struct {
	Annotations []AnnotationView `json:"annotations" jsonschema:"oldest first"`
}

func (s *Session) ListAnnotations(_ context.Context, in ListAnnotationsInput) (ListAnnotationsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListAnnotationsOutput{Annotations: []AnnotationView{}}
	var all []*opendesignerv1.Annotation
	if in.NodeId != "" {
		all = core.AnnotationsOf(s.doc, in.NodeId)
	} else {
		seen := map[string]bool{}
		for _, a := range s.doc.GetAnnotations() {
			if !seen[a.GetNodeId()] {
				seen[a.GetNodeId()] = true
			}
		}
		for _, id := range sortedKeys(seen) {
			all = append(all, core.AnnotationsOf(s.doc, id)...)
		}
	}
	for _, a := range all {
		if in.Category != "" && a.GetCategory() != in.Category {
			continue
		}
		out.Annotations = append(out.Annotations, annotationView(s.doc, a))
	}
	return out, nil
}

type AddAnnotationInput struct {
	NodeId   string `json:"nodeId" jsonschema:"the node to annotate"`
	Category string `json:"category" jsonschema:"note, interaction, accessibility, content, animation or layout"`
	Text     string `json:"text" jsonschema:"1..2000 characters: what the developer needs to know"`
	Author   string `json:"author,omitempty" jsonschema:"default \"Claude\""`
}

type AddAnnotationOutput struct {
	AnnotationId string `json:"annotationId"`
	Seq          uint64 `json:"seq"`
}

func (s *Session) AddAnnotation(ctx context.Context, in AddAnnotationInput) (AddAnnotationOutput, error) {
	author := in.Author
	if author == "" {
		author = agentAuthor
	}
	a := &opendesignerv1.Annotation{Id: uuid.NewString(), NodeId: in.NodeId, Category: in.Category, Text: in.Text, Author: author, CreatedAt: time.Now().Unix()}
	s.mu.Lock()
	err := core.ValidateAnnotation(s.doc, a)
	s.mu.Unlock()
	if err != nil {
		return AddAnnotationOutput{}, fmt.Errorf("add_annotation: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetAnnotation{SetAnnotation: &opendesignerv1.SetAnnotation{Annotation: a}}})
	if err != nil {
		return AddAnnotationOutput{}, err
	}
	return AddAnnotationOutput{AnnotationId: a.GetId(), Seq: seq}, nil
}

func (s *Session) DeleteAnnotation(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetAnnotations()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_annotation: annotation %q not found (list_annotations)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteAnnotation{DeleteAnnotation: &opendesignerv1.DeleteAnnotation{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

type MarkReadyInput struct {
	NodeId string `json:"nodeId" jsonschema:"a frame"`
	Note   string `json:"note,omitempty" jsonschema:"up to 500 characters: what is ready, what the developer should look at first"`
	Author string `json:"author,omitempty" jsonschema:"default \"Claude\""`
}

// MarkReadyForDev marks a frame ready, or marks it again: the snapshot is taken now, so it is the
// new baseline of Compare changes.
func (s *Session) MarkReadyForDev(ctx context.Context, in MarkReadyInput) (SeqOutput, error) {
	author := in.Author
	if author == "" {
		author = agentAuthor
	}
	r := &opendesignerv1.ReadyForDev{NodeId: in.NodeId, Note: in.Note, MarkedBy: author, MarkedAt: time.Now().Unix()}
	s.mu.Lock()
	err := core.ValidateReady(s.doc, r)
	s.mu.Unlock()
	if err != nil {
		return SeqOutput{}, fmt.Errorf("mark_ready_for_dev: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetReadyForDev{SetReadyForDev: &opendesignerv1.SetReadyForDev{Ready: r}}})
	return SeqOutput{Seq: seq}, err
}

type ReadyNodeInput struct {
	NodeId string `json:"nodeId"`
}

func (s *Session) ClearReadyForDev(ctx context.Context, in ReadyNodeInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetReadyForDev()[in.NodeId]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("clear_ready_for_dev: frame %q is not marked ready (list_ready_for_dev)", in.NodeId)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_ClearReadyForDev{ClearReadyForDev: &opendesignerv1.ClearReadyForDev{NodeId: in.NodeId}}})
	return SeqOutput{Seq: seq}, err
}

type ReadyView struct {
	NodeId      string           `json:"nodeId"`
	Name        string           `json:"name"`
	Note        string           `json:"note,omitempty"`
	MarkedBy    string           `json:"markedBy,omitempty"`
	MarkedAt    int64            `json:"markedAt,omitempty" jsonschema:"unix seconds"`
	Missing     bool             `json:"missing,omitempty" jsonschema:"the frame was deleted since it was marked"`
	Changes     int              `json:"changes" jsonschema:"how many differences compare_ready_for_dev reports: 0 means the frame is as it was when marked"`
	Annotations []AnnotationView `json:"annotations,omitempty" jsonschema:"on the frame itself and on every node inside it"`
}

type ListReadyOutput struct {
	Ready []ReadyView `json:"ready" jsonschema:"oldest marking first"`
}

func (s *Session) ListReadyForDev(_ context.Context, _ struct{}) (ListReadyOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListReadyOutput{Ready: []ReadyView{}}
	for _, id := range core.ReadyFrames(s.doc) {
		r := s.doc.GetReadyForDev()[id]
		v := ReadyView{NodeId: id, Name: nameOf(s.doc, id), Note: r.GetNote(), MarkedBy: r.GetMarkedBy(), MarkedAt: r.GetMarkedAt()}
		if s.doc.GetNodes()[id] == nil {
			v.Missing, v.Name = true, r.GetSnapshot()[0].GetName()
		}
		if cmp, err := devmode.Compare(s.doc, id); err == nil {
			v.Changes = len(cmp.Changes)
		}
		for _, n := range core.SubtreeOf(s.doc, id) {
			for _, a := range core.AnnotationsOf(s.doc, n.GetId()) {
				v.Annotations = append(v.Annotations, annotationView(s.doc, a))
			}
		}
		out.Ready = append(out.Ready, v)
	}
	return out, nil
}

type CompareReadyOutput struct {
	NodeId   string           `json:"nodeId"`
	Name     string           `json:"name"`
	MarkedAt int64            `json:"markedAt,omitempty"`
	Changes  []devmode.Change `json:"changes" jsonschema:"property-level differences between the frame now and when it was marked ready: kind added | removed | changed, property, before, after"`
	Summary  []string         `json:"summary"`
}

func (s *Session) CompareReadyForDev(_ context.Context, in ReadyNodeInput) (CompareReadyOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cmp, err := devmode.Compare(s.doc, in.NodeId)
	if err != nil {
		return CompareReadyOutput{}, fmt.Errorf("compare_ready_for_dev: %w", err)
	}
	out := CompareReadyOutput{NodeId: cmp.NodeID, Name: cmp.Name, MarkedAt: cmp.MarkedAt, Changes: cmp.Changes, Summary: []string{}}
	if out.Changes == nil {
		out.Changes = []devmode.Change{}
	}
	for _, c := range cmp.Changes {
		out.Summary = append(out.Summary, c.Summary())
	}
	return out, nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && strings.Compare(out[j-1], out[j]) > 0; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

const devConventions = " Dev mode: a designer marks a FRAME ready for development (mark_ready_for_dev); the server keeps a snapshot of it, and compare_ready_for_dev lists what changed since (property by property). Annotations (add_annotation) are notes for the developer attached to a node and colour-coded by category -- interaction, accessibility, content, animation, layout or note; they are written as comments into the exported code (export_code)."

func registerDevTools(srv *mcp.Server, s *Session) {
	addTool(srv, "mark_ready_for_dev", "Mark a frame ready for development (or mark it again after changes: the new state becomes the baseline)."+devConventions, s.MarkReadyForDev)
	addTool(srv, "clear_ready_for_dev", "Take the ready-for-dev mark off a frame.", s.ClearReadyForDev)
	addTool(srv, "list_ready_for_dev", "List the frames marked ready for dev, oldest first, with the note, how many changes were made since (0 = untouched) and the annotations inside each."+devConventions, s.ListReadyForDev)
	addTool(srv, "compare_ready_for_dev", "Compare a ready frame with its state when it was marked: every added or removed layer and every changed property with its before and after value.", s.CompareReadyForDev)
	addTool(srv, "list_annotations", "List the developer annotations (oldest first), optionally of one node or one category."+devConventions, s.ListAnnotations)
	addTool(srv, "add_annotation", "Attach a developer annotation to a node: category note | interaction | accessibility | content | animation | layout, and the text. Signed \"Claude\" unless `author` is given.", s.AddAnnotation)
	addTool(srv, "delete_annotation", "Delete an annotation by id.", s.DeleteAnnotation)
}
