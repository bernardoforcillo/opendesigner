package flow

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

var update = flag.Bool("update", false, "riscrive i golden file in testdata/")

// tdoc costruisce documenti in memoria: i test descrivono il grafo, non i proto.
type tdoc struct{ *opendesignerv1.Document }

func newTDoc() *tdoc {
	return &tdoc{&opendesignerv1.Document{
		Id: "doc1", Name: "Shop",
		Nodes:       map[string]*opendesignerv1.Node{},
		Flows:       map[string]*opendesignerv1.Flow{},
		Transitions: map[string]*opendesignerv1.Transition{},
	}}
}

// node aggiunge un nodo; meta è una lista piatta chiave, valore, chiave, valore...
func (d *tdoc) node(id, name string, meta ...string) *tdoc {
	m := map[string]string{}
	for i := 0; i+1 < len(meta); i += 2 {
		m[meta[i]] = meta[i+1]
	}
	d.Nodes[id] = &opendesignerv1.Node{Id: id, Name: name, Meta: m}
	return d
}

func (d *tdoc) flow(id, name, start string) *tdoc {
	d.Flows[id] = &opendesignerv1.Flow{Id: id, Name: name, StartId: start}
	return d
}

// tr: id, flusso, da, a, etichetta, trigger.
func (d *tdoc) tr(id, flowID, from, to, label, trigger string) *opendesignerv1.Transition {
	t := &opendesignerv1.Transition{Id: id, FlowId: flowID, FromId: from, ToId: to, Label: label, Trigger: trigger}
	d.Transitions[id] = t
	return t
}

func kinds(r *opendesignerv1.FlowReport) []string {
	var out []string
	for _, i := range r.GetIssues() {
		out = append(out, i.GetKind()+":"+i.GetNodeId()+":"+i.GetTransitionId())
	}
	return out
}

func pathStrings(r *opendesignerv1.FlowReport) []string {
	var out []string
	for _, p := range r.GetPaths() {
		s := strings.Join(p.GetNodeIds(), ">")
		if p.GetLoops() {
			s += "@loop"
		}
		out = append(out, s)
	}
	return out
}

