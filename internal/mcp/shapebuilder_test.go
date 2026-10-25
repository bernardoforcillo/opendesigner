package mcp_test

import (
	"context"
	"math"
	"sort"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

type builderScene struct {
	t   *testing.T
	s   *odmcp.Session
	ids map[string]string
}

func newBuilderScene(t *testing.T) *builderScene {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	return &builderScene{t: t, s: startSession(t, url, docID, "agent"), ids: map[string]string{}}
}

func (b *builderScene) rect(name string, x, y, w, h float64, radius float64) {
	b.t.Helper()
	out, err := b.s.CreateRectangle(context.Background(), odmcp.CreateShapeInput{X: x, Y: y, Width: w, Height: h, Name: name})
	if err != nil {
		b.t.Fatal(err)
	}
	if radius > 0 {
		if _, err := b.s.SetProperties(context.Background(), odmcp.SetPropertiesInput{Id: out.NodeId, CornerRadius: &radius}); err != nil {
			b.t.Fatal(err)
		}
	}
	b.ids[name] = out.NodeId
}

func (b *builderScene) ellipse(name string, x, y, w, h float64) {
	b.t.Helper()
	out, err := b.s.CreateEllipse(context.Background(), odmcp.CreateShapeInput{X: x, Y: y, Width: w, Height: h, Name: name})
	if err != nil {
		b.t.Fatal(err)
	}
	b.ids[name] = out.NodeId
}

func (b *builderScene) list(names ...string) []odmcp.BuilderFace {
	b.t.Helper()
	var ids []string
	for _, n := range names {
		ids = append(ids, b.ids[n])
	}
	out, err := b.s.ListShapeBuilderFaces(context.Background(), odmcp.ShapeBuilderFacesInput{Ids: ids})
	if err != nil {
		b.t.Fatal(err)
	}
	return out.Faces
}

func (b *builderScene) idsOf(names ...string) []string {
	var ids []string
	for _, n := range names {
		ids = append(ids, b.ids[n])
	}
	return ids
}

// GOLDEN: the face areas (sorted) shapeBuilder.ts computes for the same scenes (builderFaces with
// polygon-clipping, run in vitest). Same outlines (12 steps per rounded corner, 96 per ellipse), so
// the two clipping libraries must agree to rounding noise.
func TestShapeBuilderFacesMatchTheEditor(t *testing.T) {
	areaTol := func(want float64) float64 { return 1e-6 + 1e-9*want }
	cases := []struct {
		name  string
		build func(b *builderScene) []string
		want  []float64
		holes int // faces with a hole
	}{
		{"two overlapping squares", func(b *builderScene) []string {
			b.rect("a", 0, 0, 100, 100, 0)
			b.rect("b", 50, 50, 100, 100, 0)
			return []string{"a", "b"}
		}, []float64{2500, 7500, 7500}, 0},
		{"a square inside a square", func(b *builderScene) []string {
			b.rect("a", 0, 0, 100, 100, 0)
			b.rect("b", 25, 25, 50, 50, 0)
			return []string{"a", "b"}
		}, []float64{2500, 7500}, 1},
		{"a shape cut in two", func(b *builderScene) []string {
			b.rect("a", 0, 0, 100, 20, 0)
			b.rect("b", 40, -10, 20, 40, 0)
			return []string{"a", "b"}
		}, []float64{200, 200, 400, 800, 800}, 0},
		{"rectangle and ellipse", func(b *builderScene) []string {
			b.rect("a", 0, 0, 100, 80, 0)
			b.ellipse("b", 60, 10, 80, 60)
			return []string{"a", "b"}
		}, []float64{1883.61012182812, 1883.6101218281203, 6116.38987817188}, 0},
		{"rounded rectangle, ellipse and square", func(b *builderScene) []string {
			b.rect("a", 0, 0, 100, 80, 20)
			b.ellipse("b", 50, 20, 100, 100)
			b.rect("c", 30, 30, 40, 40, 0)
			return []string{"a", "b", "c"}
		}, []float64{558.2971516821731, 1041.702848317827, 1813.5297905326893, 4239.5216547798045, 5476.548565402303}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := newBuilderScene(t)
			faces := b.list(c.build(b)...)
			var got []float64
			holes := 0
			for _, f := range faces {
				got = append(got, f.Area)
				if f.Holes > 0 {
					holes++
				}
			}
			sort.Float64s(got)
			if len(got) != len(c.want) || holes != c.holes {
				t.Fatalf("areas = %v (%d with holes), want %v (%d)", got, holes, c.want, c.holes)
			}
			for i := range got {
				// The tool reports areas to 4 decimals.
				if math.Abs(got[i]-c.want[i]) > math.Max(areaTol(c.want[i]), 6e-5) {
					t.Errorf("face %d area = %v, want %v", i, got[i], c.want[i])
				}
			}
		})
	}
}

