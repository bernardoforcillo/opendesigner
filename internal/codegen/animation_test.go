package codegen_test

import (
	"bytes"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"google.golang.org/protobuf/proto"
)

// I golden dell'animazione: lo stesso documento (samples.AnimDemo) nei due
// target. Il react è la schermata con le costanti delle varianti; l'html il CSS
// con @keyframes. Eseguire con -update e rivedere il diff dopo ogni modifica.
func TestGoldenAnimation(t *testing.T) {
	rout := gen(t, AnimDemo(), codegen.TargetReact, nil)
	for _, p := range []string{"src/screens/Animazioni.tsx", "package.json", "README.md"} {
		checkGolden(t, "anim-react/"+p, file(t, rout, p))
	}
	hout := gen(t, AnimDemo(), codegen.TargetHTML, nil)
	checkGolden(t, "anim-html/animazioni.html", file(t, hout, "animazioni.html"))
}

func TestAnimationDeterministic(t *testing.T) {
	for _, target := range []codegen.Target{codegen.TargetHTML, codegen.TargetReact} {
		first := gen(t, AnimDemo(), target, nil)
		for i := 0; i < 5; i++ {
			again := gen(t, AnimDemo(), target, nil)
			for j := range first.Files {
				if !bytes.Equal(first.Files[j].Content, again.Files[j].Content) {
					t.Fatalf("%s: %s non è deterministico", target, first.Files[j].Path)
				}
			}
		}
	}
}

func TestAnimationDoesNotMutateDocument(t *testing.T) {
	doc := AnimDemo()
	before := proto.Clone(doc)
	gen(t, doc, codegen.TargetReact, nil)
	gen(t, doc, codegen.TargetHTML, nil)
	if !proto.Equal(before, doc) {
		t.Fatal("Generate ha modificato il documento")
	}
}

// Senza clip l'export è quello di prima: niente Motion, niente motion.*.
func TestNoClipsNoMotion(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	if bytes.Contains(file(t, out, "package.json"), []byte("motion")) {
		t.Fatal("package.json cita motion in un documento senza clip")
	}
	for _, f := range out.Files {
		if strings.Contains(string(f.Content), "motion") && f.Path != "README.md" {
			t.Fatalf("%s cita motion senza clip", f.Path)
		}
	}
	if strings.Contains(string(file(t, out, "README.md")), "Animazioni") {
		t.Fatal("README con la sezione Animazioni senza clip")
	}
}

func animScreen(clips func(b *B)) *opendesignerv1.Document {
	b := New("d", "Prova")
	b.Add("scr", "page1", "Schermata", 0, 0, 400, 300, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("a", "scr", "Scatola", 10, 20, 50, 50, Fill(Solid(C(1, 0, 0))), Rot(10))
	b.Add("b", "scr", "Altra", 100, 20, 50, 50, Fill(Solid(C(0, 1, 0))))
	clips(b)
	return b.Doc
}

func clip(id, trigger, target string, dur float64, tracks ...*opendesignerv1.Track) *opendesignerv1.Clip {
	return &opendesignerv1.Clip{Id: id, Name: id, Trigger: trigger, TargetId: target, Duration: dur, Tracks: tracks}
}

func TestReactMapping(t *testing.T) {
	doc := animScreen(func(b *B) {
		// x/y delta da x/y del nodo (10, 20); rotate delta da 10; times e ease per segmento;
		// repeat finito con yoyo
		c := clip("c1", "enter", "scr", 1000,
			Tr("a", "x", KF(100, 10, "easeIn"), KF(600, 60, "cubic-bezier(.1,.2,.3,.4)"), KF(1000, 10, "")),
			Tr("a", "y", KF(0, 20, ""), KF(1000, 70, "")),
			Tr("a", "rotation", KF(0, 10, ""), KF(1000, 100, "")),
			Tr("a", "scale", KF(0, 1, ""), KF(1000, 2, "")),
			Tr("a", "opacity", KF(0, 0.5, "")), // un solo keyframe: costante
		)
		c.Delay, c.Repeat, c.Yoyo = 250, 3, true
		b.Clip(c)
	})
	src := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/screens/Schermata.tsx"))
	for _, want := range []string{
		`import { motion, type Variants } from "motion/react";`,
		"const scatolaVariants: Variants = {",
		// il primo keyframe non e' a 0: hold iniziale a 0 (valore del primo, delta 0)
		"x: [0, 0, 50, 0],",
		"times: [0, 0.1, 0.6, 1]",
		`ease: ["linear", "easeIn", [0.1, 0.2, 0.3, 0.4]]`,
		"y: [0, 50],",
		"rotate: [0, 90],",
		"scale: [1, 2],",
		"opacity: 0.5,", // costante: nessuna transition
		"delay: 0.25", "repeat: 3", `repeatType: "reverse"`, "duration: 1,",
		`initial: { x: 0, y: 0, rotate: 0, scale: 1, opacity: 0.5 }`,
		`initial="initial"`, `animate="animate"`, "variants={scatolaVariants}",
		"<motion.div", "</motion.div>",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("manca %q in:\n%s", want, src)
		}
	}
	if strings.Contains(src, "opacity: { duration") {
		t.Error("una traccia costante non deve avere transition")
	}
	// la rotazione di base resta nella classe: Motion compone con essa
	if !strings.Contains(src, "rotate-[10deg]") {
		t.Error("la rotazione di base deve restare in className")
	}
}

