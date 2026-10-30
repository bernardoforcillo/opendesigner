package review_test

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"github.com/bernardoforcillo/opendesigner/internal/review"
)

func TestNearColorSizeAndRadius(t *testing.T) {
	b := New("d", "D")
	b.Add("scr", "page1", "Screen", 0, 0, 300, 300, Frame(false, nil))
	for i, id := range []string{"a", "b", "c"} {
		b.Add(id, "scr", "Main "+id, float64(i*10), 0, 10, 10, Rect(8), Fill(Solid(C(0.2, 0.4, 0.8))))
	}
	// One step off the main blue and the main radius.
	b.Add("odd", "scr", "Odd", 0, 20, 10, 10, Rect(9), Fill(Solid(C(0.2, 0.41, 0.8))))
	// Clearly another color: not flagged.
	b.Add("red", "scr", "Red", 0, 40, 10, 10, Rect(0), Fill(Solid(C(0.9, 0.1, 0.1))))
	tx := Text("Body", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT)
	b.Add("t1", "scr", "T1", 0, 60, 50, 20, tx, Fill(Solid(C(0, 0, 0))))
	b.Add("t2", "scr", "T2", 0, 80, 50, 20, Text("Body", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0, 0, 0))))
	b.Add("t3", "scr", "T3", 0, 100, 50, 20, Text("Body", 15, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT), Fill(Solid(C(0, 0, 0))))

	issues := review.ReviewConsistency(b.Doc)
	if has(issues, review.RuleNearColor, "odd") == nil {
		t.Errorf("odd blue not flagged: %+v", issues)
	}
	if has(issues, review.RuleNearRadius, "odd") == nil {
		t.Error("odd radius not flagged")
	}
	if has(issues, review.RuleNearSize, "t3") == nil {
		t.Error("odd font size not flagged")
	}
	for _, id := range []string{"a", "red", "t1"} {
		for _, rule := range []string{review.RuleNearColor, review.RuleNearRadius, review.RuleNearSize} {
			if has(issues, rule, id) != nil {
				t.Errorf("%s wrongly flagged by %s", id, rule)
			}
		}
	}
}

func TestUnstyledText(t *testing.T) {
	b := New("d", "D")
	b.Add("scr", "page1", "Screen", 0, 0, 300, 300, Frame(false, nil))
	b.Add("t", "scr", "T", 0, 0, 50, 20, Text("Hello", 16, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT))
	if has(review.ReviewConsistency(b.Doc), review.RuleUnstyled, "t") != nil {
		t.Error("no text styles in the document: nothing to be unstyled against")
	}
	b.Doc.TextStyles = map[string]*opendesignerv1.TextStyleDef{"h": {Id: "h", Name: "Heading"}}
	if has(review.ReviewConsistency(b.Doc), review.RuleUnstyled, "t") == nil {
		t.Error("text without a style should be flagged once the document has styles")
	}
	b.Doc.Nodes["t"].TextStyleId = "h"
	if has(review.ReviewConsistency(b.Doc), review.RuleUnstyled, "t") != nil {
		t.Error("styled text is fine")
	}
}

func TestTokenUsage(t *testing.T) {
	b := New("d", "D")
	b.Add("scr", "page1", "Screen", 0, 0, 300, 300, Frame(false, nil))
	for i, id := range []string{"a", "b", "c"} {
		b.Add(id, "scr", id, float64(i*10), 0, 10, 10, Rect(0), Fill(Solid(C(0.3, 0.3, 0.9))))
	}
	b.Doc.Variables = map[string]*opendesignerv1.Variable{
		"brand": {Id: "brand", Name: "brand", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR},
		"dead":  {Id: "dead", Name: "dead", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR},
	}
	b.Doc.Nodes["a"].Bindings = map[string]string{"fills.0": "brand"}
	b.Doc.TextStyles = map[string]*opendesignerv1.TextStyleDef{"h": {Id: "h", Name: "Heading"}}

	rep := review.TokenUsage(b.Doc)
	if len(rep.Variables) != 2 || rep.Variables[0].Name != "brand" || rep.Variables[0].Uses != 1 {
		t.Errorf("variables: %+v", rep.Variables)
	}
	want := []string{"text style Heading", "variable dead"}
	if len(rep.Unused) != 2 || rep.Unused[0] != want[0] || rep.Unused[1] != want[1] {
		t.Errorf("unused: %v", rep.Unused)
	}
	// Two literal uses of the blue (a is bound): below the three that make a candidate.
	if len(rep.Candidates) != 0 {
		t.Errorf("candidates: %+v", rep.Candidates)
	}
	b.Add("d", "scr", "d", 0, 20, 10, 10, Rect(0), Fill(Solid(C(0.3, 0.3, 0.9))))
	rep = review.TokenUsage(b.Doc)
	if len(rep.Candidates) != 1 || rep.Candidates[0].Uses != 3 {
		t.Errorf("candidates: %+v", rep.Candidates)
	}
}