// TestShapeBuilderGesture: merge two faces by index and by a dragged path, remove one, and the
// refusals.
func TestShapeBuilderGesture(t *testing.T) {
	ctx := context.Background()
	b := newBuilderScene(t)
	b.rect("a", 0, 0, 100, 100, 0)
	b.rect("b", 50, 50, 100, 100, 0)
	faces := b.list("a", "b")
	if len(faces) != 3 {
		t.Fatalf("%d faces, want 3", len(faces))
	}
	// Every face reports a point inside itself, and the members bottom first.
	for _, f := range faces {
		if f.Point.X < f.Bounds[0] || f.Point.X > f.Bounds[2] || f.Point.Y < f.Bounds[1] || f.Point.Y > f.Bounds[3] {
			t.Errorf("face %d: point %v outside bounds %v", f.Index, f.Point, f.Bounds)
		}
	}

	// Merging with a drag from the top-left crescent to the overlap: the drag crosses two faces.
	out, err := b.s.ShapeBuilder(ctx, odmcp.ShapeBuilderInput{
		Ids:    b.idsOf("a", "b"),
		Points: []odmcp.BuilderPoint{{X: 10, Y: 10}, {X: 70, Y: 70}},
	})
	if err != nil || len(out.Picked) != 2 || len(out.NodeIds) != 2 || len(out.DeletedIds) != 2 {
		t.Fatalf("ShapeBuilder = %+v %v", out, err)
	}
	doc, _ := b.s.GetDocument(ctx, struct{}{})
	if _, ok := nodeByID(doc, b.ids["a"]); ok {
		t.Error("a source shape survived")
	}
	areaOf := map[string]float64{}
	for _, id := range out.NodeIds {
		n, ok := nodeByID(doc, id)
		if !ok || n.Kind != "vector" {
			t.Fatalf("result %s = %+v (%v)", id, n, ok)
		}
		areaOf[id] = n.Width * n.Height
	}
	// The merged piece is the first crescent plus the overlap: an L covering a 100x100 box.
	// The leftover is the second crescent: a 100x100 box too.
	for id, a := range areaOf {
		if math.Abs(a-10000) > 1e-6 {
			t.Errorf("piece %s has a %v box, want 100 x 100", id, a)
		}
	}

	// Remove: with the overlap picked, the crescents survive and the overlap is gone.
	b2 := newBuilderScene(t)
	b2.rect("a", 0, 0, 100, 100, 0)
	b2.rect("b", 50, 50, 100, 100, 0)
	var overlap int
	for _, f := range b2.list("a", "b") {
		if len(f.Members) == 2 {
			overlap = f.Index
		}
	}
	rm, err := b2.s.ShapeBuilder(ctx, odmcp.ShapeBuilderInput{Ids: b2.idsOf("a", "b"), Mode: "remove", Faces: []int{overlap}})
	if err != nil || len(rm.NodeIds) != 2 {
		t.Fatalf("remove = %+v %v", rm, err)
	}

	// Refusals.
	b3 := newBuilderScene(t)
	b3.rect("a", 0, 0, 10, 10, 0)
	b3.rect("far", 100, 100, 10, 10, 0)
	if _, err := b3.s.ShapeBuilder(ctx, odmcp.ShapeBuilderInput{Ids: b3.idsOf("a", "far")}); err == nil {
		t.Error("a gesture with nothing picked was accepted")
	}
	if _, err := b3.s.ShapeBuilder(ctx, odmcp.ShapeBuilderInput{Ids: b3.idsOf("a", "far"), Faces: []int{9}}); err == nil {
		t.Error("a face that does not exist was accepted")
	}
	if _, err := b3.s.ShapeBuilder(ctx, odmcp.ShapeBuilderInput{Ids: b3.idsOf("a", "far"), Faces: []int{0}, Mode: "xor"}); err == nil {
		t.Error("an unknown mode was accepted")
	}
	fr := frame(t, b3.s, "F")
	inner, err := b3.s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: fr, Width: 5, Height: 5})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b3.s.ListShapeBuilderFaces(ctx, odmcp.ShapeBuilderFacesInput{Ids: []string{b3.ids["a"], inner.NodeId}}); err == nil {
		t.Error("shapes of different parents were accepted")
	}
	txt, _ := b3.s.CreateText(ctx, odmcp.CreateTextInput{Content: "hi", Width: 10, Height: 10})
	if _, err := b3.s.ListShapeBuilderFaces(ctx, odmcp.ShapeBuilderFacesInput{Ids: []string{b3.ids["a"], txt.NodeId}}); err == nil {
		t.Error("a text node was accepted")
	}
	// A lone face has nothing to build when merged.
	b4 := newBuilderScene(t)
	b4.rect("a", 0, 0, 10, 10, 0)
	if _, err := b4.s.ShapeBuilder(ctx, odmcp.ShapeBuilderInput{Ids: b4.idsOf("a"), Faces: []int{0}}); err == nil {
		t.Error("merging a single face was accepted")
	}
}
