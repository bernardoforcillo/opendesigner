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

var update = flag.Bool("update", false, "rewrite the golden files in testdata/")

// tdoc builds in-memory documents: the tests describe the graph, not the protos.
type tdoc struct{ *opendesignerv1.Document }

func newTDoc() *tdoc {
	return &tdoc{&opendesignerv1.Document{
		Id: "doc1", Name: "Shop",
		Nodes:       map[string]*opendesignerv1.Node{},
		Flows:       map[string]*opendesignerv1.Flow{},
		Transitions: map[string]*opendesignerv1.Transition{},
	}}
}

// node adds a node; meta is a flat list key, value, key, value...
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

// tr: id, flow, from, to, label, trigger.
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
			name: "diamond: two branches that rejoin",
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
			name: "cycle: the return edge closes the path",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").node("e", "E", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "next", "click")
				d.tr("t2", "f", "b", "a", "return", "back")
				d.tr("t3", "f", "b", "e", "finish", "click")
				return d
			},
			// B's exits are sorted by label: "finish" < "return".
			wantPaths: []string{"a>b>e", "a>b>a@loop"},
		},
		{
			name: "unreachable",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").node("x", "Orphan").node("y", "Y", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "", "click")
				d.tr("t2", "f", "x", "y", "", "click")
				return d
			},
			wantIssues: []string{"unreachable:x:", "unreachable:y:", "dead_end:b:"},
			wantPaths:  []string{"a>b"},
		},
		{
			name: "dead end but of type end is allowed",
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
			name: "without an entry",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B").flow("f", "F", "")
				d.tr("t1", "f", "a", "b", "", "click")
				return d
			},
			wantIssues: []string{"no_start::"},
		},
		{
			name: "empty flow",
			build: func() *tdoc {
				return newTDoc().node("a", "A").flow("f", "F", "a")
			},
			wantIssues: []string{"empty::"},
		},
		{
			name: "ambiguity: same trigger without a guard",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Go", "click")
				d.tr("t2", "f", "a", "c", "Go", "click")
				return d
			},
			wantIssues: []string{"ambiguous:a:t2"},
			wantPaths:  []string{"a>b", "a>c"},
		},
		{
			name: "different guards: no ambiguity",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Go", "click").Guard = "cart full"
				d.tr("t2", "f", "a", "c", "Go", "click").Guard = "cart empty"
				return d
			},
			wantPaths: []string{"a>b", "a>c"},
		},
		{
			name: "identical guards: ambiguous",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Go", "click").Guard = "ok"
				d.tr("t2", "f", "a", "c", "Go", "click").Guard = "ok"
				return d
			},
			wantIssues: []string{"ambiguous:a:t2"},
			wantPaths:  []string{"a>b", "a>c"},
		},
		{
			name: "different triggers (element) are not ambiguous",
			build: func() *tdoc {
				d := newTDoc().node("a", "A").node("b", "B", MetaKind, "end").node("c", "C", MetaKind, "end").flow("f", "F", "a")
				d.tr("t1", "f", "a", "b", "Go", "click").ElementId = "e1"
				d.tr("t2", "f", "a", "c", "Go", "click").ElementId = "e2"
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
					t.Errorf("incomplete issue: %+v", is)
				}
			}
		})
	}
}

func TestAnalyzeMessagesAreItalianAndNameTheNode(t *testing.T) {
	d := newTDoc().node("a", "Home").node("x", "Orphan Page").flow("f", "F", "a")
	d.tr("t1", "f", "x", "a", "", "click")
	r := Analyze(d.Document, "f")[0]
	var found bool
	for _, is := range r.GetIssues() {
		if is.GetKind() == IssueUnreachable {
			found = true
			if !strings.Contains(is.GetMessage(), `"Orphan Page"`) || !strings.Contains(is.GetMessage(), "is not reachable") {
				t.Errorf("message = %q", is.GetMessage())
			}
		}
	}
	if !found {
		t.Fatal("the unreachable issue is missing")
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
		t.Fatalf("order = %v", ids)
	}
	if got := Analyze(d.Document, "mid"); len(got) != 1 || got[0].GetFlowId() != "mid" {
		t.Fatalf("filter = %v", got)
	}
	if got := Analyze(d.Document, "nope"); len(got) != 0 {
		t.Fatalf("nonexistent flow = %v", got)
	}
}

