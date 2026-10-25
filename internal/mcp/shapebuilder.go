package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/ctessum/polyclip-go"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
)

// THE SHAPE BUILDER (docs/vector.md), for agents. web/src/vector/shapeBuilder.ts is the editor's twin:
// the selected shapes are cut along each other's outlines into FACES -- the disjoint pieces of the
// plane that the same shapes cover -- and the gesture merges the faces it crosses into one shape
// (Alt: removes them). The editor picks faces with a click or a drag; here an agent lists the faces
// (list_shape_builder_faces), then names them by index and / or by points of a path it would drag
// (shape_builder). The arrangement is the same algorithm (shape by shape, bottom first: intersection,
// difference, remainder), over the same flattened outlines as the export's live booleans
// (codegen.RegionInWorld, polyclip-go instead of the editor's polygon-clipping). The two libraries
// agree on areas, not on vertex order or on which vertex a ring starts from, so a result is equal to the
// editor's as a shape, not byte for byte.

// minFaceArea: faces smaller than this (world units squared) are slivers of numerical noise.
const minFaceArea = 1e-4

// maxProbes bounds the path walk of shape_builder.
const maxProbes = 200000

type bpoint = polyclip.Point

// bface is one piece of the plane: a polygon (outer ring first, then its holes), in world
// coordinates, and the shapes that cover it (bottom first).
type bface struct {
	poly    []polyclip.Contour
	members []string
}

func ringArea(c polyclip.Contour) float64 {
	a := 0.0
	for i := range c {
		p, q := c[i], c[(i+1)%len(c)]
		a += p.X*q.Y - q.X*p.Y
	}
	return math.Abs(a / 2)
}

func polyArea(p []polyclip.Contour) float64 {
	t := 0.0
	for i, r := range p {
		if i == 0 {
			t += ringArea(r)
		} else {
			t -= ringArea(r)
		}
	}
	return t
}

func inRing(c polyclip.Contour, x, y float64) bool {
	in := false
	for i, j := 0, len(c)-1; i < len(c); j, i = i, i+1 {
		a, b := c[i], c[j]
		if (a.Y > y) != (b.Y > y) && x < (b.X-a.X)*(y-a.Y)/(b.Y-a.Y)+a.X {
			in = !in
		}
	}
	return in
}

// faceContains: inside the outer ring and in none of the holes.
func faceContains(f *bface, x, y float64) bool {
	return len(f.poly) > 0 && inRing(f.poly[0], x, y) && !func() bool {
		for _, h := range f.poly[1:] {
			if inRing(h, x, y) {
				return true
			}
		}
		return false
	}()
}

// splitPolygons turns the flat ring list polyclip returns (even-odd: holes are rings inside rings)
// into polygons, each an outer ring followed by its holes. Containment is decided by a vote of the
// ring's vertices, so a hole touching its outer ring at a point still counts as inside it.
func splitPolygons(p polyclip.Polygon) [][]polyclip.Contour {
	var rings []polyclip.Contour
	for _, c := range p {
		if len(c) >= 3 && ringArea(c) > 0 {
			rings = append(rings, c)
		}
	}
	inside := func(inner, outer polyclip.Contour) bool {
		if ringArea(outer) <= ringArea(inner) {
			return false
		}
		votes := 0
		for _, v := range inner {
			if inRing(outer, v.X, v.Y) {
				votes++
			}
		}
		return votes*2 > len(inner)
	}
	depth := make([]int, len(rings))
	parent := make([]int, len(rings)) // the smallest ring containing ring i, or -1
	for i := range rings {
		parent[i] = -1
		for j := range rings {
			if i != j && inside(rings[i], rings[j]) {
				depth[i]++
				if parent[i] < 0 || ringArea(rings[j]) < ringArea(rings[parent[i]]) {
					parent[i] = j
				}
			}
		}
	}
	var out [][]polyclip.Contour
	at := map[int]int{} // outer ring -> index in out
	for i := range rings {
		if depth[i]%2 == 0 {
			at[i] = len(out)
			out = append(out, []polyclip.Contour{rings[i]})
		}
	}
	for i := range rings {
		if depth[i]%2 == 1 {
			if o, ok := at[parent[i]]; ok {
				out[o] = append(out[o], rings[i])
			}
		}
	}
	return out
}