func TestAnalyze(t *testing.T) {
	tests := []struct {
		name       string
		build      func() *tdoc
		wantIssues []string
		wantPaths  []string
		truncated  bool
	}{
		{
			name: "diamante: due rami che si riuniscono",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").node("c", "C").node("e", "E", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "via b", "click")
				d.tr("t2", "f", "a", "c", "via c", "submit")
				d.tr("t3", "f", "b", "e", "", "click")
				d.tr("t4", "f", "c", "e", "", "click")
				return d
			},
			wantPaths: []string{"a>b>e", "a>c>e"},
		},
		{
			name: "ciclo: l'arco di ritorno chiude il percorso",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").node("e", "E", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "avanti", "click")
				d.tr("t2", "f", "b", "a", "indietro", "back")
				d.tr("t3", "f", "b", "e", "fine", "click")
				return d
			},
			// Le uscite di B sono ordinate per etichetta: "fine" < "indietro".
			wantPaths: []string{"a>b>e", "a>b>a@loop"},
		},
		{
			name: "irraggiungibile",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").node("x", "Orfana").node("y", "Y", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "", "click")
				d.tr("t2", "f", "x", "y", "", "click")
				return d
			},
			wantIssues: []string{"unreachable:x:", "unreachable:y:", "dead_end:b:"},
			wantPaths:  []string{"a>b"},
		},
		{
			name: "vicolo cieco ma tipo end e' lecito",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "", "click")
				d.tr("t2", "f", "a", "c", "", "submit")
				return d
			},
			wantIssues: []string{"dead_end:b:"},
			wantPaths:  []string{"a>b", "a>c"},
		},
		{
			name: "senza ingresso",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").flow("f", "F", "")
				d.tr("t1", "f", "a", "b", "", "click")
				return d
			},
			wantIssues: []string{"no_start::"},
		},
		{
			name: "flusso vuoto",
			build: func() *tdoc {
				return newTDoc().node("a", "A").flow("f", "F", "a")
			},
			wantIssues: []string{"empty::"},
		},
		{
			name: "ambiguita': stesso innesco senza guard",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Vai", "click")
				d.tr("t2", "f", "a", "c", "Vai", "click")
				return d
			},
			wantIssues: []string{"ambiguous:a:t2"},
			wantPaths:  []string{"a>b", "a>c"},
		},
		{
			name: "guard diverse: nessuna ambiguita'",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Vai", "click").Guard = "carrello pieno"
				d.tr("t2", "f", "a", "c", "Vai", "click").Guard = "carrello vuoto"
				return d
			},
			wantPaths: []string{"a>b", "a>c"},
		},
		{
			name: "guard identiche: ambiguo",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Vai", "click").Guard = "ok"
				d.tr("t2", "f", "a", "c", "Vai", "click").Guard = "ok"
				return d
			},
			wantIssues: []string{"ambiguous:a:t2"},
			wantPaths:  []string{"a>b", "a>c"},
		},
		{
			name: "innesci diversi (elemento) non sono ambigui",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Vai", "click").ElementId = "e1"
				d.tr("t2", "f", "a", "c", "Vai", "click").ElementId = "e2"
				return d
			},
			wantPaths: []string{"a>b", "a>c"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reps := Analyze(tc.build().Document, "")
			if len(reps) != 1 {
				t.Fatalf("report = %d, want 1", len(reps))
			}
			r := reps[0]
			if got := kinds(r); !reflect.DeepEqual(got, tc.wantIssues) {
				t.Errorf("issues = %v, want %v", got, tc.wantIssues)
			}
			if got := pathStrings(r); !reflect.DeepEqual(got, tc.wantPaths) {
				t.Errorf("paths = %v, want %v", got, tc.wantPaths)
			}
			if r.GetPathsTruncated() != tc.truncated {
				t.Errorf("truncated = %v, want %v", r.GetPathsTruncated(), tc.truncated)
			}
			for _, is := range r.GetIssues() {
				if is.GetMessage() == "" || is.GetFlowId() != "f" {
					t.Errorf("issue incompleta: %+v", is)
				}
			}
		})
	}
}

func TestAnalyzeMessagesAreItalianAndNameTheNode(t *testing.T) {
	d := newTDoc().node("a", "Home").node("x", "Pagina Orfana").flow("f", "F", "a")
	d.tr("t1", "f", "x", "a", "", "click")
	r := Analyze(d.Document, "f")[0]
	var found bool
	for _, is := range r.GetIssues() {
		if is.GetKind() == IssueUnreachable {
			found = true
			if !strings.Contains(is.GetMessage(), `"Pagina Orfana"`) || !strings.Contains(is.GetMessage(), "non è raggiungibile") {
				t.Errorf("messaggio = %q", is.GetMessage())
			}
		}
	}
	if !found {
		t.Fatal("manca l'issue unreachable")
	}
}

func TestAnalyzeAllFlowsSortedAndFilter(t *testing.T) {
	d := newTDoc().node("a", "A").flow("zeta", "Z", "a").flow("alfa", "A", "a").flow("mid", "M", "a")
	reps := Analyze(d.Document, "")
	var ids []string
	for _, r := range reps {
		ids = append(ids, r.GetFlowId())
	}
	if !reflect.DeepEqual(ids, []string{"alfa", "mid", "zeta"}) {
		t.Fatalf("ordine = %v", ids)
	}
	if got := Analyze(d.Document, "mid"); len(got) != 1 || got[0].GetFlowId() != "mid" {
		t.Fatalf("filtro = %v", got)
	}
	if got := Analyze(d.Document, "nope"); len(got) != 0 {
		t.Fatalf("flusso inesistente = %v", got)
	}
}

