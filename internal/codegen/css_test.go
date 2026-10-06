package codegen

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func col(r, g, b, a float32) *opendesignerv1.Color {
	return &opendesignerv1.Color{R: r, G: g, B: b, A: a}
}

func grad(x1, y1, x2, y2 float64, stops ...*opendesignerv1.GradientStop) *opendesignerv1.GradientPaint {
	return &opendesignerv1.GradientPaint{X1: x1, Y1: y1, X2: x2, Y2: y2, Stops: stops}
}

func stop(pos float64, c *opendesignerv1.Color) *opendesignerv1.GradientStop {
	return &opendesignerv1.GradientStop{Position: pos, Color: c}
}

func TestNumAndPx(t *testing.T) {
	for _, c := range []struct {
		in      float64
		num, px string
	}{
		{0, "0", "0"},
		{-0.0001, "0", "0"},
		{12, "12", "12px"},
		{1.23456, "1.235", "1.235px"},
		{-20.5, "-20.5", "-20.5px"},
		{0.1 + 0.2, "0.3", "0.3px"},
	} {
		if got := num(c.in); got != c.num {
			t.Errorf("num(%v) = %q, want %q", c.in, got, c.num)
		}
		if got := px(c.in); got != c.px {
			t.Errorf("px(%v) = %q, want %q", c.in, got, c.px)
		}
	}
}

func TestColorCSS(t *testing.T) {
	for _, c := range []struct {
		name string
		in   *opendesignerv1.Color
		mul  float64
		want string
	}{
		{"black", col(0, 0, 0, 1), 1, "#000"},
		{"white", col(1, 1, 1, 1), 1, "#fff"},
		{"canvas red", col(0.9, 0.3, 0.3, 1), 1, "#e54d4d"},
		{"alpha", col(0, 0, 0, 0.5), 1, "rgba(0,0,0,0.5)"},
		{"opacity baked into the alpha", col(1, 0, 0, 1), 0.4, "rgba(255,0,0,0.4)"},
		{"out of range", col(2, -1, 0.5, 1), 1, "#ff0080"},
	} {
		if got := colorCSS(c.in, c.mul); got != c.want {
			t.Errorf("%s: colorCSS = %q, want %q", c.name, got, c.want)
		}
	}
}

// Gradient geometry: the CSS angle and the percentages are derived from the
// axis in normalised coordinates, on the box in px.
func TestGradientCSS(t *testing.T) {
	a, b := col(1, 0, 0, 1), col(0, 0, 1, 1)
	for _, c := range []struct {
		name   string
		g      *opendesignerv1.GradientPaint
		radial bool
		w, h   float64
		want   string
	}{
		{"diagonal on a square", grad(0, 0, 1, 1, stop(0, a), stop(1, b)), false, 100, 100, "linear-gradient(135deg,#f00 0%,#00f 100%)"},
		{"diagonal on a rectangle", grad(0, 0, 1, 1, stop(0, a), stop(1, b)), false, 200, 100, "linear-gradient(116.565deg,#f00 0%,#00f 100%)"},
		{"horizontal", grad(0, 0.5, 1, 0.5, stop(0, a), stop(1, b)), false, 100, 80, "linear-gradient(90deg,#f00 0%,#00f 100%)"},
		{"vertical downwards", grad(0.5, 0, 0.5, 1, stop(0, a), stop(1, b)), false, 100, 80, "linear-gradient(180deg,#f00 0%,#00f 100%)"},
		{"vertical upwards", grad(0.5, 1, 0.5, 0, stop(0, a), stop(1, b)), false, 100, 80, "linear-gradient(0deg,#f00 0%,#00f 100%)"},
		{"partial axis: it extends outside the axis", grad(0.25, 0.5, 0.75, 0.5, stop(0, a), stop(1, b)), false, 100, 100, "linear-gradient(90deg,#f00 25%,#00f 75%)"},
		{"stops outside 0..1 are clamped", grad(0, 0.5, 1, 0.5, stop(-1, a), stop(2, b)), false, 100, 100, "linear-gradient(90deg,#f00 0%,#00f 100%)"},
		{"radial: radius in px", grad(0.5, 0.5, 1, 0.5, stop(0, a), stop(1, b)), true, 100, 80, "radial-gradient(circle 50px at 50px 40px,#f00 0%,#00f 100%)"},
	} {
		got, ok := gradientCSS(c.g, c.radial, c.w, c.h, 1)
		if !ok || got != c.want {
			t.Errorf("%s:\n got  %q (ok=%v)\n want %q", c.name, got, ok, c.want)
		}
	}
	// Degenerate: the canvas falls back to the flat colour.
	for name, g := range map[string]*opendesignerv1.GradientPaint{
		"single stop": grad(0, 0, 1, 1, stop(0, a)),
		"zero axis":   grad(0.5, 0.5, 0.5, 0.5, stop(0, a), stop(1, b)),
	} {
		if got, ok := gradientCSS(g, false, 100, 100, 1); ok {
			t.Errorf("%s: degenerate gradient, expected ok=false, got %q", name, got)
		}
	}
}