// isBooleanSource: a fillable shape, or a group with one in it.
func isBooleanSource(doc *opendesignerv1.Document, n *opendesignerv1.Node) bool {
	switch n.GetShape().(type) {
	case *opendesignerv1.Node_Group:
		for _, c := range core.ChildrenOf(doc, n.GetId()) {
			if isBooleanSource(doc, c) {
				return true
			}
		}
		return false
	case *opendesignerv1.Node_Rect, *opendesignerv1.Node_Ellipse, *opendesignerv1.Node_Vector,
		*opendesignerv1.Node_Frame, *opendesignerv1.Node_Polygon, *opendesignerv1.Node_Star:
		return true
	}
	return false
}

// builderSources are the shapes the builder takes from ids: top-level visible fillable shapes of ONE
// parent, bottom first.
func builderSources(doc *opendesignerv1.Document, ids []string) ([]*opendesignerv1.Node, error) {
	nodes, err := topmostNodes("shape_builder", doc, ids)
	if err != nil {
		return nil, err
	}
	index := drawOrder(doc)
	var out []*opendesignerv1.Node
	for _, n := range nodes {
		if !n.GetVisible() {
			return nil, fmt.Errorf("shape_builder: node %q is hidden", n.GetId())
		}
		if !isBooleanSource(doc, n) {
			return nil, fmt.Errorf("shape_builder: node %q is not a shape the builder can cut (rectangle, ellipse, polygon, star, vector, frame or a group of them)", n.GetId())
		}
		if len(out) > 0 && out[0].GetParentId() != n.GetParentId() {
			return nil, errors.New("shape_builder: the shapes must all be children of the same parent")
		}
		out = append(out, n)
	}
	sort.SliceStable(out, func(i, j int) bool { return index[out[i].GetId()] < index[out[j].GetId()] })
	return out, nil
}

// builderFaces is shapeBuilder.ts::builderFaces: shape by shape, bottom first, every existing face
// is split into the part the shape covers (gaining it as a member) and the part it does not; what is
// left of the shape is a new face of its own.
func builderFaces(doc *opendesignerv1.Document, sources []*opendesignerv1.Node) []*bface {
	var faces []*bface
	for _, n := range sources {
		region := codegen.RegionInWorld(doc, n)
		total := 0.0
		for _, p := range splitPolygons(region) {
			total += polyArea(p)
		}
		if total < minFaceArea {
			continue
		}
		var next []*bface
		push := func(m polyclip.Polygon, members []string) {
			for _, poly := range splitPolygons(m) {
				if polyArea(poly) >= minFaceArea {
					next = append(next, &bface{poly: poly, members: members})
				}
			}
		}
		rest := region
		for _, f := range faces {
			shape := polyclip.Polygon(f.poly)
			push(shape.Construct(polyclip.INTERSECTION, region), append(append([]string{}, f.members...), n.GetId()))
			push(shape.Construct(polyclip.DIFFERENCE, region), f.members)
			rest = rest.Construct(polyclip.DIFFERENCE, shape)
		}
		push(rest, []string{n.GetId()})
		faces = next
	}
	return faces
}

// facesAlong is the indices of the faces a polyline (the drag, in world coordinates) passes through;
// the end points count, and the topmost face wins where faces touch on an edge.
func facesAlong(faces []*bface, path []bpoint, step float64) []int {
	hit := map[int]bool{}
	probe := func(x, y float64) {
		for i := len(faces) - 1; i >= 0; i-- {
			if faceContains(faces[i], x, y) {
				hit[i] = true
				return
			}
		}
	}
	for i, p := range path {
		probe(p.X, p.Y)
		if i == 0 {
			continue
		}
		a := path[i-1]
		n := int(math.Ceil(math.Hypot(p.X-a.X, p.Y-a.Y) / step))
		for k := 1; k < n; k++ {
			t := float64(k) / float64(n)
			probe(a.X+(p.X-a.X)*t, a.Y+(p.Y-a.Y)*t)
		}
	}
	out := make([]int, 0, len(hit))
	for i := range hit {
		out = append(out, i)
	}
	sort.Ints(out)
	return out
}