// Una griglia di scelte successive: 2^n percorsi, oltre il tetto di 200.
func TestAnalyzePathCapTruncates(t *testing.T) {
	d := newTDoc().flow("f", "F", "s0")
	const layers = 9 // 2^9 = 512 > 200
	for i := 0; i <= layers; i++ {
		d.node(fmt.Sprintf("s%d", i), fmt.Sprintf("S%d", i))
	}
	d.Nodes[fmt.Sprintf("s%d", layers)].Meta[MetaKind] = KindEnd
	for i := 0; i < layers; i++ {
		d.tr(fmt.Sprintf("a%d", i), "f", fmt.Sprintf("s%d", i), fmt.Sprintf("s%d", i+1), "a", "click")
		d.tr(fmt.Sprintf("b%d", i), "f", fmt.Sprintf("s%d", i), fmt.Sprintf("s%d", i+1), "b", "click")
	}
	r := Analyze(d.Document, "f")[0]
	if !r.GetPathsTruncated() {
		t.Error("paths_truncated deve essere true")
	}
	if len(r.GetPaths()) != MaxPaths {
		t.Errorf("percorsi = %d, want %d", len(r.GetPaths()), MaxPaths)
	}
}

func TestAnalyzeDepthCapTruncates(t *testing.T) {
	d := newTDoc().flow("f", "F", "s0")
	const n = MaxDepth + 5
	for i := 0; i <= n; i++ {
		d.node(fmt.Sprintf("s%d", i), fmt.Sprintf("S%d", i))
	}
	for i := 0; i < n; i++ {
		d.tr(fmt.Sprintf("t%d", i), "f", fmt.Sprintf("s%d", i), fmt.Sprintf("s%d", i+1), "", "click")
	}
	r := Analyze(d.Document, "f")[0]
	if !r.GetPathsTruncated() || len(r.GetPaths()) != 0 {
		t.Errorf("truncated=%v paths=%d: la catena oltre %d archi va troncata", r.GetPathsTruncated(), len(r.GetPaths()), MaxDepth)
	}
}

func TestAnalyzeExactlyAtCapIsNotTruncated(t *testing.T) {
	d := newTDoc().node("a", "A").flow("f", "F", "a")
	for i := 0; i < MaxPaths; i++ {
		id := fmt.Sprintf("e%03d", i)
		d.node(id, id, MetaKind, KindEnd)
		d.tr("t"+id, "f", "a", id, id, "click")
	}
	r := Analyze(d.Document, "f")[0]
	if r.GetPathsTruncated() || len(r.GetPaths()) != MaxPaths {
		t.Errorf("truncated=%v paths=%d", r.GetPathsTruncated(), len(r.GetPaths()))
	}
}

func TestAnalyzeDeterministic(t *testing.T) {
	build := func() *tdoc {
		d := newTDoc().node("a", "A").node("b", "B").node("c", "C").node("d", "D", MetaKind, "end").flow("f", "F", "a")
		for i, to := range []string{"b", "c", "d"} {
			d.tr(fmt.Sprintf("t%d", i), "f", "a", to, "x", "click")
		}
		d.tr("t9", "f", "b", "d", "", "click")
		d.tr("t8", "f", "c", "d", "", "click")
		return d
	}
	first := Spec(build().Document, "")
	for i := 0; i < 20; i++ {
		if got := Spec(build().Document, ""); got != first {
			t.Fatal("Spec non deterministica")
		}
	}
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

// checkout è il documento dei golden: login, carrello, pagamento con guard,
// un ciclo e uno scatto automatico.
func checkout() *tdoc {
	d := newTDoc().
		node("home", "Home", MetaRoute, "/", MetaComponent, "HomePage", MetaStatus, StatusImplemented).
		node("login", "Login", MetaRoute, "/login", MetaComponent, "LoginPage").
		node("cart", "Carrello", MetaRoute, "/cart/:id").
		node("pay", "Pagamento").
		node("done", "Grazie", MetaKind, KindEnd, MetaRoute, "/thanks").
		node("btn-login", "Bottone login", MetaTestID, "go-login").
		node("link-cart", "Link carrello", MetaTestText, "Vai al carrello")
	d.flow("checkout", "Acquisto", "home")
	d.Flows["checkout"].Description = "Dal catalogo alla conferma d'ordine."
	d.tr("t-login", "checkout", "home", "login", "Accedi", "click").ElementId = "btn-login"
	d.tr("t-cart", "checkout", "login", "cart", "Carrello", "submit").ElementId = "link-cart"
	back := d.tr("t-back", "checkout", "cart", "home", "", "back")
	back.Effect = "svuota il carrello"
	pay := d.tr("t-pay", "checkout", "cart", "pay", "Paga", "click")
	pay.Guard = "carrello non vuoto"
	pay.Effect = "ordine creato"
	d.tr("t-done", "checkout", "pay", "done", "", "auto")
	d.tr("t-key", "checkout", "home", "cart", "Enter", "key")
	return d
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("manca il golden %s (esegui con -update): %v", path, err)
	}
	if string(want) != got {
		t.Errorf("%s differisce dal golden (esegui con -update per rigenerare)\n--- got ---\n%s", name, got)
	}
}

