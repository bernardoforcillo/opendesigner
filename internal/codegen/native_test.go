package codegen_test

import (
	"os"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

// nativeDoc: one screen with an auto layout card (gradient, radius, shadow,
// stroke), a text, an ellipse and a free rectangle -- the same content for both
// native targets.
func nativeDoc() *opendesignerv1.Document {
	red, blue, grey := C(0.9, 0.3, 0.3), C(0.2, 0.4, 0.9), C(0.9, 0.9, 0.9)
	return screenDoc(func(b *B, s string) {
		b.Add("card", s, "Card", 20, 20, 300, 120,
			Frame(true, Layout(true, 8, 16, 12, 16, 12, ACenter, AStart, false, false)),
			Fill(Linear(0, 0, 1, 1, S(0, red), S(1, blue))), Shadow(C(0, 0, 0), 0, 4, 8))
		b.Add("title", "card", "Title", 0, 0, 200, 19, Fill(Solid(C(1, 1, 1))), Text("Hello world", 20, "700", AlignLeft))
		b.Add("dot", "card", "Dot", 0, 0, 24, 24, Ellipse(), Fill(Solid(grey)))
		b.Add("free", s, "Free", 40, 180, 100, 50, Rect(12), Fill(Solid(red)), StrokeOpt(2, Inside, Solid(blue)))
	})
}

func TestSwiftUIScreen(t *testing.T) {
	out := gen(t, nativeDoc(), codegen.TargetSwiftUI, nil)
	src := string(file(t, out, "Sources/Screens/Screen.swift"))
	checkGolden(t, "native/Screen.swift", []byte(src))
	for _, want := range []string{
		"import SwiftUI",
		"struct Screen: View {",
		`VStack(alignment: .leading, spacing: 8) {`,
		"LinearGradient(stops:",
		`.shadow(color:`,
		`Text("Hello world")`,
		`.font(.custom("Inter", size: 20).weight(.bold))`,
		"Ellipse()",
		`.offset(x: 40, y: 180)`,
		`strokeBorder(`,
		`data-node-id="free"`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("Screen.swift lacks %q", want)
		}
	}
}

func TestComposeScreen(t *testing.T) {
	out := gen(t, nativeDoc(), codegen.TargetCompose, nil)
	src := string(file(t, out, "app/src/main/kotlin/design/generated/screens/Screen.kt"))
	checkGolden(t, "native/Screen.kt", []byte(src))
}

func mustContain(t *testing.T, name, src string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(src, w) {
			t.Errorf("%s lacks %q:\n%s", name, w, src)
		}
	}
}

func TestSwiftUIComponents(t *testing.T) {
	out := gen(t, propsDoc(), codegen.TargetSwiftUI, nil)
	// "Button" is a SwiftUI type: the component is renamed.
	comp := string(file(t, out, "Sources/Components/Button2.swift"))
	mustContain(t, "Button2.swift", comp,
		"struct Button2: View {",
		`var size: String = "S"`,
		"/// default: yes | no",
		`var defaultProp: String = "yes"`, // `default` is a Swift keyword
		"/// Label (text)\n    var label: String = \"Click\"",
		"/// Icon (show/hide)\n    var icon: Bool = false",
		`switch "\(size)|\(defaultProp)" {`,
		`case "L|yes":`,
		"if icon {",
		"Text(verbatim: label)",
		"EmptyView()",
	)
	if strings.Contains(comp, "Master ma") {
		t.Errorf("a property-driven text must print the prop:\n%s", comp)
	}
	screen := string(file(t, out, "Sources/Screens/Home.swift"))
	mustContain(t, "Home.swift", screen, "Button2()", `Button2(size: "L", label: "Buy", icon: true)`)
	if strings.Count(screen, "Button2(") != 2 || !strings.Contains(screen, `data-node-id="i3/ma"`) {
		t.Errorf("i1 and i2 call the component, i3 (an override) stays inline:\n%s", screen)
	}

	card := gen(t, cardDoc(), codegen.TargetSwiftUI, nil)
	c := string(file(t, card, "Sources/Components/Card.swift"))
	mustContain(t, "Card.swift", c,
		`var tone: String = "Info"`, "var radius: Double = 4", "var fade: Double = 1",
		"var icon: AnyView? = nil", "if let icon = icon {", "RoundedRectangle(cornerRadius: radius)", ".opacity(fade)")
	home := string(file(t, card, "Sources/Screens/Home.swift"))
	mustContain(t, "Home.swift", home, `Card(tone: "Warn", radius: 20, fade: 0.5, icon: AnyView(`)
}

