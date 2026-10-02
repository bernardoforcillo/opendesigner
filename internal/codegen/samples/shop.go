package samples

import (
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Shop è un flusso di tre schermate (Login -> Home -> Dettaglio) con i tre modi
// in cui un test trova il trigger di una transizione:
//
//	Login    -> Home      elemento con test.id ("login-submit"): getByTestId
//	Home     -> Dettaglio elemento con test.text: getByText
//	Dettaglio-> Home      elemento senza meta, solo etichetta: getByRole('button')
//	Home     -> Login     NESSUN elemento: pulsante nascosto nel <nav sr-only>
//
// Le schermate non hanno code.route: l'export le deriva dal nome.
func Shop() *opendesignerv1.Document {
	b := New("shop", "Negozio")
	ink := Fill(Solid(C(0.1, 0.1, 0.12)))
	white := Fill(Solid(C(1, 1, 1)))
	bg := Fill(Solid(C(0.97, 0.97, 0.99)))
	blue := Fill(Solid(C(0.2, 0.4, 0.95)))
	card := Fill(Solid(C(1, 1, 1)))

	// Login
	b.Add("login", "page1", "Login", 0, 0, 360, 560, Frame(true, nil), bg, Meta("flow.kind", "screen"))
	b.Add("loginTitle", "login", "Titolo", 24, 48, 312, 36, ink, Text("Accedi al negozio", 28, "700", AlignLeft))
	b.Add("loginEmail", "login", "Campo email", 24, 120, 312, 48, Rect(10), white, StrokeOpt(1, Inside, Solid(C(0.8, 0.8, 0.85))))
	b.Add("loginPass", "login", "Campo password", 24, 184, 312, 48, Rect(10), white, StrokeOpt(1, Inside, Solid(C(0.8, 0.8, 0.85))))
	b.Add("loginBtn", "login", "Pulsante accedi", 24, 264, 312, 52,
		Frame(false, Layout(false, 0, 0, 0, 0, 0, ACenter, ACenter, false, false)), blue,
		Meta("test.id", "login-submit"))
	b.Add("loginBtnLabel", "loginBtn", "Etichetta", 0, 0, 120, 20, white, Text("Entra", 16, "600", AlignCenter))

	// Home
	b.Add("home", "page1", "Home", 500, 0, 360, 560, Frame(true, nil), bg)
	b.Add("homeTitle", "home", "Titolo", 24, 48, 312, 32, ink, Text("Vetrina", 24, "700", AlignLeft))
	b.Add("homeCard", "home", "Prodotto", 24, 112, 312, 160,
		Frame(false, Layout(true, 8, 16, 16, 16, 16, AStart, AStart, false, false)), card,
		StrokeOpt(1, Center, Solid(C(0.88, 0.88, 0.92))), Shadow(CA(0, 0, 0, 0.12), 0, 4, 12))
	b.Add("homeCardName", "homeCard", "Nome prodotto", 0, 0, 280, 24, ink, Text("Cuffie wireless", 18, "600", AlignLeft))
	b.Add("homeCardPrice", "homeCard", "Prezzo", 0, 0, 280, 20, Fill(Solid(C(0.4, 0.4, 0.45))), Text("89,00 EUR", 14, "", AlignLeft))
	b.Add("homeCardImg", "homeCard", "Foto", 0, 0, 280, 72, Image(""), Fill())
	b.Add("homeNote", "home", "Nota", 24, 300, 312, 20, Fill(Solid(C(0.4, 0.4, 0.45))), Text("Tocca un prodotto per i dettagli", 13, "", AlignLeft))

	// Dettaglio
	b.Add("detail", "page1", "Dettaglio", 1000, 0, 360, 560, Frame(true, nil), bg)
	b.Add("detailBack", "detail", "Indietro", 24, 40, 80, 32, Rect(16), Fill(Solid(C(0.9, 0.9, 0.94))))
	b.Add("detailTitle", "detail", "Titolo", 24, 96, 312, 32, ink, Text("Cuffie wireless", 24, "700", AlignLeft))
	b.Add("detailBody", "detail", "Descrizione", 24, 144, 312, 80, Fill(Solid(C(0.3, 0.3, 0.35))),
		Text("Cancellazione del rumore, 30 ore di autonomia e ricarica rapida.", 15, "", AlignLeft))

	b.Flow("f_acquisto", "Acquisto", "login")
	b.Transition(&opendesignerv1.Transition{Id: "t1", FlowId: "f_acquisto", FromId: "login", ToId: "home", Label: "Accedi", Trigger: "click",
		ElementId: "loginBtn", Guard: "credenziali valide", Effect: "sessione attiva"})
	b.Doc.Nodes["homeCard"].Meta = map[string]string{"test.text": "Cuffie wireless"}
	b.Transition(&opendesignerv1.Transition{Id: "t2", FlowId: "f_acquisto", FromId: "home", ToId: "detail", Label: "Apri dettaglio", Trigger: "click",
		ElementId: "homeCard"})
	b.Transition(&opendesignerv1.Transition{Id: "t3", FlowId: "f_acquisto", FromId: "home", ToId: "login", Label: "Esci", Trigger: "click"})
	b.Transition(&opendesignerv1.Transition{Id: "t4", FlowId: "f_acquisto", FromId: "detail", ToId: "home", Label: "Indietro", Trigger: "click",
		ElementId: "detailBack"})
	return b.Doc
}