func TestSpecGolden(t *testing.T) { golden(t, "checkout.spec.md", Spec(checkout().Document, "")) }
func TestPlaywrightGolden(t *testing.T) {
	out, err := PlaywrightTests(checkout().Document, "checkout", PlaywrightOptions{})
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "checkout.spec.ts", out)
}

func TestSpecContent(t *testing.T) {
	out := Spec(checkout().Document, "checkout")
	for _, want := range []string{
		"## Flusso: Acquisto (`checkout`)",
		"Dal catalogo alla conferma d'ordine.",
		"| Home | screen | `/` | `HomePage` | implemented |",
		"**Home** --[click: Accedi]--> **Login**",
		"**Carrello** --[click: Paga]--> **Pagamento** (guard: carrello non vuoto; effect: ordine creato)",
		"#### Scenario 1:",
		"**Given** l'utente è sulla schermata **Home**",
		"**When** l'utente fa click su \"Accedi\"",
		"**Then** vede la schermata **Login**",
		"### Problemi",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("la spec non contiene %q", want)
		}
	}
	if got := Spec(newTDoc().Document, ""); !strings.Contains(got, "Nessun flusso") {
		t.Errorf("documento senza flussi: %q", got)
	}
	if got := Spec(checkout().Document, "boh"); !strings.Contains(got, "non trovato") {
		t.Errorf("flusso inesistente: %q", got)
	}
}

func TestSpecEscapesTableCells(t *testing.T) {
	d := newTDoc().node("a", "A|B", MetaRoute, "/x|y").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "", "click")
	out := Spec(d.Document, "")
	if !strings.Contains(out, `| A\|B |`) || !strings.Contains(out, "`/x\\|y`") {
		t.Errorf("pipe non escapato:\n%s", out)
	}
}

// ---------------------------------------------------------------------------
// Playwright
// ---------------------------------------------------------------------------

func TestPlaywrightLocatorsAndAssertions(t *testing.T) {
	out, err := PlaywrightTests(checkout().Document, "checkout", PlaywrightOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"import { expect, test } from '@playwright/test';",
		`await page.goto("/");`,
		"// flow:t-login",
		`await page.getByTestId("go-login").click();`,
		`await page.getByText("Vai al carrello").click();`,
		`await page.keyboard.press("Enter");`,
		"await page.goBack();",
		`// guard: carrello non vuoto`,
		`// effect: ordine creato`,
		"trigger auto",
		`await page.getByRole('button', { name: "Paga" }).click();`,
		`new RegExp("^[a-z]+://[^/]+/cart/[^/]+/?(?:[?#].*)?$")`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("manca %q nell'output:\n%s", want, out)
		}
	}
}

