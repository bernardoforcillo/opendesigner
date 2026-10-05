package samples

import (
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Shop is a flow of three screens (Login -> Home -> Detail) covering the three
// ways a test can find a transition's trigger:
//
//	Login  -> Home    element with test.id ("login-submit"): getByTestId
//	Home   -> Detail  element with test.text: getByText
//	Detail -> Home    element with no meta, only a label: getByRole('button')
//	Home   -> Login   NO element: button hidden in the <nav sr-only>
//
// The screens have no code.route: the export derives it from the name.
func Shop() *opendesignerv1.Document {
	b := New("shop", "Shop")
	ink := Fill(Solid(C(0.1, 0.1, 0.12)))
	white := Fill(Solid(C(1, 1, 1)))
	bg := Fill(Solid(C(0.97, 0.97, 0.99)))
	blue := Fill(Solid(C(0.2, 0.4, 0.95)))
	card := Fill(Solid(C(1, 1, 1)))

	// Login
	b.Add("login", "page1", "Login", 0, 0, 360, 560, Frame(true, nil), bg, Meta("flow.kind", "screen"))
	b.Add("loginTitle", "login", "Title", 24, 48, 312, 36, ink, Text("Sign in to the shop", 28, "700", AlignLeft))
	b.Add("loginEmail", "login", "Email field", 24, 120, 312, 48, Rect(10), white, StrokeOpt(1, Inside, Solid(C(0.8, 0.8, 0.85))))
	b.Add("loginPass", "login", "Password field", 24, 184, 312, 48, Rect(10), white, StrokeOpt(1, Inside, Solid(C(0.8, 0.8, 0.85))))
	b.Add("loginBtn", "login", "Sign in button", 24, 264, 312, 52,
		Frame(false, Layout(false, 0, 0, 0, 0, 0, ACenter, ACenter, false, false)), blue,
		Meta("test.id", "login-submit"))
	b.Add("loginBtnLabel", "loginBtn", "Label", 0, 0, 120, 20, white, Text("Sign in", 16, "600", AlignCenter))

	// Home
	b.Add("home", "page1", "Home", 500, 0, 360, 560, Frame(true, nil), bg)
	b.Add("homeTitle", "home", "Title", 24, 48, 312, 32, ink, Text("Storefront", 24, "700", AlignLeft))
	b.Add("homeCard", "home", "Product", 24, 112, 312, 160,
		Frame(false, Layout(true, 8, 16, 16, 16, 16, AStart, AStart, false, false)), card,
		StrokeOpt(1, Center, Solid(C(0.88, 0.88, 0.92))), Shadow(CA(0, 0, 0, 0.12), 0, 4, 12))
	b.Add("homeCardName", "homeCard", "Product name", 0, 0, 280, 24, ink, Text("Wireless headphones", 18, "600", AlignLeft))
	b.Add("homeCardPrice", "homeCard", "Price", 0, 0, 280, 20, Fill(Solid(C(0.4, 0.4, 0.45))), Text("89.00 EUR", 14, "", AlignLeft))
	b.Add("homeCardImg", "homeCard", "Photo", 0, 0, 280, 72, Image(""), Fill())
	b.Add("homeNote", "home", "Note", 24, 300, 312, 20, Fill(Solid(C(0.4, 0.4, 0.45))), Text("Tap a product for details", 13, "", AlignLeft))

	// Detail
	b.Add("detail", "page1", "Detail", 1000, 0, 360, 560, Frame(true, nil), bg)
	b.Add("detailBack", "detail", "Back", 24, 40, 80, 32, Rect(16), Fill(Solid(C(0.9, 0.9, 0.94))))
	b.Add("detailTitle", "detail", "Title", 24, 96, 312, 32, ink, Text("Wireless headphones", 24, "700", AlignLeft))
	b.Add("detailBody", "detail", "Description", 24, 144, 312, 80, Fill(Solid(C(0.3, 0.3, 0.35))),
		Text("Noise cancellation, 30 hours of battery life and fast charging.", 15, "", AlignLeft))

	b.Flow("f_purchase", "Purchase", "login")
	b.Transition(&opendesignerv1.Transition{Id: "t1", FlowId: "f_purchase", FromId: "login", ToId: "home", Label: "Sign in", Trigger: "click",
		ElementId: "loginBtn", Guard: "valid credentials", Effect: "active session"})
	b.Doc.Nodes["homeCard"].Meta = map[string]string{"test.text": "Wireless headphones"}
	b.Transition(&opendesignerv1.Transition{Id: "t2", FlowId: "f_purchase", FromId: "home", ToId: "detail", Label: "Open detail", Trigger: "click",
		ElementId: "homeCard"})
	b.Transition(&opendesignerv1.Transition{Id: "t3", FlowId: "f_purchase", FromId: "home", ToId: "login", Label: "Sign out", Trigger: "click"})
	b.Transition(&opendesignerv1.Transition{Id: "t4", FlowId: "f_purchase", FromId: "detail", ToId: "home", Label: "Back", Trigger: "click",
		ElementId: "detailBack"})
	return b.Doc
}
