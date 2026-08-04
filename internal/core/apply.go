// Package core applica gli Op al documento in modo autoritativo.
package core

import (
	"errors"
	"fmt"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

var (
	ErrNilNode      = errors.New("core: nil node")
	ErrNodeExists   = errors.New("core: node already exists")
	ErrNodeNotFound = errors.New("core: node not found")
	ErrNotTextNode  = errors.New("core: not a text node")
	ErrNotRectNode  = errors.New("core: not a rect node")
	// ErrNotVectorNode: stesso precedente di ErrNotTextNode -- il oneof `shape`
	// è la NATURA del nodo, quindi un SetVectorPath su un rettangolo è un op sul
	// nodo sbagliato, non un campo mancante da riempire.
	ErrNotVectorNode  = errors.New("core: not a vector node")
	ErrParentNotFound = errors.New("core: parent not found")
	ErrCycle          = errors.New("core: reparent would create a cycle")
	ErrNilPage        = errors.New("core: nil page")
	ErrPageExists     = errors.New("core: page id already taken")
	ErrPageNotFound   = errors.New("core: page not found")
	ErrLastPage       = errors.New("core: cannot delete the last page")
)

// NewDocument crea un documento vuoto con una pagina di default ("page1").
func NewDocument(id, name string) *brawtv1.Document {
	return &brawtv1.Document{
		Id: id, Name: name, SchemaVersion: 1,
		Pages: []*brawtv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*brawtv1.Node{},
	}
}

// Apply muta doc applicando op. Ritorna errore se l'op viola un'invariante.
func Apply(doc *brawtv1.Document, op *brawtv1.Op) error {
	switch k := op.GetKind().(type) {
	case *brawtv1.Op_CreateNode:
		return applyCreate(doc, k.CreateNode)
	case *brawtv1.Op_SetProps:
		return applySetProps(doc, k.SetProps)
	case *brawtv1.Op_DeleteNode:
		return applyDelete(doc, k.DeleteNode)
	case *brawtv1.Op_SetText:
		return applySetText(doc, k.SetText)
	case *brawtv1.Op_SetVectorPath:
		return applySetVectorPath(doc, k.SetVectorPath)
	case *brawtv1.Op_ReparentNode:
		return applyReparent(doc, k.ReparentNode)
	case *brawtv1.Op_CreatePage:
		return applyCreatePage(doc, k.CreatePage)
	case *brawtv1.Op_DeletePage:
		return applyDeletePage(doc, k.DeletePage)
	case *brawtv1.Op_RenamePage:
		return applyRenamePage(doc, k.RenamePage)
	default:
		return fmt.Errorf("core: unknown op kind %T", op.GetKind())
	}
}

func applyCreate(doc *brawtv1.Document, c *brawtv1.CreateNode) error {
	n := c.GetNode()
	if n == nil || n.GetId() == "" {
		return ErrNilNode
	}
	if _, exists := doc.Nodes[n.GetId()]; exists {
		return fmt.Errorf("%w: %s", ErrNodeExists, n.GetId())
	}
	// Il parent deve ESISTERE: un altro nodo (annidamento) o una Page (i root).
	// Senza questo controllo un id sbagliato -- un typo, un op che arriva fuori
	// ordine, un client che riferisce un gruppo appena cancellato da un altro --
	// produce un nodo che nessuna pagina raggiunge: invisibile sul canvas e
	// invisibile nel pannello livelli, ma presente nel documento e nello
	// snapshot per sempre. È la stessa ragione per cui applyDelete cascata: la
	// mappa `nodes` è piatta, ma il DOCUMENTO è l'albero, e solo ciò che pende
	// da una pagina ne fa parte.
	if !parentExists(doc, n.GetParentId()) {
		return fmt.Errorf("%w: %s (node %s)", ErrParentNotFound, n.GetParentId(), n.GetId())
	}
	if doc.Nodes == nil {
		// Apply is the authoritative mutator for any *brawtv1.Document, not
		// only ones built via NewDocument. proto.Unmarshal resets the
		// destination first, and proto3 omits empty map fields from the
		// wire, so a Document decoded from a zero-node snapshot has
		// Nodes == nil. Lazily init it here so replaying the oplog's first
		// CreateNode doesn't panic on assignment to a nil map.
		doc.Nodes = map[string]*brawtv1.Node{}
	}
	doc.Nodes[n.GetId()] = n
	return nil
}

// applyDelete cancella il nodo E TUTTO il suo sottoalbero.
//
// La cascata non è una comodità: senza, cancellare un gruppo lascerebbe i figli
// nella mappa con un parent_id che non esiste più -- esattamente gli orfani che
// applyCreate rifiuta di creare. Sarebbero nodi non raggiungibili da nessuna
// pagina (quindi invisibili) ma ancora nel documento, e un CreateNode
// successivo che riusasse quell'id verrebbe respinto con ErrNodeExists per un
// nodo che l'utente ha cancellato.
//
// L'op resta UNO solo: il client manda `deleteNode(g1)` e sia il server sia
// applyOp (TS) espandono la cascata allo stesso modo. L'INVERSO invece è
// necessariamente multiplo -- un CreateNode per nodo, parent prima dei figli --
// e vive lato client (web/src/store/history.ts), l'unico che tiene una storia.
func applyDelete(doc *brawtv1.Document, d *brawtv1.DeleteNode) error {
	if _, ok := doc.Nodes[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, d.GetId())
	}
	for _, n := range SubtreeOf(doc, d.GetId()) {
		delete(doc.Nodes, n.GetId())
	}
	return nil
}

