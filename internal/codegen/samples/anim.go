package samples

import (
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// AnimDemo is a screen with ONE clip for each way the generator can animate:
//
//	enter      enter  on the screen: card (opacity + y with a spring), title (scale), delay
//	draw       enter  on the logo group: `draw` of a vector with cubic-bezier
//	hover      hover  on the button: scale + the label (a descendant) changes opacity
//	press      tap    on the button
//	load       loop   on the circle itself: infinite yoyo rotation
//	tilt       hover  on a rectangle ALREADY rotated by 30 degrees: rotation + x (the
//	                  deltas must compose with the base rotation and position)
//	highlight  manual on the card
//
// The data-testid values (meta test.id) are used by the exported app's tests
// (web/scripts/export-anim-app.mjs): they sample opacity and transform over time.
func AnimDemo() *opendesignerv1.Document {
	b := New("anim", "Animations")
	white := Fill(Solid(C(1, 1, 1)))
	blue := Fill(Solid(C(0.2, 0.4, 0.95)))

	b.Add("scr", "page1", "Animations", 0, 0, 400, 420, Frame(true, nil), white, Meta("code.route", "/"))
	b.Add("card", "scr", "Card", 20, 20, 360, 100, Rect(12), blue, Meta("test.id", "card"))
	b.Add("title", "scr", "Title", 36, 40, 300, 32, white, Text("Welcome", 24, "700", AlignLeft), Meta("test.id", "title"))

	b.Add("logo", "scr", "Logo", 20, 140, 120, 60, Group())
	b.Add("sig", "logo", "Signature", 0, 0, 120, 60,
		Vector(Sub(false, Pt(5, 50, 0, 0, 10, -40), Pt(60, 10, -15, 0, 15, 0), Pt(115, 50, -10, -40, 0, 0))),
		Fill(Solid(C(0.1, 0.1, 0.12))), Meta("test.id", "sig"))

	b.Add("btn", "scr", "Button", 20, 230, 160, 48,
		Frame(false, Layout(false, 0, 0, 0, 0, 0, ACenter, ACenter, false, false)), blue, Meta("test.id", "btn"))
	b.Add("btnLabel", "btn", "Label", 0, 0, 100, 20, white, Text("Press", 16, "600", AlignCenter), Meta("test.id", "btn-label"))

	b.Add("spin", "scr", "Loading", 300, 230, 48, 48, Ellipse(), Fill(Solid(C(0.9, 0.3, 0.3))), Meta("test.id", "spin"))
	b.Add("tilt", "scr", "Tilted", 200, 330, 60, 30, Rot(30), Fill(Solid(C(0.3, 0.7, 0.4))), Meta("test.id", "tilt"))

	b.Clip(&opendesignerv1.Clip{Id: "enter", Name: "enter", Duration: 800, Trigger: "enter", Delay: 100, TargetId: "scr",
		Tracks: []*opendesignerv1.Track{
			Tr("card", "opacity", KF(0, 0, "easeOut"), KF(800, 1, "")),
			Tr("card", "y", KF(0, 0, "spring"), KF(800, 20, "")),
			Tr("title", "scale", KF(0, 0.8, "easeInOut"), KF(400, 1.1, "linear"), KF(800, 1, "")),
		}})
	b.Clip(&opendesignerv1.Clip{Id: "draw", Name: "draw the signature", Duration: 1200, Trigger: "enter", Delay: 300, TargetId: "logo",
		Tracks: []*opendesignerv1.Track{
			Tr("sig", "draw", KF(0, 0, "cubic-bezier(0.4, 0, 0.2, 1)"), KF(1200, 1, "")),
		}})
	b.Clip(&opendesignerv1.Clip{Id: "hover", Name: "hover", Duration: 200, Trigger: "hover", TargetId: "btn",
		Tracks: []*opendesignerv1.Track{
			Tr("btn", "scale", KF(0, 1, "easeOut"), KF(200, 1.08, "")),
			Tr("btnLabel", "opacity", KF(0, 1, ""), KF(200, 0.8, "")),
		}})
	b.Clip(&opendesignerv1.Clip{Id: "press", Name: "press", Duration: 100, Trigger: "tap", TargetId: "btn",
		Tracks: []*opendesignerv1.Track{Tr("btn", "scale", KF(0, 1, ""), KF(100, 0.95, ""))}})
	b.Clip(&opendesignerv1.Clip{Id: "load", Name: "loading", Duration: 1000, Trigger: "loop", Repeat: -1, Yoyo: true, TargetId: "spin",
		Tracks: []*opendesignerv1.Track{Tr("spin", "rotation", KF(0, 0, "linear"), KF(1000, 180, ""))}})
	b.Clip(&opendesignerv1.Clip{Id: "tilt", Name: "tilt", Duration: 300, Trigger: "hover", TargetId: "tilt",
		Tracks: []*opendesignerv1.Track{
			Tr("tilt", "rotation", KF(0, 30, "easeOut"), KF(300, 60, "")),
			Tr("tilt", "x", KF(0, 200, ""), KF(300, 230, "")),
		}})
	b.Clip(&opendesignerv1.Clip{Id: "highlight", Name: "highlight", Duration: 300, TargetId: "card",
		Tracks: []*opendesignerv1.Track{Tr("card", "opacity", KF(0, 1, ""), KF(150, 0.5, ""), KF(300, 1, ""))}})
	return b.Doc
}
