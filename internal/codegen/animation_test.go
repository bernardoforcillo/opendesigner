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

// The animation goldens: the same document (samples.AnimDemo) in the two
// targets. The react one is the screen with the variant constants; the html
// one is the CSS with @keyframes. Run with -update and review the diff after
// every change.
func TestGoldenAnimation(t *testing.T) {
	rout := gen(t, AnimDemo(), codegen.TargetReact, nil)
	for _, p := range []string{"src/screens/Animations.tsx", "package.json", "README.md"} {
		checkGolden(t, "anim-react/"+p, file(t, rout, p))
	}
	hout := gen(t, AnimDemo(), codegen.TargetHTML, nil)
	checkGolden(t, "anim-html/animations.html", file(t, hout, "animations.html"))
}

func TestAnimationDeterministic(t *testing.T) {
	for _, target := range []codegen.Target{codegen.TargetHTML, codegen.TargetReact} {
		first := gen(t, AnimDemo(), target, nil)
		for i := 0; i < 5; i++ {
			again := gen(t, AnimDemo(), target, nil)
			for j := range first.Files {
				if !bytes.Equal(first.Files[j].Content, again.Files[j].Content) {
					t.Fatalf("%s: %s is not deterministic", target, first.Files[j].Path)
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
		t.Fatal("Generate modified the document")
	}
}

// Without clips the export is the same as before: no Motion, no motion.*.
func TestNoClipsNoMotion(t *testing.T) {
	out := gen(t, Shop(), codegen.TargetReact, nil)
	if bytes.Contains(file(t, out, "package.json"), []byte("motion")) {
		t.Fatal("package.json mentions motion in a document without clips")
	}
	for _, f := range out.Files {
		if strings.Contains(string(f.Content), "motion") && f.Path != "README.md" {
			t.Fatalf("%s mentions motion without clips", f.Path)
		}
	}
	if strings.Contains(string(file(t, out, "README.md")), "Animations") {
		t.Fatal("README with the Animations section without clips")
	}
}

func animScreen(clips func(b *B)) *opendesignerv1.Document {
	b := New("d", "Test")
	b.Add("scr", "page1", "Screen", 0, 0, 400, 300, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("a", "scr", "Box", 10, 20, 50, 50, Fill(Solid(C(1, 0, 0))), Rot(10))
	b.Add("b", "scr", "Other", 100, 20, 50, 50, Fill(Solid(C(0, 1, 0))))
	clips(b)
	return b.Doc
}

func clip(id, trigger, target string, dur float64, tracks ...*opendesignerv1.Track) *opendesignerv1.Clip {
	return &opendesignerv1.Clip{Id: id, Name: id, Trigger: trigger, TargetId: target, Duration: dur, Tracks: tracks}
}

func TestReactMapping(t *testing.T) {
	doc := animScreen(func(b *B) {
		// x/y delta from the node's x/y (10, 20); rotate delta from 10; times and ease per segment;
		// finite repeat with yoyo
		c := clip("c1", "enter", "scr", 1000,
			Tr("a", "x", KF(100, 10, "easeIn"), KF(600, 60, "cubic-bezier(.1,.2,.3,.4)"), KF(1000, 10, "")),
			Tr("a", "y", KF(0, 20, ""), KF(1000, 70, "")),
			Tr("a", "rotation", KF(0, 10, ""), KF(1000, 100, "")),
			Tr("a", "scale", KF(0, 1, ""), KF(1000, 2, "")),
			Tr("a", "opacity", KF(0, 0.5, "")), // a single keyframe: constant
		)
		c.Delay, c.Repeat, c.Yoyo = 250, 3, true
		b.Clip(c)
	})
	src := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/screens/Screen.tsx"))
	for _, want := range []string{
		`import { motion, type Variants } from "motion/react";`,
		"const boxVariants: Variants = {",
		// the first keyframe is not at 0: initial hold at 0 (the first's value, delta 0)
		"x: [0, 0, 50, 0],",
		"times: [0, 0.1, 0.6, 1]",
		`ease: ["linear", "easeIn", [0.1, 0.2, 0.3, 0.4]]`,
		"y: [0, 50],",
		"rotate: [0, 90],",
		"scale: [1, 2],",
		"opacity: 0.5,", // constant: no transition
		"delay: 0.25", "repeat: 3", `repeatType: "reverse"`, "duration: 1,",
		`initial: { x: 0, y: 0, rotate: 0, scale: 1, opacity: 0.5 }`,
		`initial="initial"`, `animate="animate"`, "variants={boxVariants}",
		"<motion.div", "</motion.div>",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing %q in:\n%s", want, src)
		}
	}
	if strings.Contains(src, "opacity: { duration") {
		t.Error("a constant track must not have a transition")
	}
	// the base rotation stays in the class: Motion composes with it
	if !strings.Contains(src, "rotate-[10deg]") {
		t.Error("the base rotation must stay in className")
	}
}

func TestReactTriggers(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Clip(clip("h", "hover", "scr", 200, Tr("a", "scale", KF(0, 1, ""), KF(200, 1.1, ""))))
		b.Clip(clip("t", "tap", "a", 100, Tr("a", "scale", KF(0, 1, ""), KF(100, 0.9, ""))))
		b.Clip(clip("l", "loop", "b", 500, Tr("b", "rotation", KF(0, 0, ""), KF(500, 360, "linear"))))
		b.Clip(clip("m", "", "scr", 300, Tr("b", "opacity", KF(0, 1, ""), KF(300, 0, ""))))
	})
	src := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/screens/Screen.tsx"))
	for _, want := range []string{
		`whileHover="hover"`, `whileTap="tap"`,
		"repeat: Infinity", `repeatType: "loop"`, // loop without yoyo
		"hover: {", "tap: {",
		`animate="m"`, // the comment on the manual clip's target
		"m: {",        // the manual variant has the clip's name
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing %q in:\n%s", want, src)
		}
	}
	// The manual clip fires nothing by itself: no label uses it
	if strings.Contains(src, `animate="m"`) && !strings.Contains(src, `// manual clip "m"`) {
		t.Error("the manual clip must only be documented")
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
	src := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
	for _, want := range []string{
		"@property --od-x", "@property --od-y",
		"translate: var(--od-x) var(--od-y)",
		// 4 iterations (repeat 3 + 1), alternate (yoyo), delay 250, fill both
		"250ms 4 alternate both",
		"@keyframes box-2-animate-x",
		"0% { --od-x:0px;animation-timing-function:linear }",
		"10% { --od-x:0px;animation-timing-function:ease-in }",
		"60% { --od-x:50px;animation-timing-function:cubic-bezier(0.1,0.2,0.3,0.4) }",
		"60.0001% { --od-x:30px;animation-timing-function:linear }", // the jump does not merge
		"100% { --od-x:0px }",
		"0% { rotate:0deg;animation-timing-function:cubic-bezier(0.32,0.66,0.1,1) }", // spring
		"100% { rotate:90deg }",
		// hover/tap on the target (which is the element itself): the same element, no descendant
		".box-2:hover {", ".box-2:active {",
		"opacity:0.5", "animation-timing-function:ease-in-out",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing %q in:\n%s", want, src)
		}
	}
	// the tap animation repeats the hover one (otherwise removing it replays it)
	i := strings.Index(src, ".box-2:active {")
	rule := src[i : i+strings.Index(src[i:], "}")]
	if !strings.Contains(rule, "hover-opacity") || !strings.Contains(rule, "tap-scale") || !strings.Contains(rule, "animate-x") {
		t.Errorf("the :active rule must repeat the base and hover animations: %s", rule)
	}
}