// interiorPoint is a point inside the face: the middle of the widest stretch the face covers on a
// few horizontal lines (an agent can click it).
func interiorPoint(f *bface) (x, y float64) {
	minY, maxY := math.Inf(1), math.Inf(-1)
	for _, p := range f.poly[0] {
		minY, maxY = math.Min(minY, p.Y), math.Max(maxY, p.Y)
	}
	best := -1.0
	for _, frac := range []float64{0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9} {
		yy := minY + (maxY-minY)*frac
		var xs []float64
		for _, r := range f.poly {
			for i, j := 0, len(r)-1; i < len(r); j, i = i, i+1 {
				a, b := r[i], r[j]
				if (a.Y > yy) != (b.Y > yy) {
					xs = append(xs, (b.X-a.X)*(yy-a.Y)/(b.Y-a.Y)+a.X)
				}
			}
		}
		sort.Float64s(xs)
		for k := 0; k+1 < len(xs); k += 2 {
			if w := xs[k+1] - xs[k]; w > best {
				best, x, y = w, (xs[k]+xs[k+1])/2, yy
			}
		}
		if best > 0 && frac == 0.5 {
			break
		}
	}
	return x, y
}

func round4(v float64) float64 { return math.Round(v*1e4)/1e4 + 0 }

// builderOps is shapeBuilder.ts::shapeBuilderOps: `picked` faces are merged into one shape (merge)
// or dropped (remove); every other face becomes a shape of its own; the sources are deleted. Each new
// vector takes the style of the TOPMOST shape that covers it and sits right above the topmost source.
func builderOps(doc *opendesignerv1.Document, sources []*opendesignerv1.Node, faces []*bface, picked []int, mode string) ([]*opendesignerv1.Op, []string, error) {
	pick := map[int]bool{}
	for _, i := range picked {
		if i >= 0 && i < len(faces) {
			pick[i] = true
		}
	}
	if len(pick) == 0 || len(sources) == 0 || len(faces) == 0 {
		return nil, nil, errors.New("shape_builder: no face picked (list_shape_builder_faces for the indices)")
	}
	if mode == "merge" && len(pick) < 2 && len(faces) == 1 {
		return nil, nil, errors.New("shape_builder: the shapes make a single face, there is nothing to build")
	}
	byID := map[string]*opendesignerv1.Node{}
	order := map[string]int{}
	for i, n := range sources {
		byID[n.GetId()], order[n.GetId()] = n, i
	}
	type piece struct {
		region  polyclip.Polygon
		members []string
	}
	var pieces []piece
	var merged piece
	for i, f := range faces {
		if pick[i] {
			if mode == "remove" {
				continue
			}
			if len(merged.region) == 0 {
				merged.region = polyclip.Polygon(f.poly)
			} else {
				merged.region = merged.region.Construct(polyclip.UNION, polyclip.Polygon(f.poly))
			}
			merged.members = append(merged.members, f.members...)
		} else {
			pieces = append(pieces, piece{polyclip.Polygon(f.poly), f.members})
		}
	}
	if len(merged.members) > 0 {
		// The merged shape takes the style of the topmost of ALL the shapes under the faces it swallowed.
		seen := map[string]bool{}
		var ms []string
		for _, m := range merged.members {
			if !seen[m] {
				seen[m] = true
				ms = append(ms, m)
			}
		}
		sort.Slice(ms, func(i, j int) bool { return order[ms[i]] < order[ms[j]] })
		merged.members = ms
		pieces = append(pieces, merged)
	}
	top := sources[len(sources)-1]
	parentID := top.GetParentId()
	toParent, ok := codegen.ContainerToWorld(doc, parentID).Invert()
	if !ok {
		return nil, nil, errors.New("shape_builder: the parent's transform cannot be inverted")
	}
	ceiling := upperBound(siblingAbove(doc, top), top.GetOrderKey())
	key := top.GetOrderKey()
	var ops []*opendesignerv1.Op
	var created []string
	for _, p := range pieces {
		var rings []polyclip.Contour
		for _, c := range p.region {
			if len(c) < 3 {
				continue
			}
			r := make(polyclip.Contour, len(c))
			for i, v := range c {
				x, y := toParent.Apply(v.X, v.Y)
				r[i] = bpoint{X: x, Y: y}
			}
			rings = append(rings, r)
		}
		if len(rings) == 0 {
			continue
		}
		minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, r := range rings {
			for _, v := range r {
				minX, minY, maxX, maxY = math.Min(minX, v.X), math.Min(minY, v.Y), math.Max(maxX, v.X), math.Max(maxY, v.Y)
			}
		}
		minX, minY = round4(minX), round4(minY)
		vn := &opendesignerv1.VectorNode{}
		for _, r := range rings {
			sp := &opendesignerv1.SubPath{Closed: true}
			for _, v := range r {
				sp.Anchors = append(sp.Anchors, &opendesignerv1.Anchor{X: round4(v.X - minX), Y: round4(v.Y - minY)})
			}
			vn.Subpaths = append(vn.Subpaths, sp)
		}
		style := byID[p.members[len(p.members)-1]]
		var err error
		if key, err = core.OrderKeyBetween(key, ceiling); err != nil {
			return nil, nil, fmt.Errorf("shape_builder: %w", err)
		}
		name := style.GetName()
		if name == "" {
			name = "Shape"
		}
		n := &opendesignerv1.Node{
			Id: uuid.NewString(), ParentId: parentID, OrderKey: key, Name: name + " piece", Visible: true, Opacity: style.GetOpacity(),
			X: minX, Y: minY, Width: round4(maxX - minX), Height: round4(maxY - minY),
			Shape: &opendesignerv1.Node_Vector{Vector: vn},
		}
		for _, f := range style.GetFills() {
			n.Fills = append(n.Fills, proto.Clone(f).(*opendesignerv1.Paint))
		}
		for _, st := range style.GetStrokes() {
			n.Strokes = append(n.Strokes, proto.Clone(st).(*opendesignerv1.Stroke))
		}
		for _, e := range style.GetEffects() {
			n.Effects = append(n.Effects, proto.Clone(e).(*opendesignerv1.Effect))
		}
		ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
		created = append(created, n.Id)
	}
	for _, n := range sources {
		ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: n.GetId()}}})
	}
	return ops, created, nil
}

