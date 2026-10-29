package flow

import (
	"reflect"
	"strings"
	"testing"
)

// chainDoc: Cart -> Big / Standard / Basic over one hotspot (click on the Pay button).
func chainDoc() *tdoc {
	d := newTDoc().node("cart", "Cart").node("btn", "Pay button").node("big", "Big").node("std", "Standard").node("basic", "Basic").
		flow("f1", "Checkout", "cart")
	for _, to := range []string{"big", "std", "basic"} {
		d.tr("to-"+to, "f1", "cart", to, "Pay", "click").ElementId = "btn"
		d.tr("back-"+to, "f1", to, "cart", "Back", "click") // so nothing is a dead end
	}
	return d
}

func wantIssues(t *testing.T, d *tdoc, want ...string) {
	t.Helper()
	var got []string
	for _, r := range Analyze(d.Document, "f1") {
		for _, i := range r.GetIssues() {
			got = append(got, i.GetKind()+":"+i.GetTransitionId())
		}
	}
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("issues = %v, want %v", got, want)
	}
}

func TestIfElseChainIsClean(t *testing.T) {
	d := chainDoc()
	d.Transitions["to-big"].Guard, d.Transitions["to-big"].Order = "total > 100", 1
	d.Transitions["to-std"].Guard, d.Transitions["to-std"].Order = "total > 50", 2
	d.Transitions["to-basic"].Guard, d.Transitions["to-basic"].Order = "else", 3
	wantIssues(t, d)
}

func TestElseWithNothingToBeTheElseOf(t *testing.T) {
	d := newTDoc().node("cart", "Cart").node("done", "Done").flow("f1", "Checkout", "cart")
	d.tr("only", "f1", "cart", "done", "Pay", "click").Guard = "else"
	d.tr("back", "f1", "done", "cart", "Again", "click")
	wantIssues(t, d, "else_orphan:only")

	// An if on the same trigger gives it something to be the else of.
	d.tr("if", "f1", "cart", "done", "Pay", "click").Guard = "paid"
	wantIssues(t, d)

	// ...but not an if on ANOTHER hotspot (another element).
	d.node("btn", "Pay button")
	d.Transitions["if"].ElementId = "btn"
	wantIssues(t, d, "else_orphan:only")
}

func TestChainBranchAfterAnUnconditionalOneIsShadowed(t *testing.T) {
	d := chainDoc()
	d.Transitions["to-big"].Guard, d.Transitions["to-big"].Order = "total > 100", 1
	d.Transitions["to-std"].Order = 2 // no condition: always holds
	d.Transitions["to-basic"].Guard, d.Transitions["to-basic"].Order = "else", 3
	wantIssues(t, d, "shadowed:to-basic")

	if msg := Analyze(d.Document, "f1")[0].GetIssues()[0].GetMessage(); !strings.Contains(msg, "always applies") {
		t.Errorf("message = %q", msg)
	}
}

func TestChainRepeatedConditionAndSamePosition(t *testing.T) {
	d := chainDoc()
	d.Transitions["to-big"].Guard, d.Transitions["to-big"].Order = "total > 100", 1
	d.Transitions["to-std"].Guard, d.Transitions["to-std"].Order = "total > 100", 2
	d.Transitions["to-basic"].Guard, d.Transitions["to-basic"].Order = "else", 3
	// The same condition in an ordered chain is a shadowed branch, not an ambiguity.
	wantIssues(t, d, "shadowed:to-std")

	d.Transitions["to-std"].Guard, d.Transitions["to-std"].Order = "total > 50", 1
	wantIssues(t, d, "ambiguous:to-std")
}

func TestSpecMentionsTheChainPosition(t *testing.T) {
	d := chainDoc()
	d.Transitions["to-big"].Guard, d.Transitions["to-big"].Order = "total > 100", 1
	if spec := Spec(d.Document, "f1"); !strings.Contains(spec, "if / else if chain, position 1") {
		t.Errorf("spec lacks the chain position:\n%s", spec)
	}
}

func TestComponentStateChangeIsNotAStepOfTheJourney(t *testing.T) {
	d := newTDoc().node("cart", "Cart").node("done", "Done").node("btn", "Pay button").node("hover", "Pay hover").flow("f1", "Checkout", "cart")
	d.tr("go", "f1", "cart", "done", "Pay", "click")
	d.tr("back", "f1", "done", "cart", "Again", "click")
	v := d.tr("v", "f1", "cart", "hover", "", "hover")
	v.ElementId, v.Animation = "btn", AnimSetVariant
	// The master "hover" is no screen: without the exclusion it would be an unreachable dead end.
	wantIssues(t, d)
}