// The canvas interpolates non-premultiplied: a segment with different alphas is
// split into already-interpolated points.
func TestGradientAlphaSubdivision(t *testing.T) {
	g := grad(0, 0, 1, 0, stop(0, col(1, 1, 0, 1)), stop(1, col(0.9, 0.1, 0.5, 0)))
	got, ok := gradientCSS(g, true, 100, 100, 1)
	if !ok {
		t.Fatal("invalid gradient")
	}
	if n := strings.Count(got, "%"); n != 2+alphaSubdivisions-1 {
		t.Errorf("points = %d, want %d: %s", n, 2+alphaSubdivisions-1, got)
	}
	// Equal alphas: no subdivision.
	g = grad(0, 0, 1, 0, stop(0, col(1, 1, 0, 1)), stop(1, col(0, 0, 0, 1)))
	got, _ = gradientCSS(g, true, 100, 100, 1)
	if n := strings.Count(got, "%"); n != 2 {
		t.Errorf("points = %d, want 2: %s", n, got)
	}
}

func TestStrokeRings(t *testing.T) {
	solid := func(c *opendesignerv1.Color) *opendesignerv1.Paint {
		return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: c}}}
	}
	st := func(w float64, a opendesignerv1.StrokeAlign, c *opendesignerv1.Color) *opendesignerv1.Stroke {
		return &opendesignerv1.Stroke{Paint: solid(c), Weight: w, Align: a}
	}
	k := col(0, 0, 0, 1)
	red := col(1, 0, 0, 1)
	for _, c := range []struct {
		name    string
		strokes []*opendesignerv1.Stroke
		want    string
	}{
		{"inside", []*opendesignerv1.Stroke{st(4, opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE, k)}, "inset 0 0 0 4px #000"},
		{"outside", []*opendesignerv1.Stroke{st(4, opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE, k)}, "0 0 0 4px #000"},
		{"center: two half-width rings", []*opendesignerv1.Stroke{st(8, opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER, k)}, "0 0 0 4px #000|inset 0 0 0 4px #000"},
		{"unspecified = center", []*opendesignerv1.Stroke{st(2, opendesignerv1.StrokeAlign_STROKE_ALIGN_UNSPECIFIED, k)}, "0 0 0 1px #000|inset 0 0 0 1px #000"},
		{"the last stroke is on top, so it goes first", []*opendesignerv1.Stroke{
			st(6, opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE, k), st(4, opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE, red),
		}, "0 0 0 4px #f00|inset 0 0 0 6px #000"},
		{"zero weight is not a stroke", []*opendesignerv1.Stroke{st(0, opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE, k)}, ""},
	} {
		if got := strings.Join(strokeRings(c.strokes, 1), "|"); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestFontFamilyCSS(t *testing.T) {
	for in, want := range map[string]string{
		"":                      "Inter, sans-serif",
		"Roboto":                "Roboto, sans-serif",
		"Open Sans":             "Open Sans, sans-serif",
		"Georgia":               "Georgia, serif",
		"JetBrains Mono":        "JetBrains Mono, monospace",
		"Helvetica Neue, Arial": "Helvetica Neue, Arial, sans-serif",
		"Inter, sans-serif":     "Inter, sans-serif",
		`"Playfair Display"`:    "Playfair Display, serif",
		"Weird.Font":            "'Weird.Font', sans-serif",
		"Inter, system-ui":      "Inter, system-ui",
	} {
		if got := fontFamilyCSS(in); got != want {
			t.Errorf("fontFamilyCSS(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNames(t *testing.T) {
	for in, want := range map[string]string{
		"Login screen": "LoginScreen", "Café & Crème": "CafeCreme", "12 steps": "Screen12Steps", "": "Screen", "---": "Screen",
		"empty-cart": "EmptyCart",
	} {
		if got := pascal(in); got != want {
			t.Errorf("pascal(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"Login screen": "login-screen", "Café": "cafe", "": "screen"} {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
	used := map[string]bool{}
	got := []string{dedupe(used, "Home", ""), dedupe(used, "Home", ""), dedupe(used, "Home", "")}
	if strings.Join(got, ",") != "Home,Home2,Home3" {
		t.Errorf("dedupe = %v", got)
	}
}
