package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Size limits and absolute children of an auto layout frame.

func fillX(n *opendesignerv1.Node) *opendesignerv1.Node {
	n.LayoutSizingX = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	return n
}

func TestLayoutMaxWidthCapsAFixedChild(t *testing.T) {
	doc := row(t, &al{Direction: horiz})
	if err := setProps(t, doc, "b", &opendesignerv1.Node{Width: 80, MaxWidth: 30}, "width", "max_width"); err != nil {
		t.Fatal(err)
	}
	if got := sizeOf(doc, "b"); got != [2]float64{30, 10} {
		t.Errorf("b is %v, want 30x10", got)
	}
	// The next sibling follows the clamped size.
	if got := posOf(doc, "c"); got != [2]float64{75, 7} {
		t.Errorf("c at %v, want {75 7}", got)
	}
}

func TestLayoutMinWinsOverMax(t *testing.T) {
	doc := row(t, &al{Direction: horiz})
	if err := setProps(t, doc, "a", &opendesignerv1.Node{MinWidth: 50, MaxWidth: 40}, "min_width", "max_width"); err != nil {
		t.Fatal(err)
	}
	if got := sizeOf(doc, "a")[0]; got != 50 {
		t.Errorf("a is %v wide, want 50", got)
	}
}

func TestLayoutMinHeightCrossAxis(t *testing.T) {
	doc := row(t, &al{Direction: horiz, HugHeight: true})
	if err := setProps(t, doc, "a", &opendesignerv1.Node{MinHeight: 40}, "min_height"); err != nil {
		t.Fatal(err)
	}
	// 7 + 40 + 7: the hugging frame grows with the clamped child.
	if got := sizeOf(doc, "f")[1]; got != 54 {
		t.Errorf("f is %v tall, want 54", got)
	}
}

func TestLayoutFillRespectsLimitsAndRedistributes(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 100, 20, &al{Direction: horiz}))
	createNode(t, doc, fillX(layoutBox("a", "f", "a", 10, 10)))
	createNode(t, doc, fillX(layoutBox("b", "f", "b", 10, 10)))
	createNode(t, doc, fillX(layoutBox("c", "f", "c", 10, 10)))
	// An even split would be 33.33 each; c is capped at 20, so a and b share 80.
	if err := setProps(t, doc, "c", &opendesignerv1.Node{MaxWidth: 20}, "max_width"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]float64{"a": 40, "b": 40, "c": 20} {
		if got := doc.Nodes[id].Width; got != want {
			t.Errorf("%s is %v wide, want %v", id, got, want)
		}
	}
	if got := posOf(doc, "c"); got[0] != 80 {
		t.Errorf("c at %v, want x=80", got)
	}
	// A min on a fill child that exceeds its share pushes the others down.
	if err := setProps(t, doc, "c", &opendesignerv1.Node{MinWidth: 70}, "min_width"); err != nil {
		t.Fatal(err)
	}
	if err := setProps(t, doc, "c", &opendesignerv1.Node{MaxWidth: 0}, "max_width"); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]float64{"a": 15, "b": 15, "c": 70} {
		if got := doc.Nodes[id].Width; got != want {
			t.Errorf("%s is %v wide after the min, want %v", id, got, want)
		}
	}
}

func TestLayoutCappedFillLeavesRoomForAlignment(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 100, 20, &al{Direction: horiz, MainAlign: alEnd}))
	n := fillX(layoutBox("a", "f", "a", 10, 10))
	n.MaxWidth = 30
	createNode(t, doc, n)
	if got := doc.Nodes["a"].Width; got != 30 {
		t.Fatalf("a is %v wide, want 30", got)
	}
	if got := posOf(doc, "a")[0]; got != 70 {
		t.Errorf("a at x=%v, want 70 (aligned to the end)", got)
	}
}

func TestLayoutHugFrameHonoursItsOwnLimits(t *testing.T) {
	doc := row(t, &al{Direction: horiz, HugWidth: true})
	// Content: 5 + 3*20 + 2*10 + 5 = 90.
	if got := sizeOf(doc, "f")[0]; got != 90 {
		t.Fatalf("f is %v wide, want 90", got)
	}
	if err := setProps(t, doc, "f", &opendesignerv1.Node{MinWidth: 120}, "min_width"); err != nil {
		t.Fatal(err)
	}
	if got := sizeOf(doc, "f")[0]; got != 120 {
		t.Errorf("f is %v wide, want 120", got)
	}
	if err := setProps(t, doc, "f", &opendesignerv1.Node{MinWidth: 0, MaxWidth: 60}, "min_width", "max_width"); err != nil {
		t.Fatal(err)
	}
	if got := sizeOf(doc, "f")[0]; got != 60 {
		t.Errorf("f is %v wide, want 60", got)
	}
}

