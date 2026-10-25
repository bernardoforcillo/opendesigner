package codegen

import (
	"math"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// cssLayerRed evaluates the red channel of the diamond's background layers at (x, y) by the CSS
// rules themselves (gradient line through the tile centre, 0% at the corner it points away from, length
// |w sin|+|h cos|), so the test checks the generated geometry and not a copy of the generator's maths.
// The stops are #f00 -> #00f, so red goes 1 -> 0.
func cssLayerRed(t *testing.T, props []Prop, x, y float64) float64 {
	t.Helper()
	val := func(name string) []string {
		for _, p := range props {
			if p.Name == name {
				return splitTop(p.Value, ',')
			}
		}
		t.Fatalf("no %s in %+v", name, props)
		return nil
	}
	// Layers and sizes are comma lists; "a b" pairs hold no commas, gradients are split outside parentheses.
	images, sizes, positions := val("background-image"), val("background-size"), val("background-position")
	for i := range images {
		f := strings.Fields(strings.ReplaceAll(sizes[i], "px", ""))
		wq, _ := cssNum(f[0])
		hq, _ := cssNum(f[1])
		f = strings.Fields(strings.ReplaceAll(positions[i], "px", ""))
		x0, _ := cssNum(f[0])
		y0, _ := cssNum(f[1])
		if x < x0 || x >= x0+wq || y < y0 || y >= y0+hq {
			continue
		}
		parts := splitTop(images[i][strings.Index(images[i], "(")+1:len(images[i])-1], ',')
		deg, _ := cssNum(parts[0])
		a := deg * math.Pi / 180
		dx, dy := math.Sin(a), -math.Cos(a)
		length := math.Abs(wq*dx) + math.Abs(hq*dy)
		frac := ((x-(x0+wq/2))*dx+(y-(y0+hq/2))*dy)/length + 0.5
		type sp struct{ pos, red float64 }
		var stops []sp
		for _, s := range parts[1:] {
			f := strings.Fields(s)
			pos, _ := cssNum(f[1])
			red := 0.0
			if f[0] == "#f00" {
				red = 1
			}
			stops = append(stops, sp{pos / 100, red})
		}
		if frac <= stops[0].pos {
			return stops[0].red
		}
		for k := 1; k < len(stops); k++ {
			if frac <= stops[k].pos {
				a, b := stops[k-1], stops[k]
				return a.red + (b.red-a.red)*(frac-a.pos)/(b.pos-a.pos)
			}
		}
		return stops[len(stops)-1].red
	}
	t.Fatalf("(%v,%v) is in no layer: %+v", x, y, props)
	return 0
}

// The diamond's quadrant layers reproduce |dx|+|dy| over the whole box: centre inside, off-centre on a
// non-square box, outside the box and on a corner.
func TestDiamondLayersMatchTheCanvasMaths(t *testing.T) {
	a, b := col(1, 0, 0, 1), col(0, 0, 1, 1)
	for _, c := range []struct {
		name      string
		w, h      float64
		g         *opendesignerv1.GradientPaint
		wantTiles int
	}{
		{"centred, square", 100, 100, grad(0.5, 0.5, 1, 0.5, stop(0, a), stop(1, b)), 4},
		{"off-centre, wide", 200, 80, grad(0.3, 0.6, 0.9, 0.1, stop(0, a), stop(1, b)), 4},
		{"centre outside to the left", 120, 90, grad(-0.2, 0.5, 0.8, 0.5, stop(0, a), stop(1, b)), 2},
		{"centre on the corner", 100, 100, grad(0, 0, 1, 1, stop(0, a), stop(1, b)), 1},
	} {
		props, ok := diamondLayers(c.g, c.w, c.h, 1)
		if !ok {
			t.Fatalf("%s: not drawable", c.name)
		}
		if n := len(splitTop(props[1].Value, ',')); n != c.wantTiles {
			t.Errorf("%s: %d tiles, want %d (%s)", c.name, n, c.wantTiles, props[1].Value)
		}
		cx, cy := c.g.X1*c.w, c.g.Y1*c.h
		l := math.Hypot(c.g.X2*c.w-cx, c.g.Y2*c.h-cy)
		for i := 0; i < 23; i++ {
			for j := 0; j < 17; j++ {
				x, y := (float64(i)+0.5)*c.w/23, (float64(j)+0.5)*c.h/17
				want := 1 - math.Min(1, (math.Abs(x-cx)+math.Abs(y-cy))/l)
				if got := cssLayerRed(t, props, x, y); math.Abs(got-want) > 0.01 {
					t.Fatalf("%s: red at (%.1f,%.1f) = %.3f, want %.3f", c.name, x, y, got, want)
				}
			}
		}
	}
	if _, ok := diamondLayers(grad(0.5, 0.5, 0.5, 0.5, stop(0, a), stop(1, b)), 100, 100, 1); ok {
		t.Error("a null extent should fall back to the flat colour")
	}
}

// A multi-layer background-image is an explicit property in Tailwind; a single gradient stays a bg-[...] utility.
func TestTailwindLayeredDiamond(t *testing.T) {
	a, b := col(1, 0, 0, 1), col(0, 0, 1, 1)
	props, _ := diamondLayers(grad(0.5, 0.5, 1, 0.5, stop(0, a), stop(1, b)), 100, 100, 1)
	cls := className(props)
	for _, want := range []string{"[background-image:linear-gradient(45deg,#f00_0%,#00f_50%),", "[background-size:50px_50px,", "[background-position:50px_0,", "[background-repeat:no-repeat]"} {
		if !strings.Contains(cls, want) {
			t.Errorf("classes lack %q:\n%s", want, cls)
		}
	}
	if single := className([]Prop{{"background-image", "linear-gradient(90deg,#f00 0%,#00f 100%)"}}); !strings.HasPrefix(single, "bg-[") {
		t.Errorf("single gradient: %s", single)
	}
}
