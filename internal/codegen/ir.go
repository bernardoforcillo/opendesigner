package codegen

// IR -- la rappresentazione intermedia fra il documento e i renderer di codice.
//
// Il documento (alberi di Node con coordinate relative al parent) viene tradotto
// UNA volta in un albero di Element: tag, attributi, proprietà CSS IN ORDINE,
// testo e figli. I due renderer (html.go: CSS in un <style>, react.go: classi
// Tailwind) leggono lo STESSO albero, quindi CSS e Tailwind non possono
// divergere: ciò che cambia è solo la sintassi con cui si scrive una Prop.
//
// Le proprietà stanno in una LISTA e non in una mappa per due ragioni:
// l'ordine di emissione è parte dell'output (golden file, diff leggibili) e
// alcune proprietà si leggono in coppia (position/left/top).

// Prop è una proprietà CSS: nome e valore già nella forma finale ("12px",
// "#fff", "rotate(30deg)").
type Prop struct{ Name, Value string }

// Attr è un attributo del tag (HTML o SVG). Il nome è quello HTML/SVG
// (kebab-case): il renderer React lo converte in camelCase dove serve.
type Attr struct{ Name, Value string }

// Trigger è il cablaggio di una transizione di un flusso su un elemento (o sulla
// schermata, se la transizione non ha un elemento).
type Trigger struct {
	TransitionID string
	FlowID       string
	Label        string
	Kind         string // click | submit | auto | key | back | testo libero
	Guard        string
	Effect       string
	// Dest è la schermata di arrivo (nil se la destinazione non è fra le
	// schermate generate: il collegamento resta un commento).
	Dest *Screen
}

// Element è un nodo dell'albero IR.
type Element struct {
	Tag   string
	Attrs []Attr
	Style []Prop
	// Text è il contenuto testuale dell'elemento (solo per i nodi testo): il
	// renderer lo cita/escapa secondo il target. HasText distingue "testo
	// vuoto" da "nessun testo".
	Text     string
	HasText  bool
	Children []*Element

	// Tracciabilità design <-> codice.
	NodeID   string
	NodeName string
	Meta     map[string]string

	// Triggers: transizioni innescate da QUESTO elemento (click). Vuoto per la
	// maggioranza.
	Triggers []Trigger
	// NavTriggers: transizioni della schermata senza elemento (o con più
	// transizioni sullo stesso elemento): la radice le rende come pulsanti
	// visivamente nascosti in un <nav> trasparente.
	NavTriggers []Trigger
	// KeyTriggers: transizioni con trigger "key" (Label = il tasto).
	KeyTriggers []Trigger

	// Anim: le animazioni delle clip che toccano questo elemento (animation.go).
	// nil per la maggioranza.
	Anim *ElemAnim
	// StrokePath: il <path> del tratto di un vettoriale (quello che `draw`
	// anima), distinto dal path del riempimento.
	StrokePath bool
}

// Screen è una schermata esportata: un frame di primo livello (o un nodo
// referenziato da un flusso) con il suo albero IR.
type Screen struct {
	NodeID string
	// Name è il nome del componente (PascalCase, deduplicato).
	Name string
	// Slug è il nome file per il target html (kebab-case, deduplicato).
	Slug string
	// Route è la rotta dell'app (meta code.route o "/" + slug).
	Route string
	// File è il percorso del file generato, relativo alla radice dell'output.
	File string

	Width, Height float64
	Root          *Element
}

func (e *Element) addStyle(name, value string) {
	e.Style = append(e.Style, Prop{name, value})
}

func (e *Element) addAttr(name, value string) {
	e.Attrs = append(e.Attrs, Attr{name, value})
}

// attr ritorna il valore di un attributo ("" se manca).
func (e *Element) attr(name string) string {
	for _, a := range e.Attrs {
		if a.Name == name {
			return a.Value
		}
	}
	return ""
}

// style ritorna il valore di una proprietà CSS ("" se manca).
func (e *Element) style(name string) string {
	for _, p := range e.Style {
		if p.Name == name {
			return p.Value
		}
	}
	return ""
}

// walk visita l'elemento e i discendenti in pre-ordine.
func (e *Element) walk(fn func(*Element)) {
	fn(e)
	for _, c := range e.Children {
		c.walk(fn)
	}
}