func TestDrawVectorAndPathLength(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Add("v", "scr", "Mark", 0, 0, 100, 50, Vector(Sub(false, Pt(0, 0, 0, 0, 0, 0), Pt(100, 50, 0, 0, 0, 0))), Fill(Solid(C(0, 0, 0))))
		b.Clip(clip("d", "enter", "scr", 500, Tr("v", "draw", KF(0, 0, ""), KF(500, 1, ""))))
	})
	react := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/screens/Screen.tsx"))
	for _, want := range []string{
		"const markStrokeVariants: Variants", "initial: { pathLength: 0 }", "pathLength: [0, 1],",
		"<motion.path", "variants={markStrokeVariants}",
	} {
		if !strings.Contains(react, want) {
			t.Errorf("react: missing %q in:\n%s", want, react)
		}
	}
	// the <svg> stays a normal element (the path is the animated element)
	if strings.Contains(react, "<motion.svg") {
		t.Error("the svg must not become motion.svg if only the path animates")
	}
	html := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
	for _, want := range []string{`pathLength="1"`, "stroke-dasharray:0 1", "stroke-dasharray:1 1"} {
		if !strings.Contains(html, want) {
			t.Errorf("html: missing %q", want)
		}
	}
}

func TestAnimationWarnings(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Add("g", "scr", "Group", 0, 0, 0, 0, Group())
		b.Add("in", "g", "Inside", 0, 0, 10, 10)
		// track OUTSIDE the target; draw on a rectangle; clip with target in another screen
		b.Clip(clip("w", "enter", "g",
			500, Tr("a", "opacity", KF(0, 0, ""), KF(500, 1, "")),
			Tr("in", "draw", KF(0, 0, ""), KF(500, 1, "")),
			Tr("in", "opacity", KF(0, 0, ""), KF(500, 1, ""))))
	})
	out := gen(t, doc, codegen.TargetReact, nil)
	joined := strings.Join(out.Warnings, "\n")
	for _, want := range []string{"is not inside the target", "is not a vector"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing warning %q in:\n%s", want, joined)
		}
	}
	src := string(file(t, out, "src/screens/Screen.tsx"))
	if strings.Contains(src, "boxVariants") {
		t.Error("the track outside the target must not be emitted")
	}
	if !strings.Contains(src, "insideVariants") {
		t.Error("the track inside the target must be emitted")
	}
}

