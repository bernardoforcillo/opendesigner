package server

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/proto"
)

// Il clone copy-on-write condivide i nodi ma le clip si clonano a fondo: una
// cascata (cancellare un nodo animato) sul clone non deve toccare la generazione
// precedente, che un client lento potrebbe ancora star serializzando.
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
		t.Fatal("cowClone deve clonare le clip, non condividerne i puntatori")
	}
	// Cancella "b" sul clone (con il Shared del server): la traccia su b sparisce
	// dal clone e NON dall'originale.
	if err := core.ApplyShared(next, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "b"}}}, core.NewShared()); err != nil {
		t.Fatal(err)
	}
	if len(next.Clips["k"].Tracks) != 1 {
		t.Fatalf("cascata assente sul clone: %v", next.Clips["k"])
	}
	if !proto.Equal(before, doc) {
		t.Fatal("la generazione precedente e' stata mutata")
	}
}