func TestReactTriggers(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Clip(clip("h", "hover", "scr", 200, Tr("a", "scale", KF(0, 1, ""), KF(200, 1.1, ""))))
		b.Clip(clip("t", "tap", "a", 100, Tr("a", "scale", KF(0, 1, ""), KF(100, 0.9, ""))))
		b.Clip(clip("l", "loop", "b", 500, Tr("b", "rotation", KF(0, 0, ""), KF(500, 360, "linear"))))
		b.Clip(clip("m", "", "scr", 300, Tr("b", "opacity", KF(0, 1, ""), KF(300, 0, ""))))
	})
	src := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/screens/Schermata.tsx"))
	for _, want := range []string{
		`whileHover="hover"`, `whileTap="tap"`,
		"repeat: Infinity", `repeatType: "loop"`, // loop senza yoyo
		"hover: {", "tap: {",
		`animate="m"`, // il commento sul target della clip manuale
		"m: {",        // la variante manuale ha il nome della clip
	} {
		if !strings.Contains(src, want) {
			t.Errorf("manca %q in:\n%s", want, src)
		}
	}
	// La clip manuale non innesca nulla da sola: nessuna etichetta la usa
	if strings.Contains(src, `animate="m"`) && !strings.Contains(src, `// clip manuale "m"`) {
		t.Error("la clip manuale va solo documentata")
	}
}

func TestHTMLMapping(t *testing.T) {
	doc := animScreen(func(b *B) {
		c := clip("c1", "enter", "scr", 1000,
			Tr("a", "x", KF(100, 10, "easeIn"), KF(600, 60, "cubic-bezier(.1,.2,.3,.4)"), KF(600, 40, ""), KF(1000, 10, "")),
			Tr("a", "rotation", KF(0, 10, "spring"), KF(1000, 100, "")),
		)
		c.Delay, c.Repeat, c.Yoyo = 250, 3, true
		b.Clip(c)
		b.Clip(clip("h", "hover", "a", 200, Tr("a", "opacity", KF(0, 1, "easeInOut"), KF(200, 0.5, ""))))
		b.Clip(clip("p", "tap", "a", 100, Tr("a", "scale", KF(0, 1, ""), KF(100, 0.9, ""))))
	})
	src := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "schermata.html"))
	for _, want := range []string{
		"@property --od-x", "@property --od-y",
		"translate: var(--od-x) var(--od-y)",
		// 4 iterazioni (repeat 3 + 1), alternate (yoyo), ritardo 250, fill both
		"250ms 4 alternate both",
		"@keyframes scatola-2-animate-x",
		"0% { --od-x:0px;animation-timing-function:linear }",
		"10% { --od-x:0px;animation-timing-function:ease-in }",
		"60% { --od-x:50px;animation-timing-function:cubic-bezier(0.1,0.2,0.3,0.4) }",
		"60.0001% { --od-x:30px;animation-timing-function:linear }", // lo scatto non si fonde
		"100% { --od-x:0px }",
		"0% { rotate:0deg;animation-timing-function:cubic-bezier(0.32,0.66,0.1,1) }", // spring
		"100% { rotate:90deg }",
		// hover/tap sul target (che e' l'elemento stesso): lo stesso elemento, nessun discendente
		".scatola-2:hover {", ".scatola-2:active {",
		"opacity:0.5", "animation-timing-function:ease-in-out",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("manca %q in:\n%s", want, src)
		}
	}
	// l'animazione di tap ripete quella di hover (altrimenti toglierla la rilancia)
	i := strings.Index(src, ".scatola-2:active {")
	rule := src[i : i+strings.Index(src[i:], "}")]
	if !strings.Contains(rule, "hover-opacity") || !strings.Contains(rule, "tap-scale") || !strings.Contains(rule, "animate-x") {
		t.Errorf("la regola :active deve ripetere le animazioni di base e di hover: %s", rule)
	}
}