// applyReparent sposta un nodo sotto un altro container (o direttamente sotto
// una Page) e ne riscrive la order key fra i nuovi pari.
//
// Op dedicato e non un path della mask di SetProperties (a differenza di
// `order_key`, che è un campo come gli altri) perché ha una VALIDAZIONE che
// nessun altro campo ha: il nuovo parent deve esistere e non può essere il nodo
// stesso né un suo discendente. Un ciclo staccherebbe il sottoalbero dal
// documento -- non sarebbe più raggiungibile da nessuna pagina -- lasciandolo
// però nella mappa: invisibile, non cancellabile a cascata (nessuna pagina ci
// arriva) e capace di mandare in loop qualunque attraversamento ingenuo.
//
// Come per una mask mista in applySetProps, il rifiuto è in BLOCCO: si valida
// tutto prima di scrivere qualsiasi campo, così un reparent respinto non lascia
// il nodo con la order key nuova e il parent vecchio.
func applyReparent(doc *brawtv1.Document, r *brawtv1.ReparentNode) error {
	n, ok := doc.Nodes[r.GetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, r.GetId())
	}
	if !parentExists(doc, r.GetNewParentId()) {
		return fmt.Errorf("%w: %s (node %s)", ErrParentNotFound, r.GetNewParentId(), r.GetId())
	}
	// Il nodo stesso è il caso degenere del ciclo: IsAncestorOf è STRETTA
	// (nessuno è antenato di sé), quindi va escluso a parte.
	if r.GetNewParentId() == r.GetId() || IsAncestorOf(doc, r.GetId(), r.GetNewParentId()) {
		return fmt.Errorf("%w: %s under %s", ErrCycle, r.GetId(), r.GetNewParentId())
	}
	n.ParentId = r.GetNewParentId()
	// Scritta SEMPRE, anche vuota: come per ogni altro campo di un op assoluto,
	// il valore che arriva è il valore finale. Un reparent che tiene lo stesso
	// parent è il riordino fra pari del pannello livelli.
	n.OrderKey = r.GetOrderKey()
	return nil
}

// --- pagine -----------------------------------------------------------------
//
// Le pagine sono i container RADICE: ogni nodo pende da una di loro e ciò che
// non è raggiungibile da nessuna pagina non fa parte del documento (vedi
// tree.go). Da qui le tre invarianti, speculari a quelle dei nodi:
//
//	1. l'id di una pagina è LIBERO -- né di un'altra pagina né di un nodo:
//	   parentExists risponde "sì" per entrambi, quindi due container omonimi
//	   renderebbero ambiguo il parent di chiunque li nomini;
//	2. cancellare una pagina cancella TUTTI i nodi che le pendono sotto (la
//	   cascata di applyDelete portata alla radice);
//	3. l'ULTIMA pagina non si cancella: senza pagine non esiste nessun parent
//	   valido, quindi nessun nodo potrebbe più essere creato.