func TestComposeComponents(t *testing.T) {
	out := gen(t, propsDoc(), codegen.TargetCompose, nil)
	const src = "app/src/main/kotlin/design/generated/"
	comp := string(file(t, out, src+"components/Button2.kt"))
	mustContain(t, "Button2.kt", comp,
		"package design.generated.components",
		"fun Button2(",
		"modifier: Modifier = Modifier",
		`size: String = "S"`,
		`defaultProp: String = "yes"`, // `default` is a Kotlin keyword
		`label: String = "Click"`,
		"icon: Boolean = false",
		`when ("${size}|${defaultProp}") {`,
		`"L|yes" -> {`,
		"if (icon) {",
		"text = label,",
		"modifier = modifier",
		"else -> Unit",
	)
	screen := string(file(t, out, src+"screens/Home.kt"))
	mustContain(t, "Home.kt", screen, "Button2()", `Button2(size = "L", label = "Buy", icon = true)`)

	card := gen(t, cardDoc(), codegen.TargetCompose, nil)
	c := string(file(t, card, src+"components/Card2.kt")) // "Card" is a Compose function
	mustContain(t, "Card2.kt", c,
		"radius: Float = 4f", "fade: Float = 1f", "icon: (@Composable () -> Unit)? = null",
		"RoundedCornerShape(radius.dp)", ".alpha(fade)", "if (icon != null) {")
	home := string(file(t, card, src+"screens/Home.kt"))
	mustContain(t, "Home.kt", home, `Card2(tone = "Warn", radius = 20f, fade = 0.5f, icon = {`)
}

func TestNativeFlowWiring(t *testing.T) {
	sw := gen(t, Shop(), codegen.TargetSwiftUI, nil)
	login := string(file(t, sw, "Sources/Screens/Login.swift"))
	mustContain(t, "Login.swift", login,
		"@EnvironmentObject private var router: Router",
		"Button(action: { router.go(.home) }) {",
		`.accessibilityLabel("Sign in")`,
		"// flow: t1", "// guard: valid credentials",
	)
	detail := string(file(t, sw, "Sources/Screens/Detail.swift"))
	mustContain(t, "Detail.swift", detail, "router.go(.home)")
	// t3 has no element: an accessibility action on the root.
	home := string(file(t, sw, "Sources/Screens/Home.swift"))
	mustContain(t, "Home.swift", home, `.accessibilityAction(named: "Sign out (t3)") { router.go(.login) }`)
	app := string(file(t, sw, "Sources/App.swift"))
	mustContain(t, "App.swift", app, "Login()", "case .detail: Detail()", ".environmentObject(router)")
	mustContain(t, "Router.swift", string(file(t, sw, "Sources/Router.swift")), "case login // /login", "func back()")

	kt := gen(t, Shop(), codegen.TargetCompose, nil)
	const src = "app/src/main/kotlin/design/generated/"
	klogin := string(file(t, kt, src+"screens/Login.kt"))
	mustContain(t, "Login.kt", klogin, `.clickable { onNavigate("Home") }`, "// flow: t1")
	khome := string(file(t, kt, src+"screens/Home.kt"))
	mustContain(t, "Home.kt", khome, `CustomAccessibilityAction("Sign out (t3)") { onNavigate("Login"); true }`)
	mustContain(t, "MainActivity.kt", string(file(t, kt, src+"MainActivity.kt")),
		`startDestination = "Login"`, `composable("Detail") { Detail(onNavigate`)
}

