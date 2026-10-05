package samples

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/png"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// testPNG: 40x30 with four coloured quadrants and a diagonal, so that any
// stretching or rotation of the image is visible.
func testPNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for y := 0; y < 30; y++ {
		for x := 0; x < 40; x++ {
			c := color.RGBA{230, 70, 70, 255}
			switch {
			case x >= 20 && y < 15:
				c = color.RGBA{70, 200, 100, 255}
			case x < 20 && y >= 15:
				c = color.RGBA{70, 120, 230, 255}
			case x >= 20 && y >= 15:
				c = color.RGBA{240, 200, 60, 255}
			}
			if x*3 == y*4 {
				c = color.RGBA{20, 20, 20, 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// Gallery is the pixel-parity document: ten screens (top-level frames) that
// cover everything the export can express in CSS. It returns the document and
// the assets (hash -> bytes).
//
// The screens sit at x = i*1000 on the same page: the editor draws them all on
// the same canvas, and the script crops one at a time.
func Gallery() (*opendesignerv1.Document, map[string][]byte) {
	b := New("gallery", "Gallery")
	white := Fill(Solid(C(1, 1, 1)))
	screenN := 0
	screen := func(id, name string, w, h float64, extra ...Opt) string {
		opts := append([]Opt{Frame(true, nil), white}, extra...)
		b.Add(id, "page1", name, float64(screenN)*1000, 0, w, h, opts...)
		screenN++
		return id
	}
	box := func(id, parent string, x, y float64, opts ...Opt) {
		b.Add(id, parent, id, x, y, 100, 80, append([]Opt{Fill(Solid(C(0.2, 0.45, 0.9)))}, opts...)...)
	}
	red, black, grey := C(0.9, 0.3, 0.3), C(0, 0, 0), C(0.9, 0.9, 0.9)

	// 1. shapes
	s := screen("s_shapes", "Shapes", 700, 260)
	box("rect", s, 30, 30, Fill(Solid(red)))
	box("rrect", s, 160, 30, Rect(18), Fill(Solid(C(0.3, 0.7, 0.4))))
	box("ellipse", s, 290, 30, Ellipse(), Fill(Solid(C(0.95, 0.7, 0.2))))
	box("alpha", s, 420, 30, Fill(Solid(CA(0.5, 0.2, 0.8, 0.5))), Opacity(0.8))
	b.Add("ov1", s, "ov1", 560, 30, 70, 70, Fill(Solid(C(1, 0, 0))), Opacity(0.6))
	b.Add("ov2", s, "ov2", 600, 50, 70, 70, Fill(Solid(C(0, 0, 1))), Opacity(0.6))
	box("clampR", s, 30, 150, Rect(100), Fill(Solid(C(0.5, 0.2, 0.6))))
	box("noFill", s, 160, 150, Fill())
	b.Add("wide", s, "wide", 290, 150, 160, 50, Ellipse(), Fill(Solid(C(0.1, 0.6, 0.6))))
	b.Add("hid", s, "hidden", 480, 150, 100, 80, Hidden())

	// 2. strokes
	s = screen("s_strokes", "Strokes", 700, 380)
	box("strokeC", s, 30, 30, Fill(Solid(grey)), StrokeOpt(8, Center, Solid(black)))
	box("strokeI", s, 160, 30, Fill(Solid(grey)), Rect(14), StrokeOpt(10, Inside, Solid(C(0.8, 0.1, 0.1))))
	box("strokeO", s, 290, 30, Ellipse(), Fill(Solid(grey)), StrokeOpt(10, Outside, Solid(C(0.1, 0.5, 0.2))))
	box("strokeNoFill", s, 420, 30, Fill(), StrokeOpt(3, Center, Solid(black)))
	b.Add("rot", s, "rot", 40, 170, 120, 50, Fill(Solid(C(0.2, 0.2, 0.2))), Rot(30), StrokeOpt(4, Center, Solid(C(1, 0.8, 0))))
	box("two", s, 230, 160, Fill(Solid(grey)), StrokeOpt(6, Inside, Solid(C(0.9, 0.2, 0.2))), StrokeOpt(4, Outside, Solid(C(0.2, 0.2, 0.9))))
	box("halfAlpha", s, 380, 160, Fill(Solid(C(1, 1, 1))), StrokeOpt(12, Center, Solid(CA(0, 0, 0, 0.5))))
	box("roundO", s, 530, 160, Rect(20), Fill(Solid(grey)), StrokeOpt(8, Outside, Solid(C(0.5, 0.1, 0.6))))
	box("thin", s, 30, 280, Fill(Solid(C(1, 1, 1))), StrokeOpt(1, Inside, Solid(black)))
	box("zeroW", s, 160, 280, Fill(Solid(grey)), StrokeOpt(0, Center, Solid(black)))

	// 3. gradients
	s = screen("s_gradients", "Gradients", 700, 300)
	box("lin", s, 30, 30, Fill(Linear(0, 0, 1, 1, S(0, C(1, 0.2, 0.2)), S(1, C(0.2, 0.2, 1)))))
	box("rad", s, 160, 30, Ellipse(), Fill(Radial(0.5, 0.5, 1, 0.5, S(0, C(1, 1, 0.2)), S(1, CA(0.9, 0.1, 0.5, 0)))))
	box("lin3", s, 290, 30, Fill(Linear(0, 0.5, 1, 0.5, S(0, C(0.1, 0.8, 0.3)), S(0.5, C(1, 0.9, 0.1)), S(1, C(0.9, 0.1, 0.1)))))
	box("vert", s, 420, 30, Fill(Linear(0.5, 0, 0.5, 1, S(0, C(0, 0, 0)), S(1, C(1, 1, 1)))))
	b.Add("wideLin", s, "wideLin", 30, 150, 240, 60, Fill(Linear(0, 0, 1, 1, S(0, C(0.9, 0.2, 0.5)), S(1, C(0.2, 0.7, 0.9)))))
	box("partial", s, 300, 150, Fill(Linear(0.25, 0.5, 0.75, 0.5, S(0, C(1, 0, 0)), S(1, C(0, 0, 1)))))
	box("offRad", s, 430, 150, Fill(Radial(0.2, 0.3, 0.9, 0.3, S(0, C(1, 1, 1)), S(1, C(0.1, 0.1, 0.5)))))
	box("rotGrad", s, 560, 150, Rot(20), Fill(Linear(0, 0, 1, 0, S(0, C(0.2, 0.8, 0.2)), S(1, C(0.8, 0.2, 0.8)))))
	b.Add("fg", s, "frameGrad", 30, 240, 200, 40, Frame(false, nil), Fill(Linear(0, 0, 1, 0, S(0, C(0.95, 0.9, 0.5)), S(1, C(0.5, 0.9, 0.95)))))

	// 4. effects
	s = screen("s_effects", "Effects", 700, 300)
	box("shadow", s, 40, 40, Fill(Solid(C(1, 1, 1))), StrokeOpt(1, Center, Solid(C(0.8, 0.8, 0.8))), Shadow(CA(0, 0, 0, 0.5), 6, 10, 16))
	box("blur", s, 190, 40, Fill(Solid(C(0.9, 0.2, 0.5))), Blur(6))
	box("shblur", s, 340, 40, Ellipse(), Fill(Solid(C(0.2, 0.6, 0.9))), Shadow(CA(0, 0, 0, 0.6), 8, 8, 6), Blur(1.5))
	box("shRound", s, 490, 40, Rect(20), Fill(Solid(C(0.95, 0.95, 0.95))), Shadow(CA(0.1, 0.1, 0.6, 0.4), -6, 4, 12))
	box("shHalf", s, 40, 170, Fill(Solid(C(0.3, 0.7, 0.4))), Opacity(0.5), Shadow(CA(0, 0, 0, 0.8), 5, 5, 0))
	box("shTwo", s, 190, 170, Fill(Solid(C(1, 1, 1))), Shadow(CA(1, 0, 0, 0.5), 8, 8, 4), Shadow(CA(0, 0, 1, 0.5), -8, -8, 4))

	// 5. containers
	s = screen("s_containers", "Containers", 760, 420)
	b.Add("clip", s, "clip", 30, 30, 140, 100, Frame(true, nil), Fill(Solid(C(0.95, 0.95, 0.8))))
	b.Add("clipKid", "clip", "clipKid", 90, 50, 120, 90, Fill(Solid(red)))
	b.Add("clipKid2", "clip", "clipKid2", -20, -20, 60, 60, Ellipse(), Fill(Solid(C(0.2, 0.2, 0.9))))
	b.Add("bare", s, "bare", 200, 30, 140, 100, Frame(false, nil), Fill(), StrokeOpt(2, Center, Solid(C(0.4, 0.4, 0.4))))
	b.Add("bareKid", "bare", "bareKid", 20, 20, 80, 50, Fill(Solid(C(0.1, 0.6, 0.6))))
	b.Add("group", s, "group", 380, 30, 0, 0, Group())
	b.Add("gA", "group", "gA", 0, 0, 50, 50, Fill(Solid(C(0.9, 0.5, 0.1))))
	b.Add("gB", "group", "gB", 40, 30, 50, 50, Ellipse(), Fill(Solid(CA(0.1, 0.5, 0.9, 0.8))))
	b.Add("rotFrame", s, "rotFrame", 520, 40, 130, 90, Frame(true, nil), Rot(15), Fill(Solid(C(0.85, 0.9, 1))))
	b.Add("rotFrameKid", "rotFrame", "rotFrameKid", 60, 30, 120, 80, Fill(Solid(C(0.9, 0.3, 0.3))))
	// A frame's opacity does NOT dim its children in the canvas.
	b.Add("opFrame", s, "opFrame", 30, 200, 160, 110, Frame(false, nil), Fill(Solid(C(0.1, 0.1, 0.5))), Opacity(0.4))
	b.Add("opKid", "opFrame", "opKid", 30, 25, 100, 60, Fill(Solid(C(0.9, 0.7, 0.1))))
	b.Add("nest1", s, "nest1", 230, 200, 200, 150, Frame(false, nil), Fill(Solid(C(0.9, 0.9, 0.9))))
	b.Add("nest2", "nest1", "nest2", 30, 30, 140, 100, Frame(true, nil), Fill(Solid(C(0.8, 0.85, 0.95))))
	b.Add("nest3", "nest2", "nest3", 60, 50, 120, 90, Fill(Solid(C(0.2, 0.5, 0.3))), Rect(10))
	b.Add("rotGroup", s, "rotGroup", 560, 260, 0, 0, Group(), Rot(30))
	b.Add("rgA", "rotGroup", "rgA", 0, 0, 60, 30, Fill(Solid(C(0.7, 0.2, 0.7))))
	b.Add("rgB", "rotGroup", "rgB", 0, 40, 60, 30, Fill(Solid(C(0.2, 0.7, 0.7))))

	// 6. auto layout
	s = screen("s_autolayout", "AutoLayout", 760, 520)
	panel := Fill(Solid(C(0.92, 0.94, 1)))
	b.Add("alH", s, "alH", 20, 20, 300, 80, Frame(false, Layout(false, 10, 12, 12, 12, 12, AStart, AStart, false, false)), panel)
	b.Add("alH1", "alH", "h1", 0, 0, 50, 30, Fill(Solid(red)))
	b.Add("alH2", "alH", "h2", 0, 0, 70, 50, Fill(Solid(C(0.3, 0.7, 0.4))))
	b.Add("alH3", "alH", "h3", 0, 0, 40, 20, Ellipse(), Fill(Solid(C(0.95, 0.7, 0.2))))
	b.Add("alV", s, "alV", 340, 20, 100, 100, Frame(false, Layout(true, 8, 16, 16, 16, 16, AStart, ACenter, true, true)), panel, StrokeOpt(2, Inside, Solid(C(0.4, 0.5, 0.9))))
	b.Add("alV1", "alV", "v1", 0, 0, 60, 24, Fill(Solid(red)))
	b.Add("alV2", "alV", "v2", 0, 0, 90, 24, Fill(Solid(C(0.3, 0.7, 0.4))))
	b.Add("alV3", "alV", "v3", 0, 0, 40, 24, Fill(Solid(C(0.2, 0.4, 0.9))))
	b.Add("alB", s, "alB", 20, 140, 300, 70, Frame(false, Layout(false, 4, 10, 6, 10, 6, ABetween, ACenter, false, false)), panel)
	b.Add("alB1", "alB", "b1", 0, 0, 40, 30, Fill(Solid(red)))
	b.Add("alB2", "alB", "b2", 0, 0, 40, 50, Fill(Solid(C(0.3, 0.7, 0.4))))
	b.Add("alB3", "alB", "b3", 0, 0, 40, 20, Fill(Solid(C(0.2, 0.4, 0.9))))
	b.Add("alE", s, "alE", 480, 20, 120, 220, Frame(false, Layout(true, 12, 16, 8, 16, 8, AEnd, AEnd, false, false)), panel)
	b.Add("alE1", "alE", "e1", 0, 0, 60, 40, Fill(Solid(red)))
	b.Add("alE2", "alE", "e2", 0, 0, 90, 40, Fill(Solid(C(0.3, 0.7, 0.4))))
	b.Add("alC", s, "alC", 20, 240, 400, 120, Frame(true, Layout(false, 16, 20, 0, 20, 0, ACenter, ACenter, false, false)), panel)
	b.Add("alC1", "alC", "c1", 0, 0, 80, 80, Rect(12), Fill(Solid(red)))
	b.Add("alC2", "alC", "c2", 0, 0, 80, 40, Fill(Solid(C(0.3, 0.7, 0.4))), Rot(10))
	b.Add("alCh", "alC", "chidden", 0, 0, 80, 80, Hidden())
	b.Add("alCg", "alC", "cgroup", 300, 10, 0, 0, Group())
	b.Add("alCga", "alCg", "cga", 0, 0, 30, 30, Ellipse(), Fill(Solid(C(0.2, 0.4, 0.9))))
	// nested: hug row with a hug column inside
	b.Add("alN", s, "alN", 20, 390, 100, 100, Frame(false, Layout(false, 12, 12, 12, 12, 12, AStart, AStart, true, true)), panel)
	b.Add("alN1", "alN", "n1", 0, 0, 40, 40, Fill(Solid(red)))
	b.Add("alN2", "alN", "n2", 0, 0, 10, 10, Frame(false, Layout(true, 6, 8, 8, 8, 8, AStart, AStart, true, true)), Fill(Solid(C(1, 1, 1))), StrokeOpt(1, Outside, Solid(C(0.6, 0.6, 0.6))))
	b.Add("alN21", "alN2", "n21", 0, 0, 50, 14, Fill(Solid(C(0.3, 0.7, 0.4))))
	b.Add("alN22", "alN2", "n22", 0, 0, 30, 14, Fill(Solid(C(0.2, 0.4, 0.9))))

	// 7. text
	s = screen("s_text", "Text", 840, 360)
	b.Add("t1", s, "t1", 30, 30, 240, 80, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Hello, design world. This line wraps inside its box.", 16, "", AlignLeft))
	b.Add("t2", s, "t2", 300, 30, 220, 40, Fill(Solid(C(0.8, 0.1, 0.3))), Text("Bold centered", 22, "700", AlignCenter))
	b.Add("t3", s, "t3", 560, 30, 220, 40, Fill(Solid(C(0.1, 0.4, 0.8))), Text("Right aligned 24px", 24, "", AlignRight))
	b.Add("t4", s, "t4", 30, 140, 300, 40, Fill(Solid(black)), Text("Stroked & 2 lines\nsecond line", 28, "700", AlignLeft), StrokeOpt(1, Center, Solid(C(1, 0.5, 0))))
	b.Add("t5", s, "t5", 360, 140, 200, 40, Fill(Linear(0, 0, 1, 0, S(0, C(0.9, 0.1, 0.1)), S(1, C(0.1, 0.1, 0.9)))), Text("Gradient text", 26, "700", AlignLeft))
	b.Add("t6", s, "t6", 600, 140, 200, 60, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Shadowed", 30, "700", AlignLeft), Shadow(CA(0, 0, 0, 0.4), 3, 3, 4))
	b.Add("t7", s, "t7", 30, 240, 260, 80, Fill(Solid(C(0.2, 0.2, 0.2))), TextStyled("Line height 1.6 and a smaller 13px size for dense paragraphs of copy.", &opendesignerv1.TextStyle{FontSize: 13, LineHeight: 1.6, FontWeight: "500"}))
	b.Add("t8", s, "t8", 330, 240, 200, 40, Fill(Solid(C(0.1, 0.5, 0.3))), Text("Semi opaque", 20, "600", AlignLeft), Opacity(0.5))
	b.Add("t9", s, "t9", 560, 240, 240, 40, Text("Default grey fill", 18, "", AlignLeft), Fill())

	// 8. vectors
	s = screen("s_vectors", "Vectors", 700, 260)
	b.Add("vOpen", s, "vOpen", 30, 30, 100, 60, Vector(Sub(false,
		Pt(0, 50, 0, 0, 20, -60), Pt(50, 0, -20, 0, 20, 0), Pt(100, 50, -20, -60, 0, 0))), Fill(Solid(C(0.8, 0.1, 0.1))))
	b.Add("vHole", s, "vHole", 170, 20, 90, 90, Vector(
		Sub(true, Pt(0, 0, 0, 0, 0, 0), Pt(90, 0, 0, 0, 0, 0), Pt(90, 90, 0, 0, 0, 0), Pt(0, 90, 0, 0, 0, 0)),
		Sub(true, Pt(25, 25, 0, 0, 0, 0), Pt(65, 25, 0, 0, 0, 0), Pt(65, 65, 0, 0, 0, 0), Pt(25, 65, 0, 0, 0, 0)),
	), Fill(Solid(C(0.2, 0.5, 0.8))))
	b.Add("vDot", s, "vDot", 320, 40, 0, 0, Vector(Sub(false, Pt(0, 0, 0, 0, 0, 0))), Fill(Solid(C(0.1, 0.1, 0.1))))
	b.Add("vBlob", s, "vBlob", 380, 20, 100, 100, Vector(Sub(true,
		Pt(50, 0, -30, 0, 30, 0), Pt(100, 50, 0, -30, 0, 30), Pt(50, 100, 30, 0, -30, 0), Pt(0, 50, 0, 30, 0, -30))),
		Fill(Linear(0, 0, 1, 1, S(0, C(1, 0.5, 0)), S(1, C(0.6, 0.1, 0.8)))))
	b.Add("vHalf", s, "vHalf", 530, 30, 100, 60, Vector(Sub(true,
		Pt(0, 60, 0, 0, 0, 0), Pt(50, 0, -25, 0, 25, 0), Pt(100, 60, 0, 0, 0, 0))), Fill(Solid(C(0.1, 0.6, 0.3))), Opacity(0.5))
	b.Add("vShadow", s, "vShadow", 60, 150, 100, 60, Vector(Sub(true,
		Pt(0, 0, 0, 0, 0, 0), Pt(100, 0, 0, 0, 0, 0), Pt(50, 60, 0, 0, 0, 0))), Fill(Solid(C(0.9, 0.7, 0.1))), Shadow(CA(0, 0, 0, 0.5), 6, 8, 8))

	// 9. images
	pngBytes := testPNG()
	sum := sha256.Sum256(pngBytes)
	hash := hex.EncodeToString(sum[:])
	missing := hex.EncodeToString(make([]byte, 32))
	s = screen("s_images", "Images", 700, 260)
	b.Add("imgOk", s, "imgOk", 30, 30, 120, 90, Image(hash))
	b.Add("imgRot", s, "imgRot", 190, 40, 100, 70, Image(hash), Rot(20))
	b.Add("imgHalf", s, "imgHalf", 330, 30, 120, 60, Image(hash), Opacity(0.5))
	b.Add("imgMissing", s, "imgMissing", 490, 30, 120, 60, Image(missing), Fill())
	b.Add("imgShadow", s, "imgShadow", 30, 150, 100, 70, Image(hash), Shadow(CA(0, 0, 0, 0.5), 5, 6, 8))

	// 10. instances
	s = screen("s_instances", "Instances", 700, 260)
	b.Add("cardM", "page1", "Card", 20000, 0, 140, 90, Frame(true, nil), Fill(Solid(C(0.9, 0.9, 0.95))), StrokeOpt(1, Inside, Solid(C(0.6, 0.6, 0.7))))
	b.Add("cardLabel", "cardM", "label", 10, 10, 60, 30, Rect(6), Fill(Solid(C(0.3, 0.3, 0.7))))
	b.Add("cardText", "cardM", "title", 10, 52, 120, 24, Fill(Solid(C(0.1, 0.1, 0.1))), Text("Title", 16, "600", AlignLeft))
	b.Component("c_card", "cardM", "Card")
	b.Add("badgeM", "page1", "Badge", 20200, 0, 40, 20, Rect(10), Fill(Solid(C(0.9, 0.2, 0.2))))
	b.Component("c_badge", "badgeM", "Badge")
	b.Add("inst1", s, "inst1", 30, 30, 140, 90, Instance("c_card"))
	b.Add("inst2", s, "inst2", 200, 30, 140, 90, Instance("c_card", OverrideFill("cardLabel", Solid(C(0.9, 0.4, 0.1)))))
	b.Add("inst3", s, "inst3", 370, 30, 140, 90, Instance("c_card", OverrideText("cardText", "Another title")))
	b.Add("inst4", s, "inst4", 540, 50, 140, 90, Instance("c_card"), Rot(12))
	b.Add("inst5", s, "inst5", 30, 150, 40, 20, Instance("c_badge"))
	b.Add("inst6", s, "inst6", 100, 150, 40, 20, Instance("c_badge", OverrideFill("badgeM", Solid(C(0.2, 0.6, 0.3)))))

	return b.Doc, map[string][]byte{hash: pngBytes}
}
