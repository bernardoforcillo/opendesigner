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

var update = flag.Bool("update", false, "riscrive i golden file in testdata/")

// checkGolden confronta `got` con testdata/<name>; con -update lo riscrive.
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
		t.Fatalf("manca il golden %s (eseguire con -update): %v", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differisce dal golden (eseguire con -update e rivedere il diff):\n--- ottenuto ---\n%s", path, got)
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
	t.Fatalf("file %q non generato; ho: %v", path, have)
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

// screenDoc: un documento con UNA schermata 400x300 bianca e il contenuto che
// `fill` vi mette. Il golden è il file HTML della schermata: l'IR, il CSS e
// l'albero degli elementi in un colpo solo.
func screenDoc(fill func(b *B, s string), frame ...Opt) *opendesignerv1.Document {
	b := New("doc", "Prova")
	opts := append([]Opt{Frame(false, nil), Fill(Solid(C(1, 1, 1)))}, frame...)
	b.Add("scr", "page1", "Schermata", 0, 0, 400, 300, opts...)
	fill(b, "scr")
	return b.Doc
}

func TestGoldenHTML(t *testing.T) {
	red, blue, green, grey := C(0.9, 0.3, 0.3), C(0.2, 0.4, 0.9), C(0.3, 0.7, 0.4), C(0.9, 0.9, 0.9)
	png := []byte("\x89PNG\r\n\x1a\nrestodelfile")
	cases := []struct {
		name   string
		doc    *opendesignerv1.Document
		assets codegen.AssetSource
	}{
		{"auto_layout", screenDoc(func(b *B, s string) {
			b.Add("h", s, "Riga", 10, 10, 300, 80, Frame(false, Layout(false, 10, 12, 12, 12, 12, AStart, AStart, false, false)), Fill(Solid(grey)))
			b.Add("h1", "h", "a", 0, 0, 50, 30, Fill(Solid(red)))
			b.Add("h2", "h", "b", 0, 0, 70, 50, Fill(Solid(green)))
			b.Add("hx", "h", "nascosto", 0, 0, 70, 50, Hidden())
			b.Add("hg", "h", "gruppo", 5, 5, 0, 0, Group())
			b.Add("hgr", "hg", "dentro", 0, 0, 10, 10, Fill(Solid(blue)))
			b.Add("v", s, "Colonna hug", 10, 100, 100, 100, Frame(false, Layout(true, 8, 16, 8, 16, 8, ACenter, ACenter, true, true)), Fill(Solid(grey)))
			b.Add("v1", "v", "c", 0, 0, 60, 24, Fill(Solid(red)))
			b.Add("v2", "v", "d", 0, 0, 90, 24, Fill(Solid(blue)))
			b.Add("bt", s, "Tra", 10, 220, 300, 60, Frame(false, Layout(false, 4, 10, 6, 10, 6, ABetween, AEnd, false, false)), Fill(Solid(grey)))
			b.Add("bt1", "bt", "e", 0, 0, 40, 30, Fill(Solid(red)))
			b.Add("bt2", "bt", "f", 0, 0, 40, 20, Fill(Solid(blue)))
			b.Add("tx", "bt", "testo in flusso", 0, 0, 100, 19, Fill(Solid(C(0, 0, 0))), Text("Ciao", 16, "", AlignLeft))
		}), nil},
		{"absolute", screenDoc(func(b *B, s string) {
			b.Add("a", s, "In alto", 10, 20, 100, 50, Fill(Solid(red)))
			b.Add("f", s, "Cornice", 150, 20, 200, 120, Frame(false, nil), Fill(Solid(grey)))
			b.Add("fk", "f", "figlio", -10, 30, 80, 40, Fill(Solid(blue)))
			b.Add("neg", s, "negativo", -5, 200, 40, 40, Fill(Solid(green)))
		}), nil},
		{"clip", screenDoc(func(b *B, s string) {
			b.Add("c", s, "Ritaglio", 20, 20, 140, 100, Frame(true, nil), Fill(Solid(grey)))
			b.Add("ck", "c", "sporge", 90, 50, 120, 90, Fill(Solid(red)))
			b.Add("nc", s, "Senza ritaglio", 200, 20, 140, 100, Frame(false, nil), Fill())
			b.Add("nck", "nc", "sporge", 90, 50, 120, 90, Fill(Solid(blue)))
		}), nil},
		{"rotation", screenDoc(func(b *B, s string) {
			b.Add("r", s, "ruotato", 20, 20, 120, 50, Fill(Solid(C(0.2, 0.2, 0.2))), Rot(30))
			b.Add("rn", s, "antiorario", 200, 20, 120, 50, Fill(Solid(red)), Rot(-15.5))
			b.Add("rf", s, "cornice", 20, 150, 130, 90, Frame(true, nil), Fill(Solid(grey)), Rot(15))
			b.Add("rfk", "rf", "figlio", 60, 30, 120, 80, Fill(Solid(blue)))
			b.Add("rg", s, "gruppo", 300, 200, 0, 0, Group(), Rot(30))
			b.Add("rgk", "rg", "dentro", 0, 0, 40, 20, Fill(Solid(green)))
			b.Add("r360", s, "intero", 200, 150, 40, 40, Fill(Solid(red)), Rot(360))
		}), nil},
		{"gradients", screenDoc(func(b *B, s string) {
			b.Add("l", s, "lineare", 10, 10, 100, 80, Fill(Linear(0, 0, 1, 1, S(0, C(1, 0.2, 0.2)), S(1, C(0.2, 0.2, 1)))))
			b.Add("r", s, "radiale", 130, 10, 100, 80, Ellipse(), Fill(Radial(0.5, 0.5, 1, 0.5, S(0, C(1, 1, 0.2)), S(1, CA(0.9, 0.1, 0.5, 0)))))
			b.Add("p", s, "parziale", 250, 10, 100, 80, Fill(Linear(0.25, 0.5, 0.75, 0.5, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
			b.Add("d", s, "degenere", 10, 110, 100, 80, Fill(Linear(0.5, 0.5, 0.5, 0.5, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
			b.Add("t", s, "testo", 130, 110, 200, 40, Fill(Linear(0, 0, 1, 0, S(0, C(0.9, 0.1, 0.1)), S(1, C(0.1, 0.1, 0.9)))), Text("Sfumato", 26, "700", AlignLeft))
		}), nil},
		{"strokes", screenDoc(func(b *B, s string) {
			b.Add("c", s, "centro", 10, 10, 100, 80, Fill(Solid(grey)), StrokeOpt(8, Center, Solid(C(0, 0, 0))))
			b.Add("i", s, "dentro", 130, 10, 100, 80, Rect(14), Fill(Solid(grey)), StrokeOpt(10, Inside, Solid(red)))
			b.Add("o", s, "fuori", 250, 10, 100, 80, Ellipse(), Fill(Solid(grey)), StrokeOpt(10, Outside, Solid(green)))
			b.Add("d", s, "due", 10, 110, 100, 80, Fill(Solid(grey)), StrokeOpt(6, Inside, Solid(red)), StrokeOpt(4, Outside, Solid(blue)))
			b.Add("z", s, "peso zero", 130, 110, 100, 80, Fill(Solid(grey)), StrokeOpt(0, Center, Solid(C(0, 0, 0))))
			b.Add("n", s, "senza riempimento", 250, 110, 100, 80, Fill(), StrokeOpt(3, Center, Solid(C(0, 0, 0))))
			b.Add("t", s, "testo", 10, 220, 200, 40, Fill(Solid(C(0, 0, 0))), Text("Con tratto", 24, "700", AlignLeft), StrokeOpt(1, Center, Solid(C(1, 0.5, 0))))
		}), nil},
		{"effects", screenDoc(func(b *B, s string) {
			b.Add("s", s, "ombra", 10, 10, 100, 80, Fill(Solid(C(1, 1, 1))), Shadow(CA(0, 0, 0, 0.5), 6, 10, 16))
			b.Add("b", s, "sfocatura", 130, 10, 100, 80, Fill(Solid(red)), Blur(6))
			b.Add("sb", s, "ombra e sfocatura", 250, 10, 100, 80, Ellipse(), Fill(Solid(blue)), Shadow(CA(0, 0, 0, 0.6), 8, 8, 6), Blur(1.5))
			b.Add("tr", s, "traslucido con ombra", 10, 120, 100, 80, Fill(Solid(green)), Opacity(0.5), Shadow(CA(0, 0, 0, 0.8), 5, 5, 0))
			b.Add("two", s, "due ombre", 130, 120, 100, 80, Fill(Solid(C(1, 1, 1))), Shadow(CA(1, 0, 0, 0.5), 8, 8, 4), Shadow(CA(0, 0, 1, 0.5), -8, -8, 4))
			b.Add("cf", s, "cornice opaca", 250, 120, 100, 80, Frame(false, nil), Fill(Solid(C(0.1, 0.1, 0.5))), Opacity(0.4))
			b.Add("cfk", "cf", "figlio", 20, 20, 50, 30, Fill(Solid(C(0.9, 0.7, 0.1))))
			b.Add("tt", s, "testo", 10, 230, 200, 40, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Ombra", 30, "700", AlignLeft), Shadow(CA(0, 0, 0, 0.4), 3, 3, 4))
		}), nil},
		{"text", screenDoc(func(b *B, s string) {
			b.Add("a", s, "a capo", 10, 10, 240, 80, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Hello, design world. This line wraps inside its box.", 16, "", AlignLeft))
			b.Add("b", s, "grassetto centrato", 10, 100, 220, 40, Fill(Solid(C(0.8, 0.1, 0.3))), Text("Bold centered", 22, "700", AlignCenter))
			b.Add("c", s, "a destra", 10, 150, 220, 40, Fill(Solid(C(0.1, 0.4, 0.8))), Text("Right 24px", 24, "", AlignRight))
			b.Add("d", s, "stile pieno", 10, 200, 260, 60, Fill(Solid(C(0.2, 0.2, 0.2))), TextStyled("Interlinea 1.6\ncon due righe", &opendesignerv1.TextStyle{FontFamily: "Georgia", FontSize: 13, LineHeight: 1.6, FontWeight: "500"}))
			b.Add("e", s, "senza larghezza", 10, 270, 0, 0, Fill(Solid(C(0, 0, 0))), Text("Una riga senza wrap", 14, "", AlignLeft))
			b.Add("f", s, "senza fill", 200, 270, 150, 20, Fill(), Text("Grigio di default", 14, "", AlignLeft))
			b.Add("g", s, "vuoto", 300, 10, 80, 20, Text("", 14, "", AlignLeft))
			b.Add("h", s, "speciali", 250, 150, 140, 40, Fill(Solid(C(0, 0, 0))), Text("a < b & c > \"d\"", 14, "", AlignLeft))
		}), nil},
		{"ellipse", screenDoc(func(b *B, s string) {
			b.Add("e", s, "ellisse", 10, 10, 160, 80, Ellipse(), Fill(Solid(red)))
			b.Add("c", s, "cerchio", 200, 10, 80, 80, Ellipse(), Fill(Solid(blue)), StrokeOpt(4, Outside, Solid(C(0, 0, 0))))
			b.Add("r", s, "raggio grande", 10, 110, 100, 80, Rect(100), Fill(Solid(green)))
		}), nil},
		{"image_present", screenDoc(func(b *B, s string) {
			b.Add("i", s, "foto", 10, 10, 120, 90, Image("abc123"))
			b.Add("ir", s, "ruotata", 160, 10, 100, 70, Image("abc123"), Rot(20), Opacity(0.5), Shadow(CA(0, 0, 0, 0.5), 5, 6, 8))
		}), codegen.FuncAssets(func(h string) ([]byte, error) { return png, nil })},
		{"image_missing", screenDoc(func(b *B, s string) {
			b.Add("i", s, "foto", 10, 10, 120, 90, Image("assente"), Fill())
		}), nil},
		{"vector", screenDoc(func(b *B, s string) {
			b.Add("o", s, "aperto", 10, 10, 100, 60, Vector(Sub(false, Pt(0, 50, 0, 0, 20, -60), Pt(50, 0, -20, 0, 20, 0), Pt(100, 50, -20, -60, 0, 0))), Fill(Solid(C(0.8, 0.1, 0.1))))
			b.Add("h", s, "buco", 140, 10, 90, 90, Vector(
				Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(90, 0, 0, 0, 0, 0), Pt(90, 90, 0, 0, 0, 0), Pt(0, 90, 0, 0, 0, 0)),
				Sub(true, Pt(25, 25, 0, 0, 0, 0), Pt(65, 25, 0, 0, 0, 0), Pt(65, 65, 0, 0, 0, 0), Pt(25, 65, 0, 0, 0, 0))), Fill(Solid(blue)))
			b.Add("p", s, "punto", 260, 20, 0, 0, Vector(Sub(false, Pt(0, 0, 0, 0, 0, 0))), Fill(Solid(C(0, 0, 0))))
			b.Add("g", s, "sfumato", 10, 120, 100, 100, Vector(Sub(true, Pt(50, 0, -30, 0, 30, 0), Pt(100, 50, 0, -30, 0, 30), Pt(50, 100, 30, 0, -30, 0), Pt(0, 50, 0, 30, 0, -30))),
				Fill(Linear(0, 0, 1, 1, S(0, C(1, 0.5, 0)), S(1, C(0.6, 0.1, 0.8)))), Opacity(0.5), Shadow(CA(0, 0, 0, 0.5), 4, 6, 8))
			b.Add("e", s, "vuoto", 200, 150, 10, 10, Vector())
		}), nil},
		{"instance", func() *opendesignerv1.Document {
			doc := screenDoc(func(b *B, s string) {
				b.Add("m", "page1", "Card", 5000, 0, 140, 90, Frame(true, nil), Fill(Solid(C(0.9, 0.9, 0.95))))
				b.Add("ml", "m", "etichetta", 10, 10, 60, 30, Rect(6), Fill(Solid(C(0.3, 0.3, 0.7))))
				b.Add("mt", "m", "titolo", 10, 52, 120, 24, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Titolo", 16, "600", AlignLeft))
				b.Component("c1", "m", "Card")
				b.Add("i1", s, "istanza", 10, 10, 140, 90, Instance("c1"))
				b.Add("i2", s, "con override", 170, 10, 140, 90, Instance("c1", OverrideFill("ml", Solid(C(0.9, 0.4, 0.1))), OverrideText("mt", "Altro")))
				b.Add("i3", s, "ruotata", 10, 130, 140, 90, Instance("c1"), Rot(12))
			})
			return doc
		}(), nil},
		{"hidden", screenDoc(func(b *B, s string) {
			b.Add("v", s, "visibile", 10, 10, 50, 50, Fill(Solid(red)))
			b.Add("h", s, "nascosto", 70, 10, 50, 50, Fill(Solid(blue)), Hidden())
			b.Add("hf", s, "cornice nascosta", 130, 10, 80, 80, Frame(false, nil), Fill(Solid(grey)), Hidden())
			b.Add("hfk", "hf", "figlio", 5, 5, 20, 20, Fill(Solid(green)))
		}), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := gen(t, c.doc, codegen.TargetHTML, c.assets)
			checkGolden(t, c.name+".html", file(t, out, "schermata.html"))
		})
	}
}

// Gli stessi documenti in React: classi Tailwind dallo stesso IR. Un golden
// solo per i casi più ricchi (le altre classi sono coperte da tailwind_test.go).
func TestGoldenReactScreen(t *testing.T) {
	doc := screenDoc(func(b *B, s string) {
		b.Add("h", s, "Riga", 10, 10, 300, 80, Frame(false, Layout(false, 10, 12, 12, 12, 12, AStart, AStart, false, false)), Fill(Solid(C(0.9, 0.9, 0.9))), StrokeOpt(2, Inside, Solid(C(0, 0, 0))))
		b.Add("h1", "h", "a", 0, 0, 50, 30, Rect(8), Fill(Solid(C(0.9, 0.3, 0.3))), Rot(10))
		b.Add("t", s, "titolo", 10, 120, 200, 30, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Ciao \"mondo\"\nsu due righe", 18, "700", AlignCenter))
		b.Add("v", s, "vettore", 10, 170, 100, 60, Vector(Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(100, 0, 0, 0, 0, 0), Pt(50, 60, 0, 0, 0, 0))), Fill(Linear(0, 0, 1, 0, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
	})
	out := gen(t, doc, codegen.TargetReact, nil)
	checkGolden(t, "react_screen.tsx", file(t, out, "src/screens/Schermata.tsx"))
}

// Flussi cablati: le schermate, l'App e i test del progetto React generato da
// uno stesso documento. È il contratto fra il renderer (data-testid, ruoli,
// etichette) e i test di internal/flow.
func TestGoldenFlowWiring(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	for _, p := range []string{
		"src/App.tsx", "src/screens/Login.tsx", "src/screens/Home.tsx", "src/screens/Dettaglio.tsx",
		"tests/flows.spec.ts", "package.json", "README.md",
	} {
		checkGolden(t, "shop/"+p, file(t, out, p))
	}
	hout := gen(t, Shop(), codegen.TargetHTML, nil)
	for _, p := range []string{"index.html", "home.html", "dettaglio.html"} {
		checkGolden(t, "shop-html/"+p, file(t, hout, p))
	}
}

// Il cablaggio spiegato a parole: ogni modo in cui un test trova il trigger
// esiste davvero nel DOM generato.
func TestFlowWiringContract(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	login := string(file(t, out, "src/screens/Login.tsx"))
	home := string(file(t, out, "src/screens/Home.tsx"))
	detail := string(file(t, out, "src/screens/Dettaglio.tsx"))
	spec := string(file(t, out, "tests/flows.spec.ts"))

	// t1: test.id -> data-testid + onClick verso la rotta di arrivo.
	for _, want := range []string{`data-testid="login-submit"`, `onClick={() => navigate("/home")}`, `role="button"`, `aria-label="Accedi"`, "cursor-pointer", "// flow: t1", "// guard: credenziali valide", "// effect: sessione attiva"} {
		if !strings.Contains(login, want) {
			t.Errorf("Login.tsx: manca %q", want)
		}
	}
	if !strings.Contains(spec, `page.getByTestId("login-submit")`) {
		t.Error("i test non cercano il data-testid di t1")
	}
	// t2: test.text -> il testo c'è nel DOM della schermata.
	if !strings.Contains(home, `{"Cuffie wireless"}`) || !strings.Contains(spec, `page.getByText("Cuffie wireless")`) {
		t.Error("t2: il testo del trigger non è nel DOM o nei test")
	}
	// t4: solo etichetta -> ruolo button con aria-label.
	if !strings.Contains(detail, `aria-label="Indietro"`) || !strings.Contains(spec, `getByRole('button', { name: "Indietro" })`) {
		t.Error("t4: ruolo button con nome non cablato")
	}
	// t3: nessun elemento -> pulsante nel <nav> nascosto.
	if !strings.Contains(home, "<nav ") || !strings.Contains(home, `>Esci</button>`) || !strings.Contains(home, `navigate("/login")`) || !strings.Contains(home, "flow: t3") {
		t.Errorf("t3: manca il pulsante nel nav nascosto:\n%s", home)
	}
	// La schermata iniziale è anche su "/".
	if app := string(file(t, out, "src/App.tsx")); !strings.Contains(app, `<Route path="/" element={<Login />} />`) {
		t.Errorf("App.tsx senza la rotta /:\n%s", app)
	}
	// Le rotte mancanti nel documento sono state completate per i test.
	if !strings.Contains(spec, `page.goto("/login")`) {
		t.Error("i test non partono dalla rotta della schermata iniziale")
	}
	if strings.Contains(spec, "test.fixme") {
		t.Error("nessun test dovrebbe essere fixme: il generatore completa le rotte")
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
				t.Fatalf("%s: numero di file diverso", target)
			}
			for j := range first.Files {
				if first.Files[j].Path != again.Files[j].Path || !bytes.Equal(first.Files[j].Content, again.Files[j].Content) {
					t.Fatalf("%s: %s non è deterministico", target, first.Files[j].Path)
				}
			}
		}
		for i := 1; i < len(first.Files); i++ {
			if first.Files[i-1].Path >= first.Files[i].Path {
				t.Errorf("%s: file non ordinati: %s, %s", target, first.Files[i-1].Path, first.Files[i].Path)
			}
		}
	}
}

func TestDoesNotMutateDocument(t *testing.T) {
	doc := Shop()
	before := proto.Clone(doc)
	gen(t, doc, codegen.TargetReact, nil)
	if !proto.Equal(before, doc) {
		t.Error("Generate ha modificato il documento (le rotte di default vanno scritte su una copia)")
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
		t.Error("asset copiato con byte diversi")
	}
	if !strings.Contains(string(file(t, out, "src/screens/Immagini.tsx")), `src="/assets/`+hash+`.png"`) {
		t.Error("l'<img> non punta all'asset copiato")
	}
	// L'asset assente dà un segnaposto e un avviso, non un errore.
	found := false
	for _, w := range out.Warnings {
		if strings.Contains(w, "000000000000") {
			found = true
		}
	}
	if !found {
		t.Errorf("manca l'avviso sull'asset assente: %v", out.Warnings)
	}
	hout := gen(t, doc, codegen.TargetHTML, src)
	if !strings.Contains(string(file(t, hout, "immagini.html")), `src="assets/`+hash+`.png"`) {
		t.Error("html: l'<img> non punta all'asset copiato")
	}
}

func TestOptionsAndErrors(t *testing.T) {
	if _, err := codegen.Generate(Shop(), codegen.Options{Target: "vue"}, nil); err == nil {
		t.Error("target sconosciuto accettato")
	}
	if _, err := codegen.Generate(Shop(), codegen.Options{FlowID: "nope"}, nil); err == nil {
		t.Error("flusso sconosciuto accettato")
	}
	empty := screenDoc(func(b *B, s string) {})
	empty.Nodes = nil
	if _, err := codegen.Generate(empty, codegen.Options{}, nil); err == nil {
		t.Error("documento senza schermate accettato")
	}
	if _, err := codegen.Generate(nil, codegen.Options{}, nil); err == nil {
		t.Error("documento nil accettato")
	}
	// Il target di default è react.
	out, err := codegen.Generate(Shop(), codegen.Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	file(t, out, "package.json")
	// Un solo flusso: i test e il cablaggio sono quelli del flusso.
	out, err = codegen.Generate(Shop(), codegen.Options{FlowID: "f_acquisto"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(file(t, out, "tests/flows.spec.ts")), "Flusso: Acquisto") {
		t.Error("test del flusso scelto assenti")
	}
}

func TestNamesDedupAndCodeMeta(t *testing.T) {
	b := New("d", "Dup")
	for i, n := range []string{"Home", "Home", "home page"} {
		id := string(rune('a' + i))
		b.Add(id, "page1", n, float64(i)*500, 0, 100, 100, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	}
	b.Add("app", "page1", "App", 2000, 0, 100, 100, Frame(false, nil), Fill(Solid(C(1, 1, 1))), Meta("code.component", "ProfiloUtente", "code.route", "utente/:id"))
	out := gen(t, b.Doc, codegen.TargetReact, nil)
	for _, p := range []string{"src/screens/Home.tsx", "src/screens/Home2.tsx", "src/screens/HomePage.tsx", "src/screens/ProfiloUtente.tsx"} {
		file(t, out, p)
	}
	app := string(file(t, out, "src/App.tsx"))
	if !strings.Contains(app, `path="/utente/:id"`) || !strings.Contains(app, `path="/home-2"`) {
		t.Errorf("rotte: %s", app)
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
		t.Errorf("scritti %d file su %d", len(written), len(out.Files))
	}
	if _, err := codegen.WriteFiles(out, dir, false); err == nil {
		t.Error("una cartella non vuota va rifiutata senza force")
	}
	if _, err := codegen.WriteFiles(out, dir, true); err != nil {
		t.Errorf("con force deve riuscire: %v", err)
	}
	if _, err := codegen.WriteFiles(&codegen.Output{Files: []codegen.File{{Path: "../fuori.txt"}}}, t.TempDir(), false); err == nil {
		t.Error("percorso fuori dalla cartella accettato")
	}
}

// Casi limite del cablaggio: un test.id nel master non si duplica nelle
// istanze, "Index" non collide con l'indice, un tasto senza etichetta si segnala
// e i trigger key/back diventano ascoltatore e navigate(-1).
func TestWiringEdgeCases(t *testing.T) {
	b := New("d", "Bordi")
	b.Add("m", "page1", "Master", 5000, 0, 50, 50, Frame(false, nil), Fill(Solid(C(1, 0, 0))), Meta("test.id", "dal-master"))
	b.Component("c", "m", "M")
	b.Add("index", "page1", "Index", 0, 0, 200, 200, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("i", "index", "istanza", 10, 10, 50, 50, Instance("c"))
	b.Add("altra", "page1", "Altra", 500, 0, 200, 200, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Flow("f", "F", "index")
	b.Transition(&opendesignerv1.Transition{Id: "k1", FlowId: "f", FromId: "index", ToId: "altra", Trigger: "key", Label: "Enter"})
	b.Transition(&opendesignerv1.Transition{Id: "k2", FlowId: "f", FromId: "index", ToId: "altra", Trigger: "key"})
	b.Transition(&opendesignerv1.Transition{Id: "b1", FlowId: "f", FromId: "altra", ToId: "index", Trigger: "back", Label: "Indietro"})
	out := gen(t, b.Doc, codegen.TargetReact, nil)

	screen := string(file(t, out, "src/screens/Index.tsx"))
	if strings.Contains(screen, "dal-master") {
		t.Error("il test.id del master compare nell'istanza")
	}
	if !strings.Contains(screen, `if (e.key === "Enter") navigate("/altra")`) || strings.Contains(screen, `e.key === ""`) {
		t.Errorf("ascoltatore dei tasti:\n%s", screen)
	}
	if !strings.Contains(string(file(t, out, "src/screens/Altra.tsx")), "navigate(-1)") {
		t.Error("il trigger back non fa navigate(-1)")
	}
	found := false
	for _, w := range out.Warnings {
		found = found || strings.Contains(w, "k2")
	}
	if !found {
		t.Errorf("manca l'avviso sul tasto senza etichetta: %v", out.Warnings)
	}
	hout := gen(t, b.Doc, codegen.TargetHTML, nil)
	if !strings.Contains(string(file(t, hout, "index.html")), `data-node-id="index"`) {
		t.Error("index.html non è la schermata iniziale")
	}
}

// Il giro si chiude: `flow coverage` sul progetto esportato vede le schermate
// come implementate (le esportate sono l'implementazione) e le transizioni come
// testate (i test generati le annotano con `// flow:<id>`).
func TestCoverageAfterExport(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	dir := t.TempDir()
	if _, err := codegen.WriteFiles(out, dir, false); err != nil {
		t.Fatal(err)
	}
	// Le rotte vanno nei meta: quelle di default le ha calcolate l'export, qui
	// le si scrive come farebbe chi le ha decise nell'editor.
	doc := Shop()
	for id, route := range map[string]string{"login": "/login", "home": "/home", "detail": "/dettaglio"} {
		doc.Nodes[id].Meta = map[string]string{"code.route": route}
	}
	rep, err := flow.Coverage(doc, "", dir)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Totals.ScreensImplemented != 3 || rep.Totals.TransitionsTested != 4 {
		t.Errorf("coverage = %+v, want 3 schermate implementate e 4 transizioni testate", rep.Totals)
	}
}