func TestNativeImagesAndVectors(t *testing.T) {
	doc, assets := Gallery()
	for _, tg := range []codegen.Target{codegen.TargetSwiftUI, codegen.TargetCompose} {
		out, err := codegen.Generate(doc, codegen.Options{Target: tg}, codegen.FuncAssets(func(h string) ([]byte, error) {
			if b, ok := assets[h]; ok {
				return b, nil
			}
			return nil, os.ErrNotExist
		}))
		if err != nil {
			t.Fatal(err)
		}
		var images, resources int
		for _, f := range out.Files {
			switch {
			case strings.Contains(f.Path, ".imageset/") && strings.HasSuffix(f.Path, ".png"):
				images++
			case strings.Contains(f.Path, "drawable-nodpi/") && strings.HasSuffix(f.Path, ".png"):
				resources++
			case strings.HasPrefix(f.Path, "assets/"):
				t.Errorf("%s: the builder's staging directory must not leak into the output (%s)", tg, f.Path)
			}
		}
		if tg == codegen.TargetSwiftUI && images == 0 || tg == codegen.TargetCompose && resources == 0 {
			t.Errorf("%s: the document's images must become platform resources", tg)
		}
		var all strings.Builder
		for _, f := range out.Files {
			all.Write(f.Content)
		}
		if tg == codegen.TargetSwiftUI {
			mustContain(t, "swiftui output", all.String(), `Image("img_`, "p.addCurve(to:", "FillStyle(eoFill: true)", "StrokeStyle(")
		} else {
			mustContain(t, "compose output", all.String(), "painterResource(R.drawable.img_", "PathParser().parsePathString(", "PathFillType.EvenOdd", "Stroke(width =")
		}
	}
}

func TestNativeTargetsReportWhatTheyOmit(t *testing.T) {
	doc := nativeDoc()
	doc.Nodes["free"].Effects = append(doc.Nodes["free"].Effects, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_InnerShadow{InnerShadow: &opendesignerv1.InnerShadow{Color: &opendesignerv1.Color{A: 1}, OffsetX: 1, OffsetY: 1, Blur: 2}}})
	out := gen(t, doc, codegen.TargetSwiftUI, nil)
	if !strings.Contains(strings.Join(out.Warnings, "\n"), "inner shadows") {
		t.Errorf("inner shadows are not exported and must be reported: %v", out.Warnings)
	}
	if _, err := codegen.Generate(doc, codegen.Options{Target: "kotlin"}, nil); err == nil || !strings.Contains(err.Error(), "swiftui") {
		t.Errorf("an unknown target must list the valid ones: %v", err)
	}
}

func TestNativeScreensAvoidFrameworkNames(t *testing.T) {
	doc := buttonDoc()
	doc.Nodes["s"].Name = "Text" // a screen named like a SwiftUI / Compose type
	sw := gen(t, doc, codegen.TargetSwiftUI, nil)
	file(t, sw, "Sources/Screens/TextScreen.swift")
	kt := gen(t, doc, codegen.TargetCompose, nil)
	file(t, kt, "app/src/main/kotlin/design/generated/screens/TextScreen.kt")
}

func TestNativeOutputIsDeterministic(t *testing.T) {
	for _, tg := range []codegen.Target{codegen.TargetSwiftUI, codegen.TargetCompose} {
		a, b := gen(t, cardDoc(), tg, nil), gen(t, cardDoc(), tg, nil)
		if len(a.Files) != len(b.Files) {
			t.Fatalf("%s: different file counts", tg)
		}
		for i := range a.Files {
			if a.Files[i].Path != b.Files[i].Path || string(a.Files[i].Content) != string(b.Files[i].Content) {
				t.Errorf("%s: %s differs between runs", tg, a.Files[i].Path)
			}
		}
	}
}