// pageIndex ritorna la posizione di una pagina in doc.Pages, o -1.
func pageIndex(doc *brawtv1.Document, id string) int {
	for i, p := range doc.GetPages() {
		if p.GetId() == id {
			return i
		}
	}
	return -1
}

// applyCreatePage aggiunge una pagina IN CODA.
//
// In coda e non a un indice scelto dal chiamante: la posizione nell'elenco è
// l'ordine del selettore di pagina, non una proprietà del documento che qualcuno
// possa violare, e un `index` nell'op vorrebbe dire clamp, validazione e un
// inverso che dipende dalla posizione. L'unica conseguenza è che annullare la
// cancellazione di una pagina di mezzo la riporta in fondo -- il suo CONTENUTO
// torna intatto, che è ciò che un undo deve garantire.
func applyCreatePage(doc *brawtv1.Document, c *brawtv1.CreatePage) error {
	p := c.GetPage()
	if p == nil || p.GetId() == "" {
		return ErrNilPage
	}
	// Un id già preso -- da una pagina o da un NODO -- è rifiutato: vedi
	// l'invariante 1 qui sopra.
	if parentExists(doc, p.GetId()) {
		return fmt.Errorf("%w: %s", ErrPageExists, p.GetId())
	}
	doc.Pages = append(doc.Pages, p)
	return nil
}

// applyDeletePage cancella la pagina E TUTTI i nodi che ci pendono sotto.
//
// L'op resta UNO solo, come deleteNode: il client manda `deletePage(p2)` e sia
// il server sia applyOp (TS) espandono la cascata allo stesso modo. L'inverso è
// necessariamente multiplo (createPage + una createNode per nodo, parent prima
// dei figli) e vive lato client, in web/src/store/history.ts.
func applyDeletePage(doc *brawtv1.Document, d *brawtv1.DeletePage) error {
	i := pageIndex(doc, d.GetId())
	if i < 0 {
		return fmt.Errorf("%w: %s", ErrPageNotFound, d.GetId())
	}
	if len(doc.GetPages()) == 1 {
		return fmt.Errorf("%w: %s", ErrLastPage, d.GetId())
	}
	// Validato tutto PRIMA di scrivere qualsiasi cosa, come per una mask mista:
	// un rifiuto non deve lasciare la pagina rimossa e i nodi al loro posto (o
	// viceversa).
	for _, root := range ChildrenOf(doc, d.GetId()) {
		for _, n := range SubtreeOf(doc, root.GetId()) {
			delete(doc.Nodes, n.GetId())
		}
	}
	doc.Pages = append(doc.Pages[:i], doc.Pages[i+1:]...)
	return nil
}

func applyRenamePage(doc *brawtv1.Document, r *brawtv1.RenamePage) error {
	i := pageIndex(doc, r.GetId())
	if i < 0 {
		return fmt.Errorf("%w: %s", ErrPageNotFound, r.GetId())
	}
	// Scritto SEMPRE, anche vuoto: come per Node.name, il valore che arriva è il
	// valore finale, e il ripiego per un nome vuoto è della UI.
	doc.Pages[i].Name = r.GetName()
	return nil
}

