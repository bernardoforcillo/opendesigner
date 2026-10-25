package core

import (
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Baseline alignment on the cross axis of a horizontal auto layout.

const alBaseline = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_BASELINE

func layoutText(id, parent, key string, w, h, size, lineHeight float64) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: parent, OrderKey: key, Visible: true, Opacity: 1, Width: w, Height: h,
		Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: id, Style: &opendesignerv1.TextStyle{FontSize: size, LineHeight: lineHeight}}},
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestBaselineAlignsTextOnASharedLine(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 200, 100, &al{Direction: horiz, CrossAlign: alBaseline, HugHeight: true, Spacing: 4}))
	createNode(t, doc, layoutText("small", "f", "a", 40, 14.4, 12, 0))
	createNode(t, doc, layoutText("big", "f", "b", 50, 36, 24, 1.5))
	createNode(t, doc, layoutBox("box", "f", "c", 20, 18))
	// small: half-leading (12 * 0.2) / 2 + 12 * 0.8 = 10.8; big: 24 * 0.5 / 2 + 24 * 0.8 = 25.2; box: its bottom, 18.
	base := 25.2
	for id, b := range map[string]float64{"small": 10.8, "big": 25.2, "box": 18} {
		if got := doc.Nodes[id].Y; !near(got, base-b) {
			t.Errorf("%s at y=%v, want %v", id, got, base-b)
		}
	}
	// The hugging frame is as tall as the aligned children: big hangs 36-25.2 below the line.
	if got := doc.Nodes["f"].Height; !near(got, 25.2+10.8) {
		t.Errorf("frame is %v tall, want %v", got, 25.2+10.8)
	}
	// Along the row nothing changes: 40 + 4 further.
	if got := posOf(doc, "big"); got[0] != 44 {
		t.Errorf("big at x=%v, want 44", got[0])
	}
}

func TestBaselineIsStartInAColumnAndOnTheMainAxis(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 200, 100, &al{Direction: vert, CrossAlign: alBaseline, MainAlign: alBaseline}))
	createNode(t, doc, layoutText("a", "f", "a", 40, 14.4, 12, 0))
	createNode(t, doc, layoutBox("b", "f", "b", 20, 18))
	if got := posOf(doc, "a"); got != [2]float64{0, 0} {
		t.Errorf("a at %v, want the start", got)
	}
	if got := posOf(doc, "b"); got != [2]float64{0, 14.4} {
		t.Errorf("b at %v, want {0 14.4}", got)
	}
}

func TestBaselinePerLineWhenWrapping(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 100, 100, &al{Direction: horiz, CrossAlign: alBaseline, Wrap: true, CrossSpacing: 5, Spacing: 0}))
	createNode(t, doc, layoutText("a", "f", "a", 50, 20, 12, 0))
	createNode(t, doc, layoutText("b", "f", "b", 50, 40, 24, 1.5))
	createNode(t, doc, layoutText("c", "f", "c", 50, 20, 12, 0))
	// Line 1 is a and b: b's baseline 25.2 is the line, a sits 25.2 - 10.8 below the top. Line 2 is c alone, 40 + 5 further down.
	if got := posOf(doc, "a"); !near(got[1], 14.4) {
		t.Errorf("a at y=%v, want 14.4", got[1])
	}
	if got := posOf(doc, "b"); got[1] != 0 {
		t.Errorf("b at y=%v, want 0", got[1])
	}
	if got := posOf(doc, "c"); !near(got[1], 45) {
		t.Errorf("c at y=%v, want 45", got[1])
	}
}