// A clip whose target is in ONE screen does not touch the others.
func TestAnimationScopedToScreen(t *testing.T) {
	b := New("d", "Two")
	b.Add("s1", "page1", "One", 0, 0, 100, 100, Frame(false, nil))
	b.Add("r1", "s1", "Sq", 0, 0, 10, 10)
	b.Add("s2", "page1", "Two", 200, 0, 100, 100, Frame(false, nil))
	b.Add("r2", "s2", "Sq", 0, 0, 10, 10)
	b.Clip(clip("c", "enter", "s1", 100, Tr("r1", "opacity", KF(0, 0, ""), KF(100, 1, ""))))
	out := gen(t, b.Doc, codegen.TargetReact, nil)
	if !strings.Contains(string(file(t, out, "src/screens/One.tsx")), "motion.div") {
		t.Error("screen One must animate")
	}
	if strings.Contains(string(file(t, out, "src/screens/Two.tsx")), "motion") {
		t.Error("screen Two has no clips")
	}
}

func TestManualClipHTML(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Clip(clip("m", "manual", "scr", 300, Tr("b", "opacity", KF(0, 1, ""), KF(300, 0, ""))))
	})
	src := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
	// it starts by adding the class `m` to the target
	if !strings.Contains(src, ".screen-1.m .other-3 {") {
		t.Errorf("missing the manual rule in:\n%s", src)
	}
}

// A vector imported from SVG carries a REAL stroke and the style meta: the
// exported code must honour them like the canvas (stroke colour and weight,
// caps, joins, dashes, fill rule), not fall back to the 1.5px hairline.
func TestVectorRealStrokeAndMeta(t *testing.T) {
	doc := animScreen(func(b *B) {
		b.Add("v", "scr", "Icon", 0, 0, 100, 50,
			Vector(Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(100, 0, 0, 0, 0, 0), Pt(50, 50, 0, 0, 0, 0))),
			Fill(Solid(C(1, 0, 0))),
			StrokeOpt(6, Center, Solid(C(0, 0, 1))),
			Meta("stroke.cap", "round", "stroke.join", "bevel", "stroke.dash", "4,2", "vector.fillRule", "nonzero"),
		)
	})
	html := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
	for _, want := range []string{
		`stroke-width="6"`, `stroke-linecap="round"`, `stroke-linejoin="bevel"`,
		`stroke-dasharray="4 2"`, `fill-rule="nonzero"`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q in:\n%s", want, html)
		}
	}
	if strings.Contains(html, `stroke-width="1.5"`) {
		t.Error("with a real stroke the 1.5px hairline must not appear")
	}
}