func TestPlaywrightMissingRouteIsFixme(t *testing.T) {
	d := newTDoc().node("a", "Senza rotta").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "Vai", "click")
	out, err := PlaywrightTests(d.Document, "f", PlaywrightOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `// TODO: manca code.route su "Senza rotta"`) || !strings.Contains(out, "test.fixme(true") {
		t.Errorf("manca TODO/fixme:\n%s", out)
	}
	if strings.Contains(out, "page.goto") {
		t.Error("senza rotta non si naviga")
	}
	if strings.Contains(out, "toHaveURL") || strings.Contains(out, "{ expect,") {
		t.Error("nessuna asserzione né import di expect senza rotte")
	}
}

func TestPlaywrightNoLocatorIsFixme(t *testing.T) {
	d := newTDoc().node("a", "A", MetaRoute, "/a").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "", "click")
	out, _ := PlaywrightTests(d.Document, "f", PlaywrightOptions{})
	if !strings.Contains(out, "// TODO: transizione t") || !strings.Contains(out, "test.fixme(true") {
		t.Errorf("atteso TODO:\n%s", out)
	}
}

func TestPlaywrightFreeTextTriggerUsesGetByText(t *testing.T) {
	d := newTDoc().node("a", "A", MetaRoute, "/a").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "Menu", "hover")
	out, _ := PlaywrightTests(d.Document, "f", PlaywrightOptions{})
	if !strings.Contains(out, `page.getByText("Menu")`) || !strings.Contains(out, "toBeVisible()") {
		t.Errorf("trigger libero:\n%s", out)
	}
}