func TestLayoutWrappedClampsBeforeCuttingLines(t *testing.T) {
	doc := row(t, &al{Direction: horiz, Wrap: true, CrossSpacing: 4})
	// Inner main extent: 190. Three children of 100 do not fit one line.
	for _, id := range []string{"a", "b", "c"} {
		if err := setProps(t, doc, id, &opendesignerv1.Node{MinWidth: 100}, "min_width"); err != nil {
			t.Fatal(err)
		}
	}
	// a (100) + gap + b (100) = 210 > 190: b starts the second line.
	if got := posOf(doc, "b"); got != [2]float64{5, 21} {
		t.Errorf("b at %v, want {5 21}", got)
	}
}

func TestLayoutAbsoluteChildLeavesTheFlow(t *testing.T) {
	doc := row(t, &al{Direction: horiz, HugWidth: true})
	// Content without b: 5 + 2*20 + 10 + 5 = 60.
	if err := setProps(t, doc, "b", &opendesignerv1.Node{
		LayoutPositioning: opendesignerv1.LayoutPositioning_LAYOUT_POSITIONING_ABSOLUTE, X: 3, Y: 4,
	}, "layout_positioning", "x", "y"); err != nil {
		t.Fatal(err)
	}
	if got := sizeOf(doc, "f")[0]; got != 60 {
		t.Errorf("f is %v wide, want 60", got)
	}
	if got := posOf(doc, "c"); got != [2]float64{35, 7} {
		t.Errorf("c at %v, want {35 7}", got)
	}
	if got := posOf(doc, "b"); got != [2]float64{3, 4} {
		t.Errorf("b at %v, want {3 4} (kept)", got)
	}
	// Back in the flow.
	if err := setProps(t, doc, "b", &opendesignerv1.Node{}, "layout_positioning"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "b"); got != [2]float64{35, 7} {
		t.Errorf("b at %v, want {35 7}", got)
	}
}

func TestLayoutAbsoluteChildFollowsItsConstraints(t *testing.T) {
	doc := row(t, &al{Direction: horiz})
	if err := setProps(t, doc, "b", &opendesignerv1.Node{
		LayoutPositioning: opendesignerv1.LayoutPositioning_LAYOUT_POSITIONING_ABSOLUTE, X: 150, Y: 80,
		ConstraintX: opendesignerv1.Constraint_CONSTRAINT_MAX, ConstraintY: opendesignerv1.Constraint_CONSTRAINT_MAX,
	}, "layout_positioning", "x", "y", "constraint_x", "constraint_y"); err != nil {
		t.Fatal(err)
	}
	// Resizing the frame by 50 x 20 moves the pinned child, the flow children stay in the flow.
	if err := setProps(t, doc, "f", &opendesignerv1.Node{Width: 250, Height: 120}, "width", "height"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "b"); got != [2]float64{200, 100} {
		t.Errorf("b at %v, want {200 100}", got)
	}
	if got := posOf(doc, "c"); got != [2]float64{35, 7} {
		t.Errorf("c at %v, want {35 7}", got)
	}
}

func TestLayoutAbsoluteChildFollowsAHuggingFrame(t *testing.T) {
	doc := row(t, &al{Direction: horiz, HugWidth: true})
	if err := setProps(t, doc, "c", &opendesignerv1.Node{
		LayoutPositioning: opendesignerv1.LayoutPositioning_LAYOUT_POSITIONING_ABSOLUTE, X: 40, Y: 0,
		ConstraintX: opendesignerv1.Constraint_CONSTRAINT_MAX,
	}, "layout_positioning", "x", "y", "constraint_x"); err != nil {
		t.Fatal(err)
	}
	// f shrank from 90 to 60 when c left the flow: the child pinned to the right edge moved with it.
	if got := posOf(doc, "c")[0]; got != 10 {
		t.Errorf("c at x=%v, want 10", got)
	}
}

func TestLayoutLimitRejections(t *testing.T) {
	doc := row(t, &al{Direction: horiz})
	if err := setProps(t, doc, "a", &opendesignerv1.Node{MinWidth: -1}, "min_width"); !errors.Is(err, ErrSizeLimit) {
		t.Errorf("negative limit: %v", err)
	}
	if err := setProps(t, doc, "a", &opendesignerv1.Node{LayoutPositioning: 7}, "layout_positioning"); !errors.Is(err, ErrLayoutPositioning) {
		t.Errorf("unknown positioning: %v", err)
	}
}
