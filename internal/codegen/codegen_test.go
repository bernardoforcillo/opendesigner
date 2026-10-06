package codegen_test

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
	"google.golang.org/protobuf/proto"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata/")

// checkGolden compares `got` with testdata/<name>; with -update it rewrites it.
func checkGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from the golden (run with -update and review the diff):\n--- got ---\n%s", path, got)
	}
}

func file(t *testing.T, out *codegen.Output, path string) []byte {
	t.Helper()
	for _, f := range out.Files {
		if f.Path == path {
			return f.Content
		}
	}
	var have []string
	for _, f := range out.Files {
		have = append(have, f.Path)
	}
	t.Fatalf("file %q not generated; have: %v", path, have)
	return nil
}

func gen(t *testing.T, doc *opendesignerv1.Document, target codegen.Target, assets codegen.AssetSource) *codegen.Output {
	t.Helper()
	out, err := codegen.Generate(doc, codegen.Options{Target: target}, assets)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// screenDoc: a document with ONE white 400x300 screen and the content that
// `fill` puts in it. The golden is the screen's HTML file: the IR, the CSS and
// the element tree in one go.
func screenDoc(fill func(b *B, s string), frame ...Opt) *opendesignerv1.Document {
	b := New("doc", "Test")
	opts := append([]Opt{Frame(false, nil), Fill(Solid(C(1, 1, 1)))}, frame...)
	b.Add("scr", "page1", "Screen", 0, 0, 400, 300, opts...)
	fill(b, "scr")
	return b.Doc
}

func TestGoldenHTML(t *testing.T) {
	red, blue, green, grey := C(0.9, 0.3, 0.3), C(0.2, 0.4, 0.9), C(0.3, 0.7, 0.4), C(0.9, 0.9, 0.9)
	png := []byte("\x89PNG\r\n\x1a\nrestofile")
	cases := []struct {
		name   string
		doc    *opendesignerv1.Document
		assets codegen.AssetSource
	}{
		{"auto_layout", screenDoc(func(b *B, s string) {
			b.Add("h", s, "Row", 10, 10, 300, 80, Frame(false, Layout(false, 10, 12, 12, 12, 12, AStart, AStart, false, false)), Fill(Solid(grey)))
			b.Add("h1", "h", "a", 0, 0, 50, 30, Fill(Solid(red)))
			b.Add("h2", "h", "b", 0, 0, 70, 50, Fill(Solid(green)))
			b.Add("hx", "h", "hidden", 0, 0, 70, 50, Hidden())
			b.Add("hg", "h", "group", 5, 5, 0, 0, Group())
			b.Add("hgr", "hg", "inside", 0, 0, 10, 10, Fill(Solid(blue)))
			b.Add("v", s, "Hug column", 10, 100, 100, 100, Frame(false, Layout(true, 8, 16, 8, 16, 8, ACenter, ACenter, true, true)), Fill(Solid(grey)))
			b.Add("v1", "v", "c", 0, 0, 60, 24, Fill(Solid(red)))
			b.Add("v2", "v", "d", 0, 0, 90, 24, Fill(Solid(blue)))
			b.Add("bt", s, "Between", 10, 220, 300, 60, Frame(false, Layout(false, 4, 10, 6, 10, 6, ABetween, AEnd, false, false)), Fill(Solid(grey)))
			b.Add("bt1", "bt", "e", 0, 0, 40, 30, Fill(Solid(red)))
			b.Add("bt2", "bt", "f", 0, 0, 40, 20, Fill(Solid(blue)))
			b.Add("tx", "bt", "in-flow text", 0, 0, 100, 19, Fill(Solid(C(0, 0, 0))), Text("Hello", 16, "", AlignLeft))
		}), nil},
		{"absolute", screenDoc(func(b *B, s string) {
			b.Add("a", s, "Top", 10, 20, 100, 50, Fill(Solid(red)))
			b.Add("f", s, "Frame", 150, 20, 200, 120, Frame(false, nil), Fill(Solid(grey)))
			b.Add("fk", "f", "child", -10, 30, 80, 40, Fill(Solid(blue)))
			b.Add("neg", s, "negative", -5, 200, 40, 40, Fill(Solid(green)))
		}), nil},
		{"clip", screenDoc(func(b *B, s string) {
			b.Add("c", s, "Clip", 20, 20, 140, 100, Frame(true, nil), Fill(Solid(grey)))
			b.Add("ck", "c", "overflows", 90, 50, 120, 90, Fill(Solid(red)))
			b.Add("nc", s, "No clip", 200, 20, 140, 100, Frame(false, nil), Fill())
			b.Add("nck", "nc", "overflows", 90, 50, 120, 90, Fill(Solid(blue)))
		}), nil},
		{"rotation", screenDoc(func(b *B, s string) {
			b.Add("r", s, "rotated", 20, 20, 120, 50, Fill(Solid(C(0.2, 0.2, 0.2))), Rot(30))
			b.Add("rn", s, "counter-clockwise", 200, 20, 120, 50, Fill(Solid(red)), Rot(-15.5))
			b.Add("rf", s, "frame", 20, 150, 130, 90, Frame(true, nil), Fill(Solid(grey)), Rot(15))
			b.Add("rfk", "rf", "child", 60, 30, 120, 80, Fill(Solid(blue)))
			b.Add("rg", s, "group", 300, 200, 0, 0, Group(), Rot(30))
			b.Add("rgk", "rg", "inside", 0, 0, 40, 20, Fill(Solid(green)))
			b.Add("r360", s, "full turn", 200, 150, 40, 40, Fill(Solid(red)), Rot(360))
		}), nil},
		{"gradients", screenDoc(func(b *B, s string) {
			b.Add("l", s, "linear", 10, 10, 100, 80, Fill(Linear(0, 0, 1, 1, S(0, C(1, 0.2, 0.2)), S(1, C(0.2, 0.2, 1)))))
			b.Add("r", s, "radial", 130, 10, 100, 80, Ellipse(), Fill(Radial(0.5, 0.5, 1, 0.5, S(0, C(1, 1, 0.2)), S(1, CA(0.9, 0.1, 0.5, 0)))))
			b.Add("p", s, "partial", 250, 10, 100, 80, Fill(Linear(0.25, 0.5, 0.75, 0.5, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
			b.Add("d", s, "degenerate", 10, 110, 100, 80, Fill(Linear(0.5, 0.5, 0.5, 0.5, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
			b.Add("t", s, "text", 130, 110, 200, 40, Fill(Linear(0, 0, 1, 0, S(0, C(0.9, 0.1, 0.1)), S(1, C(0.1, 0.1, 0.9)))), Text("Gradient", 26, "700", AlignLeft))
		}), nil},
		{"strokes", screenDoc(func(b *B, s string) {
			b.Add("c", s, "center", 10, 10, 100, 80, Fill(Solid(grey)), StrokeOpt(8, Center, Solid(C(0, 0, 0))))
			b.Add("i", s, "inside", 130, 10, 100, 80, Rect(14), Fill(Solid(grey)), StrokeOpt(10, Inside, Solid(red)))
			b.Add("o", s, "outside", 250, 10, 100, 80, Ellipse(), Fill(Solid(grey)), StrokeOpt(10, Outside, Solid(green)))
			b.Add("d", s, "two", 10, 110, 100, 80, Fill(Solid(grey)), StrokeOpt(6, Inside, Solid(red)), StrokeOpt(4, Outside, Solid(blue)))
			b.Add("z", s, "zero weight", 130, 110, 100, 80, Fill(Solid(grey)), StrokeOpt(0, Center, Solid(C(0, 0, 0))))
			b.Add("n", s, "no fill", 250, 110, 100, 80, Fill(), StrokeOpt(3, Center, Solid(C(0, 0, 0))))
			b.Add("t", s, "text", 10, 220, 200, 40, Fill(Solid(C(0, 0, 0))), Text("With stroke", 24, "700", AlignLeft), StrokeOpt(1, Center, Solid(C(1, 0.5, 0))))
		}), nil},
		{"effects", screenDoc(func(b *B, s string) {
			b.Add("s", s, "shadow", 10, 10, 100, 80, Fill(Solid(C(1, 1, 1))), Shadow(CA(0, 0, 0, 0.5), 6, 10, 16))
			b.Add("b", s, "blur", 130, 10, 100, 80, Fill(Solid(red)), Blur(6))
			b.Add("sb", s, "shadow and blur", 250, 10, 100, 80, Ellipse(), Fill(Solid(blue)), Shadow(CA(0, 0, 0, 0.6), 8, 8, 6), Blur(1.5))
			b.Add("tr", s, "translucent with shadow", 10, 120, 100, 80, Fill(Solid(green)), Opacity(0.5), Shadow(CA(0, 0, 0, 0.8), 5, 5, 0))
			b.Add("two", s, "two shadows", 130, 120, 100, 80, Fill(Solid(C(1, 1, 1))), Shadow(CA(1, 0, 0, 0.5), 8, 8, 4), Shadow(CA(0, 0, 1, 0.5), -8, -8, 4))
			b.Add("cf", s, "opaque frame", 250, 120, 100, 80, Frame(false, nil), Fill(Solid(C(0.1, 0.1, 0.5))), Opacity(0.4))
			b.Add("cfk", "cf", "child", 20, 20, 50, 30, Fill(Solid(C(0.9, 0.7, 0.1))))
			b.Add("tt", s, "text", 10, 230, 200, 40, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Shadow", 30, "700", AlignLeft), Shadow(CA(0, 0, 0, 0.4), 3, 3, 4))
		}), nil},
		{"text", screenDoc(func(b *B, s string) {
			b.Add("a", s, "wrapping", 10, 10, 240, 80, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Hello, design world. This line wraps inside its box.", 16, "", AlignLeft))
			b.Add("b", s, "bold centered", 10, 100, 220, 40, Fill(Solid(C(0.8, 0.1, 0.3))), Text("Bold centered", 22, "700", AlignCenter))
			b.Add("c", s, "right-aligned", 10, 150, 220, 40, Fill(Solid(C(0.1, 0.4, 0.8))), Text("Right 24px", 24, "", AlignRight))
			b.Add("d", s, "full style", 10, 200, 260, 60, Fill(Solid(C(0.2, 0.2, 0.2))), TextStyled("Line height 1.6\nwith two lines", &opendesignerv1.TextStyle{FontFamily: "Georgia", FontSize: 13, LineHeight: 1.6, FontWeight: "500"}))
			b.Add("e", s, "no width", 10, 270, 0, 0, Fill(Solid(C(0, 0, 0))), Text("A line with no wrap", 14, "", AlignLeft))
			b.Add("f", s, "no fill", 200, 270, 150, 20, Fill(), Text("Default grey", 14, "", AlignLeft))
			b.Add("g", s, "empty", 300, 10, 80, 20, Text("", 14, "", AlignLeft))
			b.Add("h", s, "special", 250, 150, 140, 40, Fill(Solid(C(0, 0, 0))), Text("a < b & c > \"d\"", 14, "", AlignLeft))
		}), nil},
		{"ellipse", screenDoc(func(b *B, s string) {
			b.Add("e", s, "ellipse", 10, 10, 160, 80, Ellipse(), Fill(Solid(red)))
			b.Add("c", s, "circle", 200, 10, 80, 80, Ellipse(), Fill(Solid(blue)), StrokeOpt(4, Outside, Solid(C(0, 0, 0))))
			b.Add("r", s, "large radius", 10, 110, 100, 80, Rect(100), Fill(Solid(green)))
		}), nil},
		{"image_present", screenDoc(func(b *B, s string) {
			b.Add("i", s, "photo", 10, 10, 120, 90, Image("abc123"))
			b.Add("ir", s, "rotated", 160, 10, 100, 70, Image("abc123"), Rot(20), Opacity(0.5), Shadow(CA(0, 0, 0, 0.5), 5, 6, 8))
		}), codegen.FuncAssets(func(h string) ([]byte, error) { return png, nil })},
		{"image_missing", screenDoc(func(b *B, s string) {
			b.Add("i", s, "photo", 10, 10, 120, 90, Image("missing"), Fill())
		}), nil},
		{"vector", screenDoc(func(b *B, s string) {
			b.Add("o", s, "open", 10, 10, 100, 60, Vector(Sub(false, Pt(0, 50, 0, 0, 20, -60), Pt(50, 0, -20, 0, 20, 0), Pt(100, 50, -20, -60, 0, 0))), Fill(Solid(C(0.8, 0.1, 0.1))))
			b.Add("h", s, "hole", 140, 10, 90, 90, Vector(
				Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(90, 0, 0, 0, 0, 0), Pt(90, 90, 0, 0, 0, 0), Pt(0, 90, 0, 0, 0, 0)),
				Sub(true, Pt(25, 25, 0, 0, 0, 0), Pt(65, 25, 0, 0, 0, 0), Pt(65, 65, 0, 0, 0, 0), Pt(25, 65, 0, 0, 0, 0))), Fill(Solid(blue)))
			b.Add("p", s, "dot", 260, 20, 0, 0, Vector(Sub(false, Pt(0, 0, 0, 0, 0, 0))), Fill(Solid(C(0, 0, 0))))
			b.Add("g", s, "gradient", 10, 120, 100, 100, Vector(Sub(true, Pt(50, 0, -30, 0, 30, 0), Pt(100, 50, 0, -30, 0, 30), Pt(50, 100, 30, 0, -30, 0), Pt(0, 50, 0, 30, 0, -30))),
				Fill(Linear(0, 0, 1, 1, S(0, C(1, 0.5, 0)), S(1, C(0.6, 0.1, 0.8)))), Opacity(0.5), Shadow(CA(0, 0, 0, 0.5), 4, 6, 8))
			b.Add("e", s, "empty", 200, 150, 10, 10, Vector())
		}), nil},
		{"instance", func() *opendesignerv1.Document {
			doc := screenDoc(func(b *B, s string) {
				b.Add("m", "page1", "Card", 5000, 0, 140, 90, Frame(true, nil), Fill(Solid(C(0.9, 0.9, 0.95))))
				b.Add("ml", "m", "label", 10, 10, 60, 30, Rect(6), Fill(Solid(C(0.3, 0.3, 0.7))))
				b.Add("mt", "m", "title", 10, 52, 120, 24, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Title", 16, "600", AlignLeft))
				b.Component("c1", "m", "Card")
				b.Add("i1", s, "instance", 10, 10, 140, 90, Instance("c1"))
				b.Add("i2", s, "with override", 170, 10, 140, 90, Instance("c1", OverrideFill("ml", Solid(C(0.9, 0.4, 0.1))), OverrideText("mt", "Other")))
				b.Add("i3", s, "rotated", 10, 130, 140, 90, Instance("c1"), Rot(12))
			})
			return doc
		}(), nil},
		{"hidden", screenDoc(func(b *B, s string) {
			b.Add("v", s, "visible", 10, 10, 50, 50, Fill(Solid(red)))
			b.Add("h", s, "hidden", 70, 10, 50, 50, Fill(Solid(blue)), Hidden())
			b.Add("hf", s, "hidden frame", 130, 10, 80, 80, Frame(false, nil), Fill(Solid(grey)), Hidden())
			b.Add("hfk", "hf", "child", 5, 5, 20, 20, Fill(Solid(green)))
		}), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := gen(t, c.doc, codegen.TargetHTML, c.assets)
			checkGolden(t, c.name+".html", file(t, out, "screen.html"))
		})
	}
}

// The same documents in React: Tailwind classes from the same IR. A single
// golden for the richest cases (the other classes are covered by tailwind_test.go).
func TestGoldenReactScreen(t *testing.T) {
	doc := screenDoc(func(b *B, s string) {
		b.Add("h", s, "Row", 10, 10, 300, 80, Frame(false, Layout(false, 10, 12, 12, 12, 12, AStart, AStart, false, false)), Fill(Solid(C(0.9, 0.9, 0.9))), StrokeOpt(2, Inside, Solid(C(0, 0, 0))))
		b.Add("h1", "h", "a", 0, 0, 50, 30, Rect(8), Fill(Solid(C(0.9, 0.3, 0.3))), Rot(10))
		b.Add("t", s, "title", 10, 120, 200, 30, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Hello \"world\"\non two lines", 18, "700", AlignCenter))
		b.Add("v", s, "vector", 10, 170, 100, 60, Vector(Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(100, 0, 0, 0, 0, 0), Pt(50, 60, 0, 0, 0, 0))), Fill(Linear(0, 0, 1, 0, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
	})
	out := gen(t, doc, codegen.TargetReact, nil)
	checkGolden(t, "react_screen.tsx", file(t, out, "src/screens/Screen.tsx"))
}

// Wired flows: the screens, the App and the tests of the React project
// generated from a single document. It is the contract between the renderer
// (data-testid, roles, labels) and the internal/flow tests.
func TestGoldenFlowWiring(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	for _, p := range []string{
		"src/App.tsx", "src/screens/Login.tsx", "src/screens/Home.tsx", "src/screens/Detail.tsx",
		"tests/flows.spec.ts", "package.json", "README.md",
	} {
		checkGolden(t, "shop/"+p, file(t, out, p))
	}
	hout := gen(t, Shop(), codegen.TargetHTML, nil)
	for _, p := range []string{"index.html", "home.html", "detail.html"} {
		checkGolden(t, "shop-html/"+p, file(t, hout, p))
	}
}

// The wiring spelled out: every way a test finds the trigger really exists in
// the generated DOM.
func TestFlowWiringContract(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	login := string(file(t, out, "src/screens/Login.tsx"))
	home := string(file(t, out, "src/screens/Home.tsx"))
	detail := string(file(t, out, "src/screens/Detail.tsx"))
	spec := string(file(t, out, "tests/flows.spec.ts"))

	// t1: test.id -> data-testid + onClick to the destination route.
	for _, want := range []string{`data-testid="login-submit"`, `onClick={() => navigate("/home")}`, `role="button"`, `aria-label="Sign in"`, "cursor-pointer", "// flow: t1", "// guard: valid credentials", "// effect: active session"} {
		if !strings.Contains(login, want) {
			t.Errorf("Login.tsx: missing %q", want)
		}
	}
	if !strings.Contains(spec, `page.getByTestId("login-submit")`) {
		t.Error("the tests do not look for t1's data-testid")
	}
	// t2: test.text -> the text is in the screen's DOM.
	if !strings.Contains(home, `{"Wireless headphones"}`) || !strings.Contains(spec, `page.getByText("Wireless headphones")`) {
		t.Error("t2: the trigger's text is not in the DOM or in the tests")
	}
	// t4: label only -> button role with aria-label.
	if !strings.Contains(detail, `aria-label="Back"`) || !strings.Contains(spec, `getByRole('button', { name: "Back" })`) {
		t.Error("t4: button role with name not wired")
	}
	// t3: no element -> button in the hidden <nav>.
	if !strings.Contains(home, "<nav ") || !strings.Contains(home, `>Sign out</button>`) || !strings.Contains(home, `navigate("/login")`) || !strings.Contains(home, "flow: t3") {
		t.Errorf("t3: missing the button in the hidden nav:\n%s", home)
	}
	// The start screen is also on "/".
	if app := string(file(t, out, "src/App.tsx")); !strings.Contains(app, `<Route path="/" element={<Login />} />`) {
		t.Errorf("App.tsx without the / route:\n%s", app)
	}
	// The routes missing from the document were completed for the tests.
	if !strings.Contains(spec, `page.goto("/login")`) {
		t.Error("the tests do not start from the start screen's route")
	}
	if strings.Contains(spec, "test.fixme") {
		t.Error("no test should be fixme: the generator completes the routes")
	}
}

func TestDeterministic(t *testing.T) {
	gallery, assets := Gallery()
	src := codegen.FuncAssets(func(h string) ([]byte, error) {
		if b, ok := assets[h]; ok {
			return b, nil
		}
		return nil, os.ErrNotExist
	})
	for _, target := range []codegen.Target{codegen.TargetHTML, codegen.TargetReact} {
		first := gen(t, gallery, target, src)
		for i := 0; i < 3; i++ {
			again := gen(t, gallery, target, src)
			if len(again.Files) != len(first.Files) {
				t.Fatalf("%s: different number of files", target)
			}
			for j := range first.Files {
				if first.Files[j].Path != again.Files[j].Path || !bytes.Equal(first.Files[j].Content, again.Files[j].Content) {
					t.Fatalf("%s: %s is not deterministic", target, first.Files[j].Path)
				}
			}
		}
		for i := 1; i < len(first.Files); i++ {
			if first.Files[i-1].Path >= first.Files[i].Path {
				t.Errorf("%s: files not sorted: %s, %s", target, first.Files[i-1].Path, first.Files[i].Path)
			}
		}
	}
}

func TestDoesNotMutateDocument(t *testing.T) {
	doc := Shop()
	before := proto.Clone(doc)
	gen(t, doc, codegen.TargetReact, nil)
	if !proto.Equal(before, doc) {
		t.Error("Generate modified the document (default routes must be written on a copy)")
	}
}

func TestAssetsCopied(t *testing.T) {
	doc, assets := Gallery()
	src := codegen.FuncAssets(func(h string) ([]byte, error) {
		if b, ok := assets[h]; ok {
			return b, nil
		}
		return nil, os.ErrNotExist
	})
	var hash string
	for h := range assets {
		hash = h
	}
	out := gen(t, doc, codegen.TargetReact, src)
	if got := file(t, out, "public/assets/"+hash+".png"); !bytes.Equal(got, assets[hash]) {
		t.Error("asset copied with different bytes")
	}
	if !strings.Contains(string(file(t, out, "src/screens/Images.tsx")), `src="/assets/`+hash+`.png"`) {
		t.Error("the <img> does not point to the copied asset")
	}
	// A missing asset gives a placeholder and a warning, not an error.
	found := false
	for _, w := range out.Warnings {
		if strings.Contains(w, "000000000000") {
			found = true
		}
	}
	if !found {
		t.Errorf("missing warning about the missing asset: %v", out.Warnings)
	}
	hout := gen(t, doc, codegen.TargetHTML, src)
	if !strings.Contains(string(file(t, hout, "images.html")), `src="assets/`+hash+`.png"`) {
		t.Error("html: the <img> does not point to the copied asset")
	}
}

func TestOptionsAndErrors(t *testing.T) {
	if _, err := codegen.Generate(Shop(), codegen.Options{Target: "vue"}, nil); err == nil {
		t.Error("unknown target accepted")
	}
	if _, err := codegen.Generate(Shop(), codegen.Options{FlowID: "nope"}, nil); err == nil {
		t.Error("unknown flow accepted")
	}
	empty := screenDoc(func(b *B, s string) {})
	empty.Nodes = nil
	if _, err := codegen.Generate(empty, codegen.Options{}, nil); err == nil {
		t.Error("document without screens accepted")
	}
	if _, err := codegen.Generate(nil, codegen.Options{}, nil); err == nil {
		t.Error("nil document accepted")
	}
	// The default target is react.
	out, err := codegen.Generate(Shop(), codegen.Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	file(t, out, "package.json")
	// A single flow: the tests and the wiring are those of the flow.
	out, err = codegen.Generate(Shop(), codegen.Options{FlowID: "f_purchase"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(file(t, out, "tests/flows.spec.ts")), "Flow: Purchase") {
		t.Error("tests of the chosen flow missing")
	}
}

func TestNamesDedupAndCodeMeta(t *testing.T) {
	b := New("d", "Dup")
	for i, n := range []string{"Home", "Home", "home page"} {
		id := string(rune('a' + i))
		b.Add(id, "page1", n, float64(i)*500, 0, 100, 100, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	}
	b.Add("app", "page1", "App", 2000, 0, 100, 100, Frame(false, nil), Fill(Solid(C(1, 1, 1))), Meta("code.component", "UserProfile", "code.route", "user/:id"))
	out := gen(t, b.Doc, codegen.TargetReact, nil)
	for _, p := range []string{"src/screens/Home.tsx", "src/screens/Home2.tsx", "src/screens/HomePage.tsx", "src/screens/UserProfile.tsx"} {
		file(t, out, p)
	}
	app := string(file(t, out, "src/App.tsx"))
	if !strings.Contains(app, `path="/user/:id"`) || !strings.Contains(app, `path="/home-2"`) {
		t.Errorf("routes: %s", app)
	}
}

func TestWriteFiles(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetHTML, nil)
	dir := t.TempDir()
	written, err := codegen.WriteFiles(out, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != len(out.Files) {
		t.Errorf("wrote %d files out of %d", len(written), len(out.Files))
	}
	if _, err := codegen.WriteFiles(out, dir, false); err == nil {
		t.Error("a non-empty directory must be rejected without force")
	}
	if _, err := codegen.WriteFiles(out, dir, true); err != nil {
		t.Errorf("must succeed with force: %v", err)
	}
	if _, err := codegen.WriteFiles(&codegen.Output{Files: []codegen.File{{Path: "../outside.txt"}}}, t.TempDir(), false); err == nil {
		t.Error("path outside the directory accepted")
	}
}

// Wiring edge cases: a test.id in the master is not duplicated in the
// instances, "Index" does not collide with the index, a key without a label is
// reported and the key/back triggers become a listener and navigate(-1).
func TestWiringEdgeCases(t *testing.T) {
	b := New("d", "Edges")
	b.Add("m", "page1", "Master", 5000, 0, 50, 50, Frame(false, nil), Fill(Solid(C(1, 0, 0))), Meta("test.id", "from-master"))
	b.Component("c", "m", "M")
	b.Add("index", "page1", "Index", 0, 0, 200, 200, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("i", "index", "instance", 10, 10, 50, 50, Instance("c"))
	b.Add("other", "page1", "Other", 500, 0, 200, 200, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Flow("f", "F", "index")
	b.Transition(&opendesignerv1.Transition{Id: "k1", FlowId: "f", FromId: "index", ToId: "other", Trigger: "key", Label: "Enter"})
	b.Transition(&opendesignerv1.Transition{Id: "k2", FlowId: "f", FromId: "index", ToId: "other", Trigger: "key"})
	b.Transition(&opendesignerv1.Transition{Id: "b1", FlowId: "f", FromId: "other", ToId: "index", Trigger: "back", Label: "Back"})
	out := gen(t, b.Doc, codegen.TargetReact, nil)

	screen := string(file(t, out, "src/screens/Index.tsx"))
	if strings.Contains(screen, "from-master") {
		t.Error("the master's test.id appears in the instance")
	}
	if !strings.Contains(screen, `if (e.key === "Enter") navigate("/other")`) || strings.Contains(screen, `e.key === ""`) {
		t.Errorf("key listener:\n%s", screen)
	}
	if !strings.Contains(string(file(t, out, "src/screens/Other.tsx")), "navigate(-1)") {
		t.Error("the back trigger does not call navigate(-1)")
	}
	found := false
	for _, w := range out.Warnings {
		found = found || strings.Contains(w, "k2")
	}
	if !found {
		t.Errorf("missing warning about the key without a label: %v", out.Warnings)
	}
	hout := gen(t, b.Doc, codegen.TargetHTML, nil)
	if !strings.Contains(string(file(t, hout, "index.html")), `data-node-id="index"`) {
		t.Error("index.html is not the start screen")
	}
}

// The loop closes: `flow coverage` on the exported project sees the screens
// as implemented (the exported ones are the implementation) and the transitions
// as tested (the generated tests annotate them with `// flow:<id>`).
func TestCoverageAfterExport(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	dir := t.TempDir()
	if _, err := codegen.WriteFiles(out, dir, false); err != nil {
		t.Fatal(err)
	}
	// The routes go in the meta: the default ones were computed by the export, here
	// they are written as someone who decided them in the editor would do.
	doc := Shop()
	for id, route := range map[string]string{"login": "/login", "home": "/home", "detail": "/detail"} {
		doc.Nodes[id].Meta = map[string]string{"code.route": route}
	}
	rep, err := flow.Coverage(doc, "", dir)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Totals.ScreensImplemented != 3 || rep.Totals.TransitionsTested != 4 {
		t.Errorf("coverage = %+v, want 3 screens implemented and 4 transitions tested", rep.Totals)
	}
}
