package mcp_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestDevModeTools: an agent marks a frame ready, annotates a button, edits it, sees the change in
// compare_ready_for_dev and the annotation in the exported code, and bad input is refused.
func TestDevModeTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	btn := rect(t, s, home, "Buy")

	if _, err := s.MarkReadyForDev(ctx, odmcp.MarkReadyInput{NodeId: btn}); err == nil {
		t.Error("a rectangle cannot be marked ready: only frames")
	}
	if _, err := s.MarkReadyForDev(ctx, odmcp.MarkReadyInput{NodeId: home, Note: "Start with the button"}); err != nil {
		t.Fatal(err)
	}
	a1, err := s.AddAnnotation(ctx, odmcp.AddAnnotationInput{NodeId: btn, Category: "interaction", Text: "Opens the cart as a sheet"})
	if err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string]odmcp.AddAnnotationInput{
		"unknown category": {NodeId: btn, Category: "loud", Text: "x"},
		"empty text":       {NodeId: btn, Category: "note"},
		"unknown node":     {NodeId: "ghost", Category: "note", Text: "x"},
	} {
		if _, err := s.AddAnnotation(ctx, in); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}

	list, err := s.ListAnnotations(ctx, odmcp.ListAnnotationsInput{})
	if err != nil || len(list.Annotations) != 1 {
		t.Fatalf("annotations = %+v %v", list, err)
	}
	if v := list.Annotations[0]; v.Id != a1.AnnotationId || v.NodeName != "Buy" || v.Author != "Claude" || v.Color != "#3b82f6" {
		t.Errorf("annotation = %+v", v)
	}
	if l, _ := s.ListAnnotations(ctx, odmcp.ListAnnotationsInput{Category: "content"}); len(l.Annotations) != 0 {
		t.Errorf("the category filter: %+v", l.Annotations)
	}

	ready, err := s.ListReadyForDev(ctx, struct{}{})
	if err != nil || len(ready.Ready) != 1 {
		t.Fatalf("ready = %+v %v", ready, err)
	}
	if r := ready.Ready[0]; r.NodeId != home || r.Note != "Start with the button" || r.Changes != 0 || len(r.Annotations) != 1 {
		t.Errorf("ready = %+v", r)
	}

	// Edit the button: the comparison reports it, with before and after.
	w := 99.0
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: btn, Width: &w}); err != nil {
		t.Fatal(err)
	}
	cmp, err := s.CompareReadyForDev(ctx, odmcp.ReadyNodeInput{NodeId: home})
	if err != nil {
		t.Fatal(err)
	}
	if len(cmp.Changes) != 1 || cmp.Changes[0].Property != "width" || cmp.Changes[0].Before != "30" || cmp.Changes[0].After != "99" {
		t.Fatalf("comparison = %+v", cmp)
	}
	if len(cmp.Summary) != 1 || cmp.Summary[0] != "Buy: width 30 -> 99" {
		t.Errorf("summary = %v", cmp.Summary)
	}
	if r, _ := s.ListReadyForDev(ctx, struct{}{}); r.Ready[0].Changes != 1 {
		t.Errorf("the list must count the changes: %+v", r.Ready[0])
	}

	// The annotation is in the code the agent exports.
	dir := filepath.Join(t.TempDir(), "app")
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: dir, Target: "swiftui"}); err != nil {
		t.Fatal(err)
	}
	src, _ := os.ReadFile(filepath.Join(dir, "Sources/Screens/Home.swift"))
	for _, want := range []string{"// annotation [interaction] Opens the cart as a sheet (Claude)", " by Claude: Start with the button"} {
		if !strings.Contains(string(src), want) {
			t.Errorf("Home.swift lacks %q:\n%s", want, src)
		}
	}

	// Marking again takes a new baseline; clearing removes the mark.
	if _, err := s.MarkReadyForDev(ctx, odmcp.MarkReadyInput{NodeId: home}); err != nil {
		t.Fatal(err)
	}
	if cmp, _ := s.CompareReadyForDev(ctx, odmcp.ReadyNodeInput{NodeId: home}); len(cmp.Changes) != 0 {
		t.Errorf("a new baseline has no changes: %+v", cmp.Changes)
	}
	if _, err := s.ClearReadyForDev(ctx, odmcp.ReadyNodeInput{NodeId: home}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CompareReadyForDev(ctx, odmcp.ReadyNodeInput{NodeId: home}); err == nil {
		t.Error("comparing a frame that is not ready must fail")
	}
	if _, err := s.ClearReadyForDev(ctx, odmcp.ReadyNodeInput{NodeId: home}); err == nil {
		t.Error("clearing twice must fail")
	}
	if _, err := s.DeleteAnnotation(ctx, odmcp.IdInput{Id: a1.AnnotationId}); err != nil {
		t.Fatal(err)
	}
	if l, _ := s.ListAnnotations(ctx, odmcp.ListAnnotationsInput{}); len(l.Annotations) != 0 {
		t.Errorf("annotations after delete: %+v", l.Annotations)
	}
}
