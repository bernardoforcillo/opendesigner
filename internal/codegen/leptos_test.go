package codegen_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

// dumpLeptos writes a generated project under $LEPTOS_OUT/<name> when that variable is set, so the
// output can be type-checked by a real Rust toolchain (`cargo check` inside that directory).
func dumpLeptos(t *testing.T, name string, out *codegen.Output) {
	t.Helper()
	root := os.Getenv("LEPTOS_OUT")
	if root == "" {
		return
	}
	for _, f := range out.Files {
		p := filepath.Join(root, name, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, f.Content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestLeptosCompiles type-checks generated projects with a real Rust toolchain. It downloads and builds
// leptos, so it only runs on request: OD_CARGO_CHECK=1 go test ./internal/codegen -run LeptosCompiles
// (OD_CARGO_TARGET=<dir> keeps the build cache between runs).
func TestLeptosCompiles(t *testing.T) {
	if os.Getenv("OD_CARGO_CHECK") == "" {
		t.Skip("set OD_CARGO_CHECK=1 to run `cargo check` on the generated projects")
	}
	cargo, err := exec.LookPath("cargo")
	if err != nil {
		t.Skip("no cargo on PATH")
	}
	target := os.Getenv("OD_CARGO_TARGET")
	if target == "" {
		target = t.TempDir()
	}
	for name, doc := range map[string]*opendesignerv1.Document{"shop": Shop(), "props": propsDoc(), "card": cardDoc()} {
		out := gen(t, doc, codegen.TargetLeptos, nil)
		dir := filepath.Join(t.TempDir(), name)
		if _, err := codegen.WriteFiles(out, dir, true); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(cargo, "check", "--quiet")
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "CARGO_TARGET_DIR="+target, "RUSTFLAGS=-D warnings")
		if msg, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("%s: cargo check failed: %v\n%s", name, err, msg)
		}
	}
}

func TestLeptosShopProject(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetLeptos, nil)
	dumpLeptos(t, "shop", out)
	var paths []string
	for _, f := range out.Files {
		paths = append(paths, f.Path)
	}
	for _, want := range []string{"Cargo.toml", "index.html", "src/main.rs", "src/app.rs", "src/screens/mod.rs", "src/screens/login.rs", "tests/flows.spec.ts", "playwright.config.ts", "package.json", "README.md"} {
		file(t, out, want)
	}
	for _, p := range []string{"Cargo.toml", "src/main.rs", "src/app.rs", "src/screens/mod.rs", "src/screens/login.rs", "src/screens/home.rs", "src/screens/detail.rs"} {
		checkGolden(t, "shop-leptos/"+p, file(t, out, p))
	}

	login := string(file(t, out, "src/screens/login.rs"))
	mustContain(t, "login.rs", login,
		"use leptos::prelude::*;",
		"use leptos_router::hooks::use_navigate;",
		"#[component]\npub fn Login() -> impl IntoView {",
		"let navigate = use_navigate();",
		"view! {",
		`data-node-id="`,
		`role="button"`,
		`on:click={let navigate = navigate.clone(); move |_| { navigate("/home", NavigateOptions::default()); }}`,
		`aria-label="Sign in"`,
		"// flow: t1", "// guard: valid credentials",
	)
	// t3 has no element: a visually hidden button in a <nav> at the bottom of the screen's root.
	home := string(file(t, out, "src/screens/home.rs"))
	mustContain(t, "home.rs", home, `<nav style="position: absolute;`, `aria-label="Flow navigation"`, `>"Sign out"</button>`, `navigate("/login"`)

	app := string(file(t, out, "src/app.rs"))
	mustContain(t, "app.rs", app, "use leptos_router::components::{Route, Router, Routes};",
		`<Route path=path!("/login") view=Login />`, `<Route path=path!("/") view=Login />`, "use crate::screens::*;")
	mustContain(t, "Cargo.toml", string(file(t, out, "Cargo.toml")), `leptos = { version = "0.8", features = ["csr"] }`, "leptos_router")
	mustContain(t, "index.html", string(file(t, out, "index.html")), `<link data-trunk rel="rust"`, "box-sizing:border-box")
	mustContain(t, "playwright.config.ts", string(file(t, out, "playwright.config.ts")), "trunk serve --port 5173")
	// The tests are the react target's: same flows, same locators.
	react := gen(t, Shop(), codegen.TargetReact, nil)
	if string(file(t, out, "tests/flows.spec.ts")) != string(file(t, react, "tests/flows.spec.ts")) {
		t.Error("the leptos e2e tests must be the ones generated for the react target")
	}
	if len(out.Warnings) != 0 {
		t.Errorf("warnings: %v", out.Warnings)
	}
}

