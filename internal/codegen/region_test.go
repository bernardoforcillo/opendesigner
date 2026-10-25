package codegen

import (
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

func regionArea(r Region) float64 {
	t := 0.0
	for i, c := range r {
		a := 0.0
		for j := range c {
			p, q := c[j], c[(j+1)%len(c)]
			a += p.X*q.Y - q.X*p.Y
		}
		a = math.Abs(a / 2)
		if i == 0 {
			t += a
		} else {
			t -= a
		}
	}
	return t
}

func TestContainerToWorldAndRegionInWorld(t *testing.T) {
	doc := core.NewDocument("d", "d")
	page := doc.GetPages()[0].GetId()
	mk := func(id, parent string, x, y, w, h float64, shape any) *opendesignerv1.Node {
		n := &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: "a", Visible: true, X: x, Y: y, Width: w, Height: h}
		switch s := shape.(type) {
		case *opendesignerv1.FrameNode:
			n.Shape = &opendesignerv1.Node_Frame{Frame: s}
		case *opendesignerv1.RectNode:
			n.Shape = &opendesignerv1.Node_Rect{Rect: s}
		}
		return n
	}
	for _, n := range []*opendesignerv1.Node{
		mk("f", page, 100, 50, 300, 300, &opendesignerv1.FrameNode{}),
		mk("r", "f", 10, 20, 40, 30, &opendesignerv1.RectNode{}),
	} {
		if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); err != nil {
			t.Fatal(err)
		}
	}
	m := ContainerToWorld(doc, "f")
	if x, y := m.Apply(10, 20); x != 110 || y != 70 {
		t.Errorf("(10, 20) in the frame is (%v, %v) in the world, want (110, 70)", x, y)
	}
	if x, y := ContainerToWorld(doc, page).Apply(5, 6); x != 5 || y != 6 {
		t.Errorf("a page is the identity, got (%v, %v)", x, y)
	}
	inv, ok := m.Invert()
	if x, y := inv.Apply(110, 70); !ok || x != 10 || y != 20 {
		t.Errorf("inverse = (%v, %v) %v", x, y, ok)
	}
	region := RegionInWorld(doc, doc.GetNodes()["r"])
	if got := regionArea(region); math.Abs(got-1200) > 1e-9 {
		t.Errorf("area = %v, want 1200", got)
	}
	minX := math.Inf(1)
	for _, p := range region[0] {
		minX = math.Min(minX, p.X)
	}
	if minX != 110 {
		t.Errorf("the region starts at x=%v, want 110 (world)", minX)
	}
}