// --- tools ---------------------------------------------------------------

// ShapeBuilderFacesInput selects the shapes to cut.
type ShapeBuilderFacesInput struct {
	Ids []string `json:"ids" jsonschema:"the shapes (rectangle, ellipse, polygon, star, vector, frame, or a group of them) to cut along each other's outlines; all children of the same parent"`
}

// BuilderPoint is a point in world coordinates.
type BuilderPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// BuilderFace describes one region of the arrangement.
type BuilderFace struct {
	Index   int          `json:"index" jsonschema:"the face's index: pass it in shape_builder faces"`
	Members []string     `json:"members" jsonschema:"ids of the shapes covering the face, bottom first; the last one gives the style of anything built from it"`
	Names   []string     `json:"names"`
	Area    float64      `json:"area"`
	Bounds  [4]float64   `json:"bounds" jsonschema:"minX, minY, maxX, maxY in world coordinates"`
	Point   BuilderPoint `json:"point" jsonschema:"a point inside the face (the same coordinates as shape_builder points)"`
	Holes   int          `json:"holes"`
}

type ShapeBuilderFacesOutput struct {
	Faces []BuilderFace `json:"faces"`
}

func describeFaces(doc *opendesignerv1.Document, faces []*bface) []BuilderFace {
	out := make([]BuilderFace, 0, len(faces))
	for i, f := range faces {
		bf := BuilderFace{Index: i, Members: f.members, Area: round4(polyArea(f.poly)), Holes: len(f.poly) - 1}
		for _, id := range f.members {
			bf.Names = append(bf.Names, doc.GetNodes()[id].GetName())
		}
		minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
		for _, v := range f.poly[0] {
			minX, minY, maxX, maxY = math.Min(minX, v.X), math.Min(minY, v.Y), math.Max(maxX, v.X), math.Max(maxY, v.Y)
		}
		bf.Bounds = [4]float64{round4(minX), round4(minY), round4(maxX), round4(maxY)}
		x, y := interiorPoint(f)
		bf.Point = BuilderPoint{round4(x), round4(y)}
		out = append(out, bf)
	}
	return out
}

// ListShapeBuilderFaces shows the regions the shape builder would offer for the shapes.
func (s *Session) ListShapeBuilderFaces(ctx context.Context, in ShapeBuilderFacesInput) (ShapeBuilderFacesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	src, err := builderSources(s.doc, in.Ids)
	if err != nil {
		return ShapeBuilderFacesOutput{}, err
	}
	return ShapeBuilderFacesOutput{Faces: describeFaces(s.doc, builderFaces(s.doc, src))}, nil
}