// applySetProps copia i campi indicati dalla mask da patch al nodo target.
// Valida l'intera mask prima di mutare qualsiasi campo: una mask mista
// (es. ["x","bogus"]) non deve lasciare il documento parzialmente mutato.
func applySetProps(doc *brawtv1.Document, s *brawtv1.SetProperties) error {
	n, ok := doc.Nodes[s.GetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	paths := s.GetMask().GetPaths()
	for _, path := range paths {
		switch path {
		case "x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fills", "strokes", "order_key":
			// supported
		case "corner_radius":
			// UNICO path della mask che indirizza un campo DENTRO il oneof
			// `shape` (RectNode.corner_radius) invece che un campo di primo
			// livello del Node: il patch lo porta annidato nella forma, e il
			// nodo bersaglio deve essere un rettangolo.
			//
			// Il oneof `shape` è la NATURA del nodo, non un suo campo: un
			// corner_radius su un'ellisse o su un testo non è "un campo
			// mancante da riempire", è un op sul nodo sbagliato -- la stessa
			// regola per cui applySetText rifiuta un rettangolo
			// (ErrNotTextNode). Il rifiuto sta QUI, nel giro di validazione,
			// per la stessa ragione per cui ci sta quello dei path ignoti:
			// una mask mista (es. ["x","corner_radius"]) non deve lasciare il
			// documento mutato a metà.
			//
			// Uno `shape` ASSENTE invece passa: un Node senza forma è comunque
			// un rettangolo per chiunque legga il documento
			// (web/src/store/types.ts::toNodeLite lo mappa esplicitamente su
			// kind "rect"), quindi rifiutarlo qui farebbe divergere client e
			// server proprio sul nodo che entrambi disegnano come rettangolo.
			// Il rettangolo implicito viene materializzato più sotto.
			//
			// La guardia è una WHITELIST (che cosa è un rettangolo) e non una
			// lista delle forme da rifiutare, ed è una differenza con i denti:
			// elencare i "cattivi" fa passare in silenzio OGNI forma aggiunta
			// dopo (immagine della traccia 3, vettoriale della traccia 4, gruppo/
			// frame della traccia 1), che finisce dritta nel ramo qui sotto --
			// quello che materializza il rettangolo implicito -- e si vede
			// SOSTITUIRE lo `shape` da un Node_Rect, distruggendo la propria
			// geometria (o, per un'immagine, l'hash dei byte). È successo
			// esattamente così con VectorNode: la lista diceva {Ellipse, Text},
			// un setProps{corner_radius} su un nodo vettoriale passava la
			// validazione e ne cancellava tutti i subpath, mentre il gemello TS
			// (web/src/store/applyOp.ts, `cur.kind !== "rect"`) rifiutava lo
			// stesso op -- documento autorevole e client desincronizzati per
			// sempre. Con la whitelist gruppo, frame e ogni forma nuova sono
			// rifiutati di default: il peggio che può fare è costringere chi la
			// aggiunge a decidere, invece di perdere il lavoro dell'utente.
			switch n.GetShape().(type) {
			case nil, *brawtv1.Node_Rect:
				// Rettangolo esplicito, o implicito (shape assente).
			default:
				return fmt.Errorf("%w: %s", ErrNotRectNode, s.GetId())
			}
		default:
			return fmt.Errorf("core: unsupported mask path %q", path)
		}
	}
	p := s.GetPatch()
	for _, path := range paths {
		switch path {
		case "x":
			n.X = p.GetX()
		case "y":
			n.Y = p.GetY()
		case "width":
			n.Width = p.GetWidth()
		case "height":
			n.Height = p.GetHeight()
		case "rotation":
			n.Rotation = p.GetRotation()
		case "opacity":
			n.Opacity = p.GetOpacity()
		case "name":
			n.Name = p.GetName()
		case "visible":
			n.Visible = p.GetVisible()
		case "fills":
			n.Fills = p.GetFills()
		case "strokes":
			// SOSTITUZIONE dell'intera lista, esattamente come `fills` qui
			// sopra -- non una fusione elemento per elemento. È il campo
			// RIPETUTO su cui le due implementazioni di apply potrebbero
			// divergere in silenzio (una lista più corta che lascia in coda i
			// tratti vecchi si nota solo guardando il canvas), quindi la
			// semantica è fissata da un test per lato e dalla fixture
			// testdata/golden/strokes.json, che il runner esegue da entrambi.
			//
			// A differenza di corner_radius NON c'è nessuna forma da
			// controllare: il tratto è un campo di primo livello del Node, e
			// vale per un rettangolo come per un'ellisse o un testo.
			n.Strokes = p.GetStrokes()
		case "order_key":
			// L'ordine di disegno (e quello del pannello livelli) è un CAMPO
			// come gli altri, non un op dedicato: riordinare è scrivere una
			// order key nuova, calcolata dal client come indice frazionario fra
			// i due vicini della posizione d'arrivo. Primo path multiparola
			// della mask -- sul filo JSON viaggia come "orderKey" (vedi
			// web/src/store/maskPaths.ts).
			n.OrderKey = p.GetOrderKey()
		case "corner_radius":
			// Il giro di validazione ha già escluso ellisse e testo: qui resta
			// un rettangolo, esplicito o implicito. Nel secondo caso (shape
			// assente, oppure Node_Rect con Rect nil dopo un round-trip) il
			// rettangolo va materializzato prima di scriverci dentro --
			// altrimenti l'assegnazione andrebbe su un puntatore nil.
			r := n.GetRect()
			if r == nil {
				r = &brawtv1.RectNode{}
				n.Shape = &brawtv1.Node_Rect{Rect: r}
			}
			r.CornerRadius = p.GetRect().GetCornerRadius()
		}
	}
	return nil
}

// applySetText scrive il contenuto (e, se richiesto, lo stile) di un nodo testo.
//
// Op dedicato e non un path della mask di SetProperties: il contenuto vive
// DENTRO il oneof `shape`, mentre la mask indirizza campi di primo livello del
// Node -- un path annidato costringerebbe questa funzione e la sua gemella TS
// (web/src/store/applyOp.ts) a un parser di path.
//
// Il contenuto si scrive SEMPRE (anche vuoto: è il testo cancellato
// dall'utente). Lo stile no: `style_present` distingue "non specificato" da
// "azzera". In proto3 un sotto-messaggio assente e uno con tutti i campi a zero
// non si distinguono dopo il round-trip protojson, quindi senza il flag ogni
// SetText di solo contenuto -- cioè ogni battuta di tasto -- porterebbe il font
// a 0 e renderebbe il nodo invisibile. Con il flag: false => lo stile esistente
// resta intatto, true => viene sostituito da `style` (nil incluso, che è
// l'azzeramento esplicito).
func applySetText(doc *brawtv1.Document, s *brawtv1.SetText) error {
	n, ok := doc.Nodes[s.GetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	// Il oneof `shape` è la NATURA del nodo, non un suo campo: un SetText su un
	// rettangolo non è "un campo mancante da riempire", è un op sul nodo
	// sbagliato. Scriverci dentro trasformerebbe la forma in silenzio (e, dato
	// che l'op non ha inverso per il rect che c'era prima, in modo non
	// annullabile), quindi si rifiuta l'op senza toccare niente.
	t, isText := n.GetShape().(*brawtv1.Node_Text)
	if !isText || t.Text == nil {
		return fmt.Errorf("%w: %s", ErrNotTextNode, s.GetId())
	}
	t.Text.Content = s.GetContent()
	if s.GetStylePresent() {
		t.Text.Style = s.GetStyle()
	}
	return nil
}

// applySetVectorPath sostituisce IN BLOCCO i subpath di un nodo vettoriale.
//
// Op dedicato e non un path della mask di SetProperties per la stessa ragione
// di applySetText: la geometria vive DENTRO il oneof `shape`, mentre la mask
// indirizza campi di primo livello del Node.
//
// La lista si scrive SEMPRE, anche vuota -- è il path che l'utente ha svuotato,
// non un "non specificato" da ignorare. Nessun flag `present` come
// SetText.style_present: là il flag serviva perché un SetText porta DUE cose
// (contenuto e stile) e una delle due doveva poter restare intatta; qui l'op È
// i subpath, quindi "assente" e "vuoto" descrivono lo stesso stato e la
// distinzione proto3 non è osservabile.
func applySetVectorPath(doc *brawtv1.Document, s *brawtv1.SetVectorPath) error {
	n, ok := doc.Nodes[s.GetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	// Stesso rifiuto di applySetText su un non-testo: scrivere una geometria
	// dentro un rettangolo ne cambierebbe la FORMA in silenzio, e l'op non ha
	// inverso per il rettangolo che c'era prima -- quindi in modo non
	// annullabile. Nota che qui NON c'è il ripiego "shape assente = rettangolo
	// implicito" di applySetProps: un nodo senza forma è un rettangolo per
	// chiunque legga il documento (web/src/store/types.ts::toNodeLite), quindi
	// è esattamente il caso che va rifiutato.
	v, isVector := n.GetShape().(*brawtv1.Node_Vector)
	if !isVector || v.Vector == nil {
		return fmt.Errorf("%w: %s", ErrNotVectorNode, s.GetId())
	}
	v.Vector.Subpaths = s.GetSubpaths()
	return nil
}
