package server

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// cowClone is what every server write goes through. A document field it does
// not copy is silently LOST on the next op, so variables and modes must survive
// it, and the clone must not share them with the previous generation.
func TestCowCloneKeepsVariablesAndModes(t *testing.T) {
	doc := core.NewDocument("d", "t")
	ops := []*opendesignerv1.Op{
		{Kind: &opendesignerv1.Op_SetModes{SetModes: &opendesignerv1.SetModes{Modes: []*opendesignerv1.Mode{{Id: "light"}, {Id: "dark"}}}}},
		{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
			Id: "v", Name: "x", Values: map[string]*opendesignerv1.Color{"light": {A: 1}, "dark": {R: 1, A: 1}}}}}},
	}
	for _, op := range ops {
		if err := core.Apply(doc, op); err != nil {
			t.Fatal(err)
		}
	}
	before := proto.Clone(doc)

	next := cowClone(doc)
	if len(next.Modes) != 2 || next.Variables["v"] == nil {
		t.Fatalf("cowClone dropped the design tokens: modes=%v vars=%v", next.Modes, next.Variables)
	}
	if next.Variables["v"] == doc.Variables["v"] {
		t.Fatal("cowClone must clone variables, not share their pointers")
	}
	// Removing a mode on the clone must not touch the previous generation.
	drop := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetModes{SetModes: &opendesignerv1.SetModes{Modes: []*opendesignerv1.Mode{{Id: "light"}}}}}
	if err := core.ApplyShared(next, drop, core.NewShared()); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(before, doc) {
		t.Fatal("the previous generation was mutated")
	}
}

// GUARD for every Document field, present and future. cowClone copies the
// document field by field, so a field it does not know is dropped on the next
// write with no error anywhere (variables were exactly that bug). This fills
// EVERY field of Document through protobuf reflection and demands the clone be
// equal: adding a Document field without teaching cowClone about it fails here.
func TestCowCloneCopiesEveryDocumentField(t *testing.T) {
	doc := &opendesignerv1.Document{}
	m := doc.ProtoReflect()
	fields := m.Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		fd := fields.Get(i)
		switch {
		case fd.IsMap():
			if fd.MapValue().Kind() != protoreflect.MessageKind {
				t.Fatalf("field %s: map of scalars; extend this test", fd.Name())
			}
			mp := m.Mutable(fd).Map()
			mp.Set(protoreflect.ValueOfString("k").MapKey(), protoreflect.ValueOfMessage(filled(mp.NewValue().Message())))
		case fd.IsList():
			if fd.Kind() != protoreflect.MessageKind {
				t.Fatalf("field %s: list of scalars; extend this test", fd.Name())
			}
			l := m.Mutable(fd).List()
			l.Append(protoreflect.ValueOfMessage(filled(l.NewElement().Message())))
		case fd.Kind() == protoreflect.MessageKind:
			m.Set(fd, protoreflect.ValueOfMessage(filled(m.NewField(fd).Message())))
		default:
			setScalar(t, m, fd)
		}
	}
	got := cowClone(doc)
	if !proto.Equal(doc, got) {
		for i := 0; i < fields.Len(); i++ {
			fd := fields.Get(i)
			if !m.Get(fd).Equal(got.ProtoReflect().Get(fd)) {
				t.Errorf("cowClone does not copy Document.%s", fd.Name())
			}
		}
	}
}

// filled sets the string fields of a message so a copy that drops it is visible.
func filled(msg protoreflect.Message) protoreflect.Message {
	fds := msg.Descriptor().Fields()
	for i := 0; i < fds.Len(); i++ {
		if fd := fds.Get(i); fd.Kind() == protoreflect.StringKind && !fd.IsList() && !fd.IsMap() {
			msg.Set(fd, protoreflect.ValueOfString("x"))
			return msg
		}
	}
	return msg
}

func setScalar(t *testing.T, m protoreflect.Message, fd protoreflect.FieldDescriptor) {
	t.Helper()
	switch fd.Kind() {
	case protoreflect.StringKind:
		m.Set(fd, protoreflect.ValueOfString("x"))
	case protoreflect.Uint32Kind:
		m.Set(fd, protoreflect.ValueOfUint32(7))
	default:
		t.Fatalf("field %s: scalar kind %v; extend this test", fd.Name(), fd.Kind())
	}
}
