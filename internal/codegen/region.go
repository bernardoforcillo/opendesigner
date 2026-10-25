package codegen

import (
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/ctessum/polyclip-go"
)

// The geometry the export uses for live booleans, offered to the MCP tools (shape_builder, the
// group / ungroup position math). The editor's twins are web/src/vector/regions.ts (regions) and
// web/src/canvas/transform.ts (worldTransformOf).

// Affine is a 2D matrix [a c e; b d f]: (x, y) -> (a*x + c*y + e, b*x + d*y + f).
type Affine = affine

// Apply maps a point.
func (m Affine) Apply(x, y float64) (float64, float64) { return m.apply(x, y) }

// Invert returns the inverse matrix; ok is false for a singular one.
func (m Affine) Invert() (Affine, bool) {
	det := m.a*m.d - m.b*m.c
	if math.Abs(det) < 1e-12 {
		return identity, false
	}
	return Affine{
		a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
		e: (m.c*m.f - m.d*m.e) / det, f: (m.b*m.e - m.a*m.f) / det,
	}, true
}

// ContainerToWorld maps the local space of container `id` (a node: where its children's
// coordinates live) to the world. A page, an unknown id or "" is the identity.
func ContainerToWorld(doc *opendesignerv1.Document, id string) Affine {
	m := identity
	seen := map[string]bool{}
	for {
		n := doc.GetNodes()[id]
		if n == nil || seen[id] {
			return m
		}
		seen[id] = true
		m = m.then(localAffine(n))
		id = n.GetParentId()
	}
}

// Region is the area a shape fills: closed rings, even-odd (holes are rings inside rings).
type Region = polyclip.Polygon

// RegionInWorld is the area node n fills in WORLD coordinates (rounded corners and ellipses as
// polygons, curves flattened, groups as the union of their children, a live boolean group as its
// operation). Empty for a hidden node, a mask or a shape with no fill area.
func RegionInWorld(doc *opendesignerv1.Document, n *opendesignerv1.Node) Region {
	b := &builder{doc: doc}
	return b.regionOf(n, ContainerToWorld(doc, n.GetParentId()))
}