// A grid of successive choices: 2^n paths, beyond the cap of 200.
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
		t.Error("paths_truncated must be true")
	}
	if len(r.GetPaths()) != MaxPaths {
		t.Errorf("paths = %d, want %d", len(r.GetPaths()), MaxPaths)
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
		t.Errorf("truncated=%v paths=%d: a chain beyond %d edges must be truncated", r.GetPathsTruncated(), len(r.GetPaths()), MaxDepth)
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
			t.Fatal("Spec is non-deterministic")
		}
	}
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

// checkout is the golden document: login, cart, payment with a guard,
// a cycle and an automatic transition.
func checkout() *tdoc {
	d := newTDoc().
		node("home", "Home", MetaRoute, "/", MetaComponent, "HomePage", MetaStatus, StatusImplemented).
		node("login", "Login", MetaRoute, "/login", MetaComponent, "LoginPage").
		node("cart", "Cart", MetaRoute, "/cart/:id").
		node("pay", "Payment").
		node("done", "Thanks", MetaKind, KindEnd, MetaRoute, "/thanks").
		node("btn-login", "Login button", MetaTestID, "go-login").
		node("link-cart", "Cart link", MetaTestText, "Go to cart")
	d.flow("checkout", "Purchase", "home")
	d.Flows["checkout"].Description = "From the catalog to the order confirmation."
	d.tr("t-login", "checkout", "home", "login", "Log in", "click").ElementId = "btn-login"
	d.tr("t-cart", "checkout", "login", "cart", "Cart", "submit").ElementId = "link-cart"
	back := d.tr("t-back", "checkout", "cart", "home", "", "back")
	back.Effect = "empties the cart"
	pay := d.tr("t-pay", "checkout", "cart", "pay", "Pay", "click")
	pay.Guard = "cart not empty"
	pay.Effect = "order created"
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
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	if string(want) != got {
		t.Errorf("%s differs from the golden (run with -update to regenerate)\n--- got ---\n%s", name, got)
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
		"## Flow: Purchase (`checkout`)",
		"From the catalog to the order confirmation.",
		"| Home | screen | `/` | `HomePage` | implemented |",
		"**Home** --[click: Log in]--> **Login**",
		"**Cart** --[click: Pay]--> **Payment** (guard: cart not empty; effect: order created)",
		"#### Scenario 1:",
		"**Given** the user is on screen **Home**",
		"**When** the user clicks \"Log in\"",
		"**Then** sees screen **Login**",
		"### Issues",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the spec does not contain %q", want)
		}
	}
	if got := Spec(newTDoc().Document, ""); !strings.Contains(got, "No flow") {
		t.Errorf("document without flows: %q", got)
	}
	if got := Spec(checkout().Document, "nope"); !strings.Contains(got, "not found") {
		t.Errorf("nonexistent flow: %q", got)
	}
}

func TestSpecEscapesTableCells(t *testing.T) {
	d := newTDoc().node("a", "A|B", MetaRoute, "/x|y").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "", "click")
	out := Spec(d.Document, "")
	if !strings.Contains(out, `| A\|B |`) || !strings.Contains(out, "`/x\\|y`") {
		t.Errorf("unescaped pipe:\n%s", out)
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
		`await page.getByText("Go to cart").click();`,
		`await page.keyboard.press("Enter");`,
		"await page.goBack();",
		`// guard: cart not empty`,
		`// effect: order created`,
		"trigger auto",
		`await page.getByRole('button', { name: "Pay" }).click();`,
		`new RegExp("^[a-z]+://[^/]+/cart/[^/]+/?(?:[?#].*)?$")`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in the output:\n%s", want, out)
		}
	}
}

func TestPlaywrightMissingRouteIsFixme(t *testing.T) {
	d := newTDoc().node("a", "No route").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "Go", "click")
	out, err := PlaywrightTests(d.Document, "f", PlaywrightOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `// TODO: code.route is missing on "No route"`) || !strings.Contains(out, "test.fixme(true") {
		t.Errorf("missing TODO/fixme:\n%s", out)
	}
	if strings.Contains(out, "page.goto") {
		t.Error("without a route there is no navigation")
	}
	if strings.Contains(out, "toHaveURL") || strings.Contains(out, "{ expect,") {
		t.Error("no assertion nor expect import without routes")
	}
}

