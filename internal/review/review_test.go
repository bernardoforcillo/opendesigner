package review_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/review"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func has(issues []review.Issue, rule, node string) *review.Issue {
	for i := range issues {
		if issues[i].Rule == rule && issues[i].NodeID == node {
			return &issues[i]
		}
	}
	return nil
}

func TestContrast(t *testing.T) {
	b := New("d", "D")
	b.Add("scr", "page1", "Screen", 0, 0, 300, 300, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("good", "scr", "Good", 0, 0, 100, 20, Text("Readable", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.1, 0.1, 0.1))))
	b.Add("pale", "scr", "Pale", 0, 30, 100, 20, Text("Pale grey", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.7, 0.7, 0.7))))
	// A mid grey (3.4:1) fails as normal text but is fine as LARGE text (3:1).
	b.Add("large", "scr", "Large", 0, 60, 100, 40, Text("Big", 28, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.55, 0.55, 0.55))))
	b.Add("dark", "scr", "Dark card", 0, 120, 200, 100, Rect(0), Fill(Solid(C(0.05, 0.05, 0.2))))
	b.Add("onDark", "dark", "On dark", 0, 0, 100, 20, Text("Dark on dark", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.2, 0.2, 0.4))))
	b.Add("hid", "scr", "Hidden", 0, 0, 100, 20, Hidden(), Text("nope", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.9, 0.9, 0.9))))
	b.Add("empty", "scr", "Empty", 0, 0, 100, 20, Text("  ", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.9, 0.9, 0.9))))

	issues := review.Review(b.Doc)
	if has(issues, review.RuleContrast, "good") != nil {
		t.Error("dark text on white is fine")
	}
	if i := has(issues, review.RuleContrast, "pale"); i == nil || i.Severity != review.Error || !strings.Contains(i.Message, "4.5:1") {
		t.Errorf("pale text: %+v", i)
	}
	if has(issues, review.RuleContrast, "large") != nil {
		t.Error("large text only needs 3:1")
	}
	// The background is the nearest fill behind, not the page.
	if has(issues, review.RuleContrast, "onDark") == nil {
		t.Error("dark text on a dark card must be flagged")
	}
	if has(issues, review.RuleContrast, "hid") != nil || has(issues, review.RuleContrast, "empty") != nil {
		t.Error("hidden and blank texts are not reviewed")
	}
}

func TestTouchTargets(t *testing.T) {
	b := New("d", "D")
	b.Add("a", "page1", "A", 0, 0, 300, 300, Frame(false, nil))
	b.Add("b", "page1", "B", 400, 0, 300, 300, Frame(false, nil))
	b.Add("small", "a", "Small", 10, 10, 30, 20, Rect(4), Fill(Solid(C(0, 0, 1))))
	b.Add("big", "a", "Big", 10, 50, 120, 48, Rect(4), Fill(Solid(C(0, 0, 1))))
	b.Add("decor", "a", "Decor", 10, 120, 10, 10, Rect(0), Fill(Solid(C(0, 0, 1))))
	b.Flow("f", "Flow", "a")
	b.Transition(&opendesignerv1.Transition{Id: "t1", FlowId: "f", FromId: "a", ToId: "b", ElementId: "small"})
	b.Transition(&opendesignerv1.Transition{Id: "t2", FlowId: "f", FromId: "a", ToId: "b", ElementId: "big"})
	issues := review.Review(b.Doc)
	if i := has(issues, review.RuleTouchTarget, "small"); i == nil || i.Severity != review.Warn || !strings.Contains(i.Message, "30x20") {
		t.Errorf("small hotspot: %+v", i)
	}
	if has(issues, review.RuleTouchTarget, "big") != nil || has(issues, review.RuleTouchTarget, "decor") != nil {
		t.Error("only undersized HOTSPOTS are flagged")
	}
}

func TestTokens(t *testing.T) {
	b := New("d", "D")
	apply := func(op *opendesignerv1.Op) {
		if err := core.Apply(b.Doc, op); err != nil {
			t.Fatal(err)
		}
	}
	b.Add("scr", "page1", "Screen", 0, 0, 300, 300, Frame(false, nil))
	b.Add("lit", "scr", "Literal", 0, 0, 50, 50, Rect(0), Fill(Solid(C(0.2, 0.4, 0.8))))
	b.Add("bound", "scr", "Bound", 60, 0, 50, 50, Rect(0), Fill(Solid(C(0.2, 0.4, 0.8))))
	b.Add("other", "scr", "Other", 120, 0, 50, 50, Rect(0), Fill(Solid(C(0.9, 0.1, 0.1))))
	apply(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
		Id: "c", Name: "Theme", Modes: []*opendesignerv1.VariableMode{{Id: "m", Name: "Light"}}}}}})
	apply(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
		Id: "v", CollectionId: "c", Name: "color/primary", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR,
		Values: map[string]*opendesignerv1.VariableValue{"m": {Kind: &opendesignerv1.VariableValue_Color{Color: C(0.2, 0.4, 0.8)}}}}}}})
	apply(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "bound", Patch: &opendesignerv1.Node{Bindings: map[string]string{"fills.0": "v"}}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"bindings"}}}}})

	issues := review.Review(b.Doc)
	if i := has(issues, review.RuleToken, "lit"); i == nil || !strings.Contains(i.Message, "color/primary") || !strings.Contains(i.Message, "#3366cc") {
		t.Errorf("literal that matches a token: %+v", i)
	}
	if has(issues, review.RuleToken, "bound") != nil {
		t.Error("a bound fill is the goal, not an issue")
	}
	if has(issues, review.RuleToken, "other") != nil {
		t.Error("a color no token has is not an issue")
	}
}

func TestDeterministicAndSorted(t *testing.T) {
	b := New("d", "D")
	b.Add("scr", "page1", "S", 0, 0, 300, 300, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	for _, id := range []string{"z", "a", "m"} {
		b.Add(id, "scr", "T"+id, 0, 0, 100, 20, Text("x", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0.8, 0.8, 0.8))))
	}
	first := review.Review(b.Doc)
	for i := 0; i < 5; i++ {
		again := review.Review(b.Doc)
		if len(again) != len(first) {
			t.Fatal("length changed")
		}
		for j := range first {
			if again[j] != first[j] {
				t.Fatalf("run %d differs at %d", i, j)
			}
		}
	}
	if len(first) != 3 || first[0].NodeName != "Ta" || first[2].NodeName != "Tz" {
		t.Fatalf("order = %+v", first)
	}
}