func TestLeptosCSSIsInlineAndGradientsAreExact(t *testing.T) {
	stops := []Stop{S(0, C(1, 0, 0)), S(1, C(0, 0, 1))}
	doc := screenDoc(func(b *B, s string) {
		b.Add("d", s, "Diamond", 150, 10, 100, 100, Fill(&opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Diamond{Diamond: gradient(0.5, 0.5, 1, 0.5, stops)}}))
		b.Add("t", s, "Label", 10, 10, 100, 20, Text(`He said "hi" {x}`, 14, "400", AlignLeft))
	})
	out := gen(t, doc, codegen.TargetLeptos, nil)
	dumpLeptos(t, "css", out)
	screen := string(file(t, out, "src/screens/screen.rs"))
	mustContain(t, "screen.rs", screen,
		`linear-gradient(45deg,#f00 0%,#00f 50%),linear-gradient(135deg`, "background-size: 50px 50px,50px 50px",
		`"He said \"hi\" {x}"`, // a Rust string literal: quotes escaped, braces left alone
	)
	if strings.Contains(screen, "radial-gradient") {
		t.Errorf("the diamond must be the exact layers:\n%s", screen)
	}
}

func TestLeptosComponents(t *testing.T) {
	out := gen(t, propsDoc(), codegen.TargetLeptos, nil)
	dumpLeptos(t, "props", out)
	comp := string(file(t, out, "src/components/button.rs"))
	mustContain(t, "button.rs", comp,
		"#[component]\npub fn Button(",
		"/// Size: S | L", // the axis, documented
		`#[prop(into, default = "S".to_string())] size: String,`,
		`#[prop(into, default = "Click".to_string())] label: String,`,
		"/// Icon (show/hide)\n    #[prop(default = false)] icon: bool,",
		`match format!("{}|{}", size, default_prop).as_str() {`, // `default` is not a keyword in Rust, `type` etc. are
		`"L|yes" => {`,
		"{icon.then(|| view! {",
		"{label.clone()}",
		"_ => ().into_any(),",
	)
	if strings.Contains(comp, "Master ma") {
		t.Errorf("a property-driven text must print the prop:\n%s", comp)
	}
	screen := string(file(t, out, "src/screens/home.rs"))
	mustContain(t, "home.rs", screen, "use crate::components::Button;", "<Button />", `<Button size="L" label="Buy" icon=true />`)
	if strings.Count(screen, "<Button") != 2 || !strings.Contains(screen, "i3/ma") {
		t.Errorf("i1 and i2 call the component, i3 (an override) stays inline:\n%s", screen)
	}
	mustContain(t, "components/mod.rs", string(file(t, out, "src/components/mod.rs")), "mod button;", "pub use button::Button;")

	card := gen(t, cardDoc(), codegen.TargetLeptos, nil)
	dumpLeptos(t, "card", card)
	c := string(file(t, card, "src/components/card.rs"))
	mustContain(t, "card.rs", c,
		`#[prop(into, default = "Info".to_string())] tone: String,`,
		"#[prop(default = 4.0)] radius: f64,",
		"#[prop(default = 1.0)] fade: f64,",
		"#[prop(optional)] icon: Option<ViewFn>,",
		"match &icon {", "Some(f) => f.run().into_any(),",
		`format!("`, "border-radius: {}px", "opacity: {}",
	)
	home := string(file(t, card, "src/screens/home.rs"))
	mustContain(t, "home.rs", home, "<Card\n                    tone=\"Warn\"\n                    radius=20.0\n                    fade=0.5\n                    icon=ViewFn::from(|| view! {")
}