// ShapeBuilderInput is one shape-builder gesture.
type ShapeBuilderInput struct {
	Ids    []string       `json:"ids" jsonschema:"the shapes to cut (as in list_shape_builder_faces)"`
	Mode   string         `json:"mode,omitempty" jsonschema:"merge (default: the picked faces become ONE shape) | remove (the picked faces are dropped, like Alt-dragging)"`
	Faces  []int          `json:"faces,omitempty" jsonschema:"indices of faces to pick, from list_shape_builder_faces"`
	Points []BuilderPoint `json:"points,omitempty" jsonschema:"a path in world coordinates, as a drag across the canvas: every face it passes through is picked (one point = a click). Combined with faces"`
	Step   float64        `json:"step,omitempty" jsonschema:"spacing of the probes along the path segments, in world units; default 1"`
}

type ShapeBuilderOutput struct {
	NodeIds    []string `json:"nodeIds" jsonschema:"the new vector nodes (one per face left alone, one for the merge)"`
	DeletedIds []string `json:"deletedIds" jsonschema:"the source shapes, deleted"`
	Picked     []int    `json:"picked" jsonschema:"the faces that were picked"`
	Changed    int      `json:"changed"`
	Seq        uint64   `json:"seq"`
}

// ShapeBuilder cuts the shapes into faces, merges (or removes) the picked ones and replaces the
// sources with the resulting vector nodes.
func (s *Session) ShapeBuilder(ctx context.Context, in ShapeBuilderInput) (ShapeBuilderOutput, error) {
	mode := in.Mode
	if mode == "" {
		mode = "merge"
	}
	if mode != "merge" && mode != "remove" {
		return ShapeBuilderOutput{}, fmt.Errorf("shape_builder: mode must be merge or remove, got %q", in.Mode)
	}
	step := in.Step
	if step <= 0 {
		step = 1
	}
	length := 0.0
	for i := 1; i < len(in.Points); i++ {
		length += math.Hypot(in.Points[i].X-in.Points[i-1].X, in.Points[i].Y-in.Points[i-1].Y)
	}
	if length/step > maxProbes {
		return ShapeBuilderOutput{}, fmt.Errorf("shape_builder: the path is too long for step %g (at most %d probes); raise step or shorten the path", step, maxProbes)
	}
	s.mu.Lock()
	src, err := builderSources(s.doc, in.Ids)
	var ops []*opendesignerv1.Op
	var created []string
	var picked []int
	if err == nil {
		faces := builderFaces(s.doc, src)
		path := make([]bpoint, len(in.Points))
		for i, p := range in.Points {
			path[i] = bpoint{X: p.X, Y: p.Y}
		}
		set := map[int]bool{}
		for _, i := range facesAlong(faces, path, step) {
			set[i] = true
		}
		for _, i := range in.Faces {
			if i < 0 || i >= len(faces) {
				err = fmt.Errorf("shape_builder: face %d does not exist (there are %d, 0-based)", i, len(faces))
			}
			set[i] = true
		}
		for i := range set {
			picked = append(picked, i)
		}
		sort.Ints(picked)
		if err == nil {
			ops, created, err = builderOps(s.doc, src, faces, picked, mode)
		}
	}
	s.mu.Unlock()
	if err != nil {
		return ShapeBuilderOutput{}, err
	}
	out := ShapeBuilderOutput{NodeIds: created, Picked: picked, Changed: len(ops)}
	for _, n := range src {
		out.DeletedIds = append(out.DeletedIds, n.GetId())
	}
	out.Seq, err = s.submitAll(ctx, ops)
	return out, err
}

func registerShapeBuilderTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_shape_builder_faces", "The regions of overlapping shapes, as the Shape Builder tool sees them: the shapes are cut along each other's outlines into faces (the disjoint pieces of the plane the same shapes cover; a shape cut in two by another makes two). Returns each face with the shapes covering it, its area, bounds and a point inside it, in world coordinates. Read-only.", s.ListShapeBuilderFaces)
	addTool(srv, "shape_builder", "The Shape Builder gesture: cut overlapping shapes (same parent) into faces and MERGE the picked faces into one vector (mode merge) or DROP them (mode remove); every other face becomes a vector of its own and the source shapes are deleted. Pick faces by index (faces, from list_shape_builder_faces) and / or by a path of points in world coordinates (points: every face the path crosses, like a drag; one point is a click). New vectors take the fills, strokes, effects and opacity of the topmost shape covering them and sit right above the topmost source. Curves are flattened to polygons, as in the editor.", s.ShapeBuilder)
}