func TestDrawVectorAndPathLength(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Add("v", "scr", "Segno", 0, 0, 100, 50, Vector(Sub(false, Pt(0, 0, 0, 0, 0, 0), Pt(100, 50, 0, 0, 0, 0))), Fill(Solid(C(0, 0, 0))))
		b.Clip(clip("d", "enter", "scr", 500, Tr("v", "draw", KF(0, 0, ""), KF(500, 1, ""))))
	})
	react := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/screens/Schermata.tsx"))
	for _, want := range []string{
		"const segnoTrattoVariants: Variants", "initial: { pathLength: 0 }", "pathLength: [0, 1],",
		"<motion.path", "variants={segnoTrattoVariants}",
	} {
		if !strings.Contains(react, want) {
			t.Errorf("react: manca %q in:\n%s", want, react)
		}
	}
	// l'<svg> resta un elemento normale (il path e' l'elemento animato)
	if strings.Contains(react, "<motion.svg") {
		t.Error("l'svg non deve diventare motion.svg se solo il path si anima")
	}
	html := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "schermata.html"))
	for _, want := range []string{`pathLength="1"`, "stroke-dasharray:0 1", "stroke-dasharray:1 1"} {
		if !strings.Contains(html, want) {
			t.Errorf("html: manca %q", want)
		}
	}
}

func TestAnimationWarnings(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Add("g", "scr", "Gruppo", 0, 0, 0, 0, Group())
		b.Add("in", "g", "Dentro", 0, 0, 10, 10)
		// traccia FUORI dal target; draw su un rettangolo; clip con target in un'altra schermata
		b.Clip(clip("w", "enter", "g",
			500, Tr("a", "opacity", KF(0, 0, ""), KF(500, 1, "")),
			Tr("in", "draw", KF(0, 0, ""), KF(500, 1, "")),
			Tr("in", "opacity", KF(0, 0, ""), KF(500, 1, ""))))
	})
	out := gen(t, doc, codegen.TargetReact, nil)
	joined := strings.Join(out.Warnings, "\n")
	for _, want := range []string{"non è dentro il target", "non è un vettoriale"} {
		if !strings.Contains(joined, want) {
			t.Errorf("manca il warning %q in:\n%s", want, joined)
		}
	}
	src := string(file(t, out, "src/screens/Schermata.tsx"))
	if strings.Contains(src, "scatolaVariants") {
		t.Error("la traccia fuori dal target non va emessa")
	}
	if !strings.Contains(src, "dentroVariants") {
		t.Error("la traccia dentro il target va emessa")
	}
}

// Una clip il cui target sta in UNA schermata non tocca le altre.
func TestAnimationScopedToScreen(t *testing.T) {
	b := New("d", "Due")
	b.Add("s1", "page1", "Uno", 0, 0, 100, 100, Frame(false, nil))
	b.Add("r1", "s1", "Sq", 0, 0, 10, 10)
	b.Add("s2", "page1", "Due", 200, 0, 100, 100, Frame(false, nil))
	b.Add("r2", "s2", "Sq", 0, 0, 10, 10)
	b.Clip(clip("c", "enter", "s1", 100, Tr("r1", "opacity", KF(0, 0, ""), KF(100, 1, ""))))
	out := gen(t, b.Doc, codegen.TargetReact, nil)
	if !strings.Contains(string(file(t, out, "src/screens/Uno.tsx")), "motion.div") {
		t.Error("la schermata Uno deve animare")
	}
	if strings.Contains(string(file(t, out, "src/screens/Due.tsx")), "motion") {
		t.Error("la schermata Due non ha clip")
	}
}

func TestManualClipHTML(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Clip(clip("m", "manual", "scr", 300, Tr("b", "opacity", KF(0, 1, ""), KF(300, 0, ""))))
	})
	src := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "schermata.html"))
	// si avvia aggiungendo la classe `m` al target
	if !strings.Contains(src, ".schermata-1.m .altra-3 {") {
		t.Errorf("manca la regola manuale in:\n%s", src)
	}
}
