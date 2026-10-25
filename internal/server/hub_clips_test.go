package server

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/proto"
)

// The copy-on-write clone shares the nodes but the clips are deep-cloned: a
// cascade (deleting an animated node) on the clone must not touch the previous
// generation, which a slow client might still be serializing.
func TestCowCloneClipsAreIndependent(t *testing.T) {
	doc := core.NewDocument("d", "t")
	for _, id := range []string{"a", "b"} {
		n := &opendesignerv1.Node{Id: id, ParentId: "page1", OrderKey: id, Visible: true, Opacity: 1,
			Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
		if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); err != nil {
			t.Fatal(err)
		}
	}
	clip := &opendesignerv1.Clip{Id: "k", Duration: 100, TargetId: "a", Tracks: []*opendesignerv1.Track{
		{NodeId: "b", Prop: "opacity", Keyframes: []*opendesignerv1.Keyframe{{Time: 0, Value: 0}}},
		{NodeId: "a", Prop: "x", Keyframes: []*opendesignerv1.Keyframe{{Time: 0, Value: 1}}},
	}}
	if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: clip}}}); err != nil {
		t.Fatal(err)
	}
	before := proto.Clone(doc)

	next := cowClone(doc)
	if next.Clips["k"] == doc.Clips["k"] {
		t.Fatal("cowClone must clone the clips, not share their pointers")
	}
	// Delete "b" on the clone (with the server's Shared): the track on b disappears
	// from the clone and NOT from the original.
	if err := core.ApplyShared(next, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "b"}}}, core.NewShared()); err != nil {
		t.Fatal(err)
	}
	if len(next.Clips["k"].Tracks) != 1 {
		t.Fatalf("cascade missing on the clone: %v", next.Clips["k"])
	}
	if !proto.Equal(before, doc) {
		t.Fatal("the previous generation was mutated")
	}
}

// The live document is rebuilt from cowClone on every Submit: a field it forgets to copy is lost at the next
// op. Every document-level field the editor can set must survive it.
func TestCowCloneKeepsEveryDocumentLevelField(t *testing.T) {
	doc := core.NewDocument("d", "Doc")
	for _, op := range []*opendesignerv1.Op{
		{Kind: &opendesignerv1.Op_SetDocSettings{SetDocSettings: &opendesignerv1.SetDocSettings{Settings: &opendesignerv1.DocSettings{Vertical: "publishing", BaselineIncrement: 12, FacingPages: true, ColorMode: "cmyk", IccProfile: "FOGRA39"}}}},
		{Kind: &opendesignerv1.Op_SetLayer{SetLayer: &opendesignerv1.SetLayer{Layer: &opendesignerv1.Layer{Id: "l", Name: "Guides", Locked: true}}}},
		{Kind: &opendesignerv1.Op_SetObjectStyleDef{SetObjectStyleDef: &opendesignerv1.SetObjectStyleDef{ObjectStyle: &opendesignerv1.ObjectStyleDef{Id: "o", Name: "Card", Sets: []string{"opacity"}, Opacity: 0.5}}}},
		{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{Id: "t", Name: "Body", Style: &opendesignerv1.TextStyle{FontSize: 12}}}}},
		{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{Id: "c", Name: "Swatches", Modes: []*opendesignerv1.VariableMode{{Id: "m", Name: "Default"}}}}}},
		{Kind: &opendesignerv1.Op_UpdatePage{UpdatePage: &opendesignerv1.UpdatePage{Page: &opendesignerv1.Page{Id: "page1", Name: "One", Width: 300, Height: 400, Guides: []*opendesignerv1.Guide{{Position: 10}}}}}},
	} {
		if err := core.Apply(doc, op); err != nil {
			t.Fatal(err)
		}
	}
	if got := cowClone(doc); !proto.Equal(got, doc) {
		t.Fatalf("cowClone lost something:\n got  %v\n want %v", got, doc)
	}
}