// Key triggers are a window listener removed with the component, back goes back in the browser history
// (as a hidden button), and a key without a label stays a comment.
func TestLeptosKeyAndBackWiring(t *testing.T) {
	b := New("d", "Edges")
	b.Add("index", "page1", "Index", 0, 0, 200, 200, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("btn", "index", "Back button", 10, 10, 50, 50, Rect(0), Fill(Solid(C(1, 0, 0))))
	b.Add("other", "page1", "Other", 500, 0, 200, 200, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Flow("f", "F", "index")
	b.Transition(&opendesignerv1.Transition{Id: "k1", FlowId: "f", FromId: "index", ToId: "other", Trigger: "key", Label: "Enter", Guard: "ready", Order: 2})
	b.Transition(&opendesignerv1.Transition{Id: "k2", FlowId: "f", FromId: "index", ToId: "other", Trigger: "key"})
	b.Transition(&opendesignerv1.Transition{Id: "b1", FlowId: "f", FromId: "other", ToId: "index", Trigger: "back", Label: "Back"})
	b.Transition(&opendesignerv1.Transition{Id: "c1", FlowId: "f", FromId: "index", ToId: "other", Trigger: "click", ElementId: "btn", Label: "Next"})
	b.Transition(&opendesignerv1.Transition{Id: "a1", FlowId: "f", FromId: "other", ToId: "index", Trigger: "auto", DelayMs: 100})
	out := gen(t, b.Doc, codegen.TargetLeptos, nil)
	dumpLeptos(t, "edges", out)
	index := string(file(t, out, "src/screens/index.rs"))
	mustContain(t, "index.rs", index,
		"window_event_listener(leptos::ev::keydown, move |e| {",
		`if e.key() == "Enter" {`, `navigate("/other", NavigateOptions::default());`,
		"on_cleanup(move || handle.remove());",
		"// chain: position 2 (if / else if / else)",
		`on:click={let navigate = navigate.clone(); move |_| { navigate("/other", NavigateOptions::default()); }}`,
		`on:keydown={let navigate = navigate.clone(); move |ev: web_sys::KeyboardEvent| { if ev.key() == "Enter" {`,
	)
	if strings.Contains(index, `e.key() == ""`) {
		t.Errorf("a key without a label must not be wired:\n%s", index)
	}
	other := string(file(t, out, "src/screens/other.rs"))
	mustContain(t, "other.rs", other, `window().history().and_then(|h| h.back())`, ">\"Back\"</button>", "auto trigger: to be wired")
	if strings.Contains(other, "use_navigate") {
		t.Errorf("a screen that only goes back needs no navigate:\n%s", other)
	}
}

func TestLeptosAvoidsFrameworkNames(t *testing.T) {
	doc := buttonDoc()
	doc.Nodes["s"].Name = "Show" // a screen named like a Leptos component
	out := gen(t, doc, codegen.TargetLeptos, nil)
	file(t, out, "src/screens/show_screen.rs")
	mustContain(t, "show_screen.rs", string(file(t, out, "src/screens/show_screen.rs")), "pub fn ShowScreen()")
}

func TestLeptosRoutesAndStartScreen(t *testing.T) {
	doc := Shop()
	doc.Nodes["login"].Meta["code.route"] = "/auth/[mode]"
	out := gen(t, doc, codegen.TargetLeptos, nil)
	app := string(file(t, out, "src/app.rs"))
	mustContain(t, "app.rs", app, `path!("/auth/:mode")`)
	if !strings.Contains(strings.Join(out.Warnings, "\n"), "/auth/[mode]") {
		t.Errorf("a route that had to change is reported: %v", out.Warnings)
	}
}

func TestLeptosOutputIsDeterministic(t *testing.T) {
	a, b := gen(t, cardDoc(), codegen.TargetLeptos, nil), gen(t, cardDoc(), codegen.TargetLeptos, nil)
	if len(a.Files) != len(b.Files) {
		t.Fatal("different file counts")
	}
	for i := range a.Files {
		if a.Files[i].Path != b.Files[i].Path || string(a.Files[i].Content) != string(b.Files[i].Content) {
			t.Errorf("%s differs between runs", a.Files[i].Path)
		}
	}
}

// Images are copied for Trunk and vectors are inline <svg> in the view!, gradient patterns included.
func TestLeptosImagesAndVectors(t *testing.T) {
	doc, assets := Gallery()
	out, err := codegen.Generate(doc, codegen.Options{Target: codegen.TargetLeptos}, codegen.FuncAssets(func(h string) ([]byte, error) {
		if b, ok := assets[h]; ok {
			return b, nil
		}
		return nil, os.ErrNotExist
	}))
	if err != nil {
		t.Fatal(err)
	}
	dumpLeptos(t, "gallery", out)
	var all strings.Builder
	copied := 0
	for _, f := range out.Files {
		all.Write(f.Content)
		if strings.HasPrefix(f.Path, "public/assets/") {
			copied++
		}
	}
	if copied == 0 {
		t.Error("the document's images must be copied to public/assets")
	}
	mustContain(t, "gallery output", all.String(), `<link data-trunk rel="copy-dir" href="public/assets" />`, `<img data-node-id=`, `src="/assets/`, "<svg", "<path", `fill-rule="evenodd"`)

	stops := []Stop{S(0, C(1, 0, 0)), S(1, C(0, 0, 1))}
	tri := Vector(Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(100, 0, 0, 0, 0, 0), Pt(50, 80, 0, 0, 0, 0)))
	vec := gen(t, screenDoc(func(b *B, s string) {
		b.Add("a", s, "Angular", 10, 10, 100, 80, tri, Fill(&opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Angular{Angular: gradient(0.5, 0.5, 1, 0.5, stops)}}))
		b.Add("d", s, "Diamond", 150, 10, 100, 80, tri, Fill(&opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Diamond{Diamond: gradient(0.5, 0.5, 1, 0.5, stops)}}))
	}), codegen.TargetLeptos, nil)
	dumpLeptos(t, "patterns", vec)
	screen := string(file(t, vec, "src/screens/screen.rs"))
	mustContain(t, "screen.rs", screen, "<pattern", "<linearGradient", `shape-rendering="crispEdges"`, `fill="url(#g-a)"`)
}

func TestLeptosReportsAnimationClips(t *testing.T) {
	out := gen(t, AnimDemo(), codegen.TargetLeptos, nil)
	dumpLeptos(t, "anim", out)
	if !strings.Contains(strings.Join(out.Warnings, "\n"), "animation clips are not exported") {
		t.Errorf("animation clips are not exported and must be reported: %v", out.Warnings)
	}
}
