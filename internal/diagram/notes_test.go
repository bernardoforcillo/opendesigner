package diagram

import (
	"strings"
	"testing"
)

func TestStateNotes(t *testing.T) {
	fc, err := parseState(`stateDiagram-v2
  [*] --> Idle
  Idle --> Busy
  note right of Idle : waits for input
  note left of Busy
    works hard
    on two lines
  end note`)
	if err != nil {
		t.Fatal(err)
	}
	var notes []flowNode
	for _, n := range fc.Nodes {
		if n.Shape == fNote {
			notes = append(notes, n)
		}
	}
	if len(notes) != 2 || notes[0].Label != "waits for input" || notes[1].Label != "works hard\non two lines" {
		t.Fatalf("notes = %+v", notes)
	}
	// each note hangs from its state on a dotted line without an arrow
	dotted := 0
	for _, e := range fc.Edges {
		if e.Style == sDotted && !e.ArrowEnd {
			dotted++
		}
	}
	if dotted != 2 {
		t.Errorf("want 2 dotted note edges, got %d (%+v)", dotted, fc.Edges)
	}
}

func TestStateNoteDrawn(t *testing.T) {
	res, err := Render("stateDiagram-v2\n  A --> B\n  note right of A : hello")
	if err != nil {
		t.Fatal(err)
	}
	if len(byName(res, "Note")) < 1 {
		t.Fatalf("the note must be drawn: %v", names(res))
	}
	found := false
	for _, n := range res.Nodes {
		if n.GetText().GetContent() == "hello" {
			found = true
		}
	}
	if !found {
		t.Error("the note's text must be in the drawing")
	}
}

func TestClassNotes(t *testing.T) {
	cd, err := parseClass(`classDiagram
  class Animal
  note for Animal "can fly\nor not"
  note "a loose note"`)
	if err != nil {
		t.Fatal(err)
	}
	var notes []classDef
	for _, c := range cd.Classes {
		if c.Note {
			notes = append(notes, c)
		}
	}
	if len(notes) != 2 || notes[0].Label != "can fly\nor not" || notes[1].Label != "a loose note" {
		t.Fatalf("notes = %+v", notes)
	}
	if len(cd.Rels) != 1 || !cd.Rels[0].Dashed || cd.Rels[0].B != "Animal" {
		t.Errorf("a note for a class hangs from it: %+v", cd.Rels)
	}
}

func TestClassNoteDrawn(t *testing.T) {
	res, err := Render("classDiagram\n  class A\n  note for A \"remember\"")
	if err != nil {
		t.Fatal(err)
	}
	cards := 0
	for _, n := range res.Nodes {
		if n.GetName() == "Note" {
			cards++
		}
	}
	if cards != 1 {
		t.Errorf("one note card: %v", names(res))
	}
	for _, n := range res.Nodes {
		if strings.HasPrefix(n.GetName(), "Header") && strings.Contains(n.GetName(), "remember") {
			t.Error("a note is not drawn as a class")
		}
	}
}