func TestPlaywrightQuotingAndBaseURL(t *testing.T) {
	d := newTDoc().node("a", `Home "<&>"`, MetaRoute, "/a").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "dice \"ciao\"\nricorda\\", "click")
	out, err := PlaywrightTests(d.Document, "f", PlaywrightOptions{BaseURL: "http://localhost:3000"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"http://localhost:3000/a"`) {
		t.Errorf("baseURL:\n%s", out)
	}
	if !strings.Contains(out, `{ name: "dice \"ciao\"\nricorda\\" }`) {
		t.Errorf("escape del nome:\n%s", out)
	}
	if !strings.Contains(out, `<&>`) {
		t.Errorf("niente escape HTML:\n%s", out)
	}
}

func TestPlaywrightErrors(t *testing.T) {
	if _, err := PlaywrightTests(newTDoc().Document, "", PlaywrightOptions{}); err == nil {
		t.Error("documento senza flussi deve dare errore")
	}
	if _, err := PlaywrightTests(checkout().Document, "boh", PlaywrightOptions{}); err == nil {
		t.Error("flusso inesistente deve dare errore")
	}
}

func TestRoutePattern(t *testing.T) {
	tests := map[string]string{
		"/":           `^[a-z]+://[^/]+/?(?:[?#].*)?$`,
		"/login":      `^[a-z]+://[^/]+/login/?(?:[?#].*)?$`,
		"/a.b/":       `^[a-z]+://[^/]+/a\.b/?(?:[?#].*)?$`,
		"/u/:id/edit": `^[a-z]+://[^/]+/u/[^/]+/edit/?(?:[?#].*)?$`,
		"/p/[slug]":   `^[a-z]+://[^/]+/p/[^/]+/?(?:[?#].*)?$`,
		"x":           `^[a-z]+://[^/]+/x/?(?:[?#].*)?$`,
	}
	for in, want := range tests {
		if got := routePattern(in); got != want {
			t.Errorf("routePattern(%q) = %s, want %s", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Coverage e Tasks
// ---------------------------------------------------------------------------

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func coverageRepo(t *testing.T) string {
	root := t.TempDir()
	// Implementazione: rotta e componente.
	write(t, root, "src/App.tsx", `const routes = [{ path: "/login", element: <LoginPage/> }];`)
	write(t, root, "src/cart.ts", "// rotta del carrello\nexport const cart = '/cart/:id'\n")
	// Test annotato: conta per le transizioni ma NON implementa Pagamento.
	write(t, root, "e2e/checkout.spec.ts", "// flow:t-login\n// flow:t-cart.\nconst x = '/pay'; PagamentoPage\n")
	// Generati, dipendenze e binari: ignorati per l'implementazione.
	write(t, root, "src/gen.ts", "// Code generated by x. DO NOT EDIT.\nconst a = '/pay'\n")
	write(t, root, "node_modules/lib/index.js", "// flow:t-pay\n'/pay'")
	write(t, root, "vendor/x.go", "// flow:t-pay\n")
	write(t, root, "docs/note.md", "flow:t-pay '/pay'")
	write(t, root, "src/blob.js", "flow:t-key\x00binary")
	return root
}

func TestCoverage(t *testing.T) {
	root := coverageRepo(t)
	d := checkout()
	rep, err := Coverage(d.Document, "", root)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Flows) != 1 {
		t.Fatalf("flussi = %d", len(rep.Flows))
	}
	status := map[string]string{}
	for _, s := range rep.Flows[0].Screens {
		status[s.NodeID] = s.Status
	}
	want := map[string]string{
		"home":  StatusImplemented, // dal meta, nessun codice
		"login": StatusImplemented, // "/login" in App.tsx
		"cart":  StatusImplemented, // "/cart/:id" in cart.ts
		"pay":   StatusPlanned,     // citata solo da test/generato/dipendenze
		"done":  StatusPlanned,
		// gli elementi trigger non sono schermate del flusso
	}
	for id, w := range want {
		if status[id] != w {
			t.Errorf("schermata %s = %q, want %q", id, status[id], w)
		}
	}
	tested := map[string]bool{}
	for _, tr := range rep.Flows[0].Transitions {
		tested[tr.ID] = tr.Tested
	}
	for id, w := range map[string]bool{"t-login": true, "t-cart": true, "t-pay": false, "t-key": false, "t-back": false} {
		if tested[id] != w {
			t.Errorf("transizione %s tested = %v, want %v", id, tested[id], w)
		}
	}
	tot := rep.Totals
	if tot.ScreensTotal != 5 || tot.ScreensImplemented != 3 || tot.TransitionsTotal != 6 || tot.TransitionsTested != 2 {
		t.Errorf("totali = %+v", tot)
	}
	if tot.ScreensPercent != 60 || tot.TransitionsPercent != 33.3 || tot.Percent != 45.5 {
		t.Errorf("percentuali = %+v", tot)
	}
	md := rep.Markdown()
	for _, s := range []string{"# Coverage dei flussi — Shop", "**Totale: 45.5%**", "`src/App.tsx`", "(dichiarato in `status`)"} {
		if !strings.Contains(md, s) {
			t.Errorf("markdown senza %q:\n%s", s, md)
		}
	}
}

func TestCoverageComponentAndStatusOverride(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/Pay.tsx", "export function PagamentoPage() {}\nexport const NotPagamentoPageX = 1")
	d := newTDoc().
		node("a", "A", MetaStatus, StatusTested).
		node("p", "P", MetaComponent, "PagamentoPage").
		node("q", "Q", MetaComponent, "Pagamento").
		node("r", "R", MetaRoute, "/")
	d.flow("f", "F", "a")
	d.tr("t1", "f", "a", "p", "", "click")
	d.tr("t2", "f", "p", "q", "", "click")
	d.tr("t3", "f", "q", "r", "", "click")
	rep, err := Coverage(d.Document, "f", root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]ScreenCoverage{}
	for _, s := range rep.Flows[0].Screens {
		got[s.NodeID] = s
	}
	if got["a"].Status != StatusTested || got["a"].Source != "meta" {
		t.Errorf("override: %+v", got["a"])
	}
	if got["p"].Status != StatusImplemented || got["p"].Source != "code" {
		t.Errorf("componente: %+v", got["p"])
	}
	// "Pagamento" compare solo dentro altri identificatori: \b non deve scattare.
	if got["q"].Status != StatusPlanned {
		t.Errorf("confine di parola: %+v", got["q"])
	}
	// La rotta "/" da sola non basta (sarebbe ovunque).
	if got["r"].Status != StatusPlanned {
		t.Errorf("rotta radice: %+v", got["r"])
	}
	write(t, root, "src/router.ts", `export default ['/']`)
	rep, _ = Coverage(d.Document, "f", root)
	for _, s := range rep.Flows[0].Screens {
		if s.NodeID == "r" && s.Status != StatusImplemented {
			t.Errorf("rotta radice quotata: %+v", s)
		}
	}
}

func TestCoverageErrorsAndEmpty(t *testing.T) {
	if _, err := Coverage(checkout().Document, "", ""); err == nil {
		t.Error("repoDir vuoto deve dare errore")
	}
	if _, err := Coverage(checkout().Document, "", filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("repoDir inesistente deve dare errore")
	}
	rep, err := Coverage(newTDoc().Document, "", t.TempDir())
	if err != nil || rep.Totals.Percent != 100 {
		t.Errorf("documento senza flussi: %+v %v", rep, err)
	}
}

func TestCoverageSharedScreenCountedOnce(t *testing.T) {
	d := newTDoc().node("a", "A").node("b", "B").flow("f1", "F1", "a").flow("f2", "F2", "a")
	d.tr("t1", "f1", "a", "b", "", "click")
	d.tr("t2", "f2", "a", "b", "", "click")
	rep, _ := Coverage(d.Document, "", t.TempDir())
	if rep.Totals.ScreensTotal != 2 || rep.Totals.TransitionsTotal != 2 || len(rep.Flows) != 2 {
		t.Errorf("totali = %+v", rep.Totals)
	}
}

func TestCoverageIgnoresGeneratedPlaywright(t *testing.T) {
	root := t.TempDir()
	d := checkout()
	out, err := PlaywrightTests(d.Document, "", PlaywrightOptions{})
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, "e2e/generated.spec.ts", out)
	rep, err := Coverage(d.Document, "", root)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Totals.TransitionsTested != 6 {
		t.Errorf("il test generato deve coprire tutte le transizioni: %+v", rep.Totals)
	}
	if rep.Totals.ScreensImplemented != 1 { // solo home, dal meta
		t.Errorf("il test generato non e' implementazione: %+v", rep.Totals)
	}
}

func TestTasks(t *testing.T) {
	root := coverageRepo(t)
	d := checkout()
	cov, err := Coverage(d.Document, "", root)
	if err != nil {
		t.Fatal(err)
	}
	out := Tasks(d.Document, "", cov)
	for _, s := range []string{
		"# Attività dai flussi — Shop",
		"- [ ] Implementare la schermata **Pagamento** (manca `code.route`/`code.component` nel disegno)",
		"- [ ] Implementare la schermata **Grazie** — rotta `/thanks`",
		"- [ ] Testare la transizione **Carrello** --[click: Paga]--> **Pagamento**",
		"`// flow:t-pay`",
		"Totale attività aperte:",
	} {
		if !strings.Contains(out, s) {
			t.Errorf("tasks senza %q:\n%s", s, out)
		}
	}
	if strings.Contains(out, "Implementare la schermata **Home**") || strings.Contains(out, "`// flow:t-login`") {
		t.Errorf("tasks elenca cose già coperte:\n%s", out)
	}

	// Senza coverage: solo i problemi del grafo.
	d2 := newTDoc().node("a", "A").flow("f", "F", "a")
	got := Tasks(d2.Document, "", nil)
	if !strings.Contains(got, "Correggere il grafo (`empty`)") {
		t.Errorf("tasks senza coverage:\n%s", got)
	}
	// Tutto coperto.
	d3 := newTDoc().node("a", "A", MetaStatus, StatusTested).node("b", "B", MetaKind, KindEnd, MetaStatus, StatusTested).flow("f", "F", "a")
	d3.tr("t", "f", "a", "b", "", "click")
	r3 := t.TempDir()
	write(t, r3, "x.spec.ts", "// flow:t")
	cov3, _ := Coverage(d3.Document, "", r3)
	if got := Tasks(d3.Document, "", cov3); !strings.Contains(got, "tutto coperto") {
		t.Errorf("atteso tutto coperto:\n%s", got)
	}
}