func TestPlaywrightNoLocatorIsFixme(t *testing.T) {
	d := newTDoc().node("a", "A", MetaRoute, "/a").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "", "click")
	out, _ := PlaywrightTests(d.Document, "f", PlaywrightOptions{})
	if !strings.Contains(out, "// TODO: transition t") || !strings.Contains(out, "test.fixme(true") {
		t.Errorf("expected TODO:\n%s", out)
	}
}

func TestPlaywrightFreeTextTriggerUsesGetByText(t *testing.T) {
	d := newTDoc().node("a", "A", MetaRoute, "/a").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "Menu", "hover")
	out, _ := PlaywrightTests(d.Document, "f", PlaywrightOptions{})
	if !strings.Contains(out, `page.getByText("Menu")`) || !strings.Contains(out, "toBeVisible()") {
		t.Errorf("free trigger:\n%s", out)
	}
}

func TestPlaywrightQuotingAndBaseURL(t *testing.T) {
	d := newTDoc().node("a", `Home "<&>"`, MetaRoute, "/a").node("b", "B", MetaKind, KindEnd).flow("f", "F", "a")
	d.tr("t", "f", "a", "b", "says \"hello\"\nremember\\", "click")
	out, err := PlaywrightTests(d.Document, "f", PlaywrightOptions{BaseURL: "http://localhost:3000"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"http://localhost:3000/a"`) {
		t.Errorf("baseURL:\n%s", out)
	}
	if !strings.Contains(out, `{ name: "says \"hello\"\nremember\\" }`) {
		t.Errorf("name escaping:\n%s", out)
	}
	if !strings.Contains(out, `<&>`) {
		t.Errorf("no HTML escaping:\n%s", out)
	}
}

func TestPlaywrightErrors(t *testing.T) {
	if _, err := PlaywrightTests(newTDoc().Document, "", PlaywrightOptions{}); err == nil {
		t.Error("a document without flows must give an error")
	}
	if _, err := PlaywrightTests(checkout().Document, "nope", PlaywrightOptions{}); err == nil {
		t.Error("a nonexistent flow must give an error")
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
// Coverage and Tasks
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
	// Implementation: route and component.
	write(t, root, "src/App.tsx", `const routes = [{ path: "/login", element: <LoginPage/> }];`)
	write(t, root, "src/cart.ts", "// cart route\nexport const cart = '/cart/:id'\n")
	// Annotated test: counts for the transitions but does NOT implement Payment.
	write(t, root, "e2e/checkout.spec.ts", "// flow:t-login\n// flow:t-cart.\nconst x = '/pay'; PaymentPage\n")
	// Generated, dependencies and binaries: ignored for the implementation.
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
		t.Fatalf("flows = %d", len(rep.Flows))
	}
	status := map[string]string{}
	for _, s := range rep.Flows[0].Screens {
		status[s.NodeID] = s.Status
	}
	want := map[string]string{
		"home":  StatusImplemented, // from the meta, no code
		"login": StatusImplemented, // "/login" in App.tsx
		"cart":  StatusImplemented, // "/cart/:id" in cart.ts
		"pay":   StatusPlanned,     // cited only by tests/generated/dependencies
		"done":  StatusPlanned,
		// trigger elements are not screens of the flow
	}
	for id, w := range want {
		if status[id] != w {
			t.Errorf("screen %s = %q, want %q", id, status[id], w)
		}
	}
	tested := map[string]bool{}
	for _, tr := range rep.Flows[0].Transitions {
		tested[tr.ID] = tr.Tested
	}
	for id, w := range map[string]bool{"t-login": true, "t-cart": true, "t-pay": false, "t-key": false, "t-back": false} {
		if tested[id] != w {
			t.Errorf("transition %s tested = %v, want %v", id, tested[id], w)
		}
	}
	tot := rep.Totals
	if tot.ScreensTotal != 5 || tot.ScreensImplemented != 3 || tot.TransitionsTotal != 6 || tot.TransitionsTested != 2 {
		t.Errorf("totals = %+v", tot)
	}
	if tot.ScreensPercent != 60 || tot.TransitionsPercent != 33.3 || tot.Percent != 45.5 {
		t.Errorf("percentages = %+v", tot)
	}
	md := rep.Markdown()
	for _, s := range []string{"# Flow coverage — Shop", "**Total: 45.5%**", "`src/App.tsx`", "(declared in `status`)"} {
		if !strings.Contains(md, s) {
			t.Errorf("markdown without %q:\n%s", s, md)
		}
	}
}

func TestCoverageComponentAndStatusOverride(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/Pay.tsx", "export function PaymentPage() {}\nexport const NotPaymentPageX = 1")
	d := newTDoc().
		node("a", "A", MetaStatus, StatusTested).
		node("p", "P", MetaComponent, "PaymentPage").
		node("q", "Q", MetaComponent, "Payment").
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
		t.Errorf("component: %+v", got["p"])
	}
	// "Payment" only appears inside other identifiers: \b must not match.
	if got["q"].Status != StatusPlanned {
		t.Errorf("word boundary: %+v", got["q"])
	}
	// The route "/" alone is not enough (it would be everywhere).
	if got["r"].Status != StatusPlanned {
		t.Errorf("root route: %+v", got["r"])
	}
	write(t, root, "src/router.ts", `export default ['/']`)
	rep, _ = Coverage(d.Document, "f", root)
	for _, s := range rep.Flows[0].Screens {
		if s.NodeID == "r" && s.Status != StatusImplemented {
			t.Errorf("quoted root route: %+v", s)
		}
	}
}

func TestCoverageErrorsAndEmpty(t *testing.T) {
	if _, err := Coverage(checkout().Document, "", ""); err == nil {
		t.Error("an empty repoDir must give an error")
	}
	if _, err := Coverage(checkout().Document, "", filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("a nonexistent repoDir must give an error")
	}
	rep, err := Coverage(newTDoc().Document, "", t.TempDir())
	if err != nil || rep.Totals.Percent != 100 {
		t.Errorf("document without flows: %+v %v", rep, err)
	}
}

func TestCoverageSharedScreenCountedOnce(t *testing.T) {
	d := newTDoc().node("a", "A").node("b", "B").flow("f1", "F1", "a").flow("f2", "F2", "a")
	d.tr("t1", "f1", "a", "b", "", "click")
	d.tr("t2", "f2", "a", "b", "", "click")
	rep, _ := Coverage(d.Document, "", t.TempDir())
	if rep.Totals.ScreensTotal != 2 || rep.Totals.TransitionsTotal != 2 || len(rep.Flows) != 2 {
		t.Errorf("totals = %+v", rep.Totals)
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
		t.Errorf("the generated test must cover all transitions: %+v", rep.Totals)
	}
	if rep.Totals.ScreensImplemented != 1 { // only home, from the meta
		t.Errorf("the generated test is not an implementation: %+v", rep.Totals)
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
		"# Tasks from the flows — Shop",
		"- [ ] Implement the screen **Payment** (`code.route`/`code.component` missing in the design)",
		"- [ ] Implement the screen **Thanks** — route `/thanks`",
		"- [ ] Test the transition **Cart** --[click: Pay]--> **Payment**",
		"`// flow:t-pay`",
		"Total open tasks:",
	} {
		if !strings.Contains(out, s) {
			t.Errorf("tasks without %q:\n%s", s, out)
		}
	}
	if strings.Contains(out, "Implement the screen **Home**") || strings.Contains(out, "`// flow:t-login`") {
		t.Errorf("tasks lists things already covered:\n%s", out)
	}

	// Without coverage: only the graph issues.
	d2 := newTDoc().node("a", "A").flow("f", "F", "a")
	got := Tasks(d2.Document, "", nil)
	if !strings.Contains(got, "Fix the graph (`empty`)") {
		t.Errorf("tasks without coverage:\n%s", got)
	}
	// Everything covered.
	d3 := newTDoc().node("a", "A", MetaStatus, StatusTested).node("b", "B", MetaKind, KindEnd, MetaStatus, StatusTested).flow("f", "F", "a")
	d3.tr("t", "f", "a", "b", "", "click")
	r3 := t.TempDir()
	write(t, r3, "x.spec.ts", "// flow:t")
	cov3, _ := Coverage(d3.Document, "", r3)
	if got := Tasks(d3.Document, "", cov3); !strings.Contains(got, "everything covered") {
		t.Errorf("expected everything covered:\n%s", got)
	}
}
