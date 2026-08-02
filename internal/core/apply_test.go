package core

import (
	"errors"
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func rectNode(id string, x, y float64) *brawtv1.Node {
	return &brawtv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Rect", Visible: true, Opacity: 1,
		X: x, Y: y, Width: 100, Height: 80,
		Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}},
	}
}

func TestApplyCreateNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	op := &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 10, 20)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create: %v", err)
	}
	got, ok := doc.Nodes["n1"]
	if !ok {
		t.Fatal("node n1 not present after create")
	}
	if got.X != 10 || got.Y != 20 {
		t.Fatalf("wrong pos: %v,%v", got.X, got.Y)
	}
}

func TestApplyCreateDuplicateFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	err := Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 5, 5)}}})
	if err == nil {
		t.Fatal("expected error on duplicate create")
	}
}

func TestApplySetPropertiesMoves(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{X: 42, Y: 7},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "y"}},
	}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setprops: %v", err)
	}
	if doc.Nodes["n1"].X != 42 || doc.Nodes["n1"].Y != 7 {
		t.Fatalf("move not applied: %+v", doc.Nodes["n1"])
	}
}

func TestApplySetPropertiesMissingNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id: "ghost", Patch: &brawtv1.Node{X: 1}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}})
	if err == nil {
		t.Fatal("expected ErrNodeNotFound")
	}
}

func TestApplySetPropertiesMixedMaskIsAllOrNothing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{X: 42, Y: 7},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "bogus"}},
	}}}
	if err := Apply(doc, op); err == nil {
		t.Fatal("expected error for unsupported mask path")
	}
	got := doc.Nodes["n1"]
	if got.X != 0 || got.Y != 0 {
		t.Fatalf("partial mutation leaked despite error: %+v", got)
	}
}

func ellipseNode(id string) *brawtv1.Node {
	return &brawtv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Ellipse", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 100, Height: 80,
		Shape: &brawtv1.Node_Ellipse{Ellipse: &brawtv1.EllipseNode{}},
	}
}

func setPropsOp(s *brawtv1.SetProperties) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: s}}
}

// corner_radius è l'UNICO path della mask che indirizza un campo DENTRO il
// oneof `shape` (RectNode.corner_radius) invece che un campo di primo livello
// del Node. Il patch lo porta quindi annidato nella forma, esattamente come
// farebbe un CreateNode.
func TestApplySetPropertiesCornerRadius(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := setPropsOp(&brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{CornerRadius: 12}}},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply corner_radius: %v", err)
	}
	if got := doc.Nodes["n1"].GetRect().GetCornerRadius(); got != 12 {
		t.Fatalf("corner radius not applied: %v", got)
	}
}

// Un patch SENZA rect azzera il raggio, come ogni altro path: applySetProps
// legge il patch con i getter nil-safe di protobuf (vedi il commento su
// NIL_PATCH in web/src/store/applyOp.ts, che documenta la stessa scelta dal
// lato TypeScript).
func TestApplySetPropertiesCornerRadiusNilPatchZeroes(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	n := rectNode("n1", 0, 0)
	n.Shape = &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{CornerRadius: 8}}
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: n}}})
	op := setPropsOp(&brawtv1.SetProperties{
		Id:   "n1",
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply corner_radius senza patch: %v", err)
	}
	if got := doc.Nodes["n1"].GetRect().GetCornerRadius(); got != 0 {
		t.Fatalf("corner radius non azzerato dal patch nil: %v", got)
	}
}

// Il oneof `shape` è la NATURA del nodo: un corner_radius su un'ellisse (o su un
// testo) è un op sul nodo sbagliato, non un campo da riempire -- stessa regola
// di applySetText su un rettangolo (ErrNotTextNode). L'op viene rifiutato in
// BLOCCO, quindi nemmeno la "x" che viaggia nella stessa mask si muove.
func TestApplySetPropertiesCornerRadiusOnNonRectFails(t *testing.T) {
	for _, tc := range []struct {
		name string
		node *brawtv1.Node
	}{
		{"ellipse", ellipseNode("n1")},
		{"text", textNode("n1", "ciao")},
		// Un'immagine è un nodo la cui forma PORTA UN DATO (l'hash
		// dell'asset): materializzare un rettangolo sopra di lei non
		// azzererebbe solo un raggio, cancellerebbe il riferimento ai byte --
		// e l'inverso dell'op non saprebbe rimetterli.
		{"image", imageNode("n1", testAssetHash)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := NewDocument("doc1", "Untitled")
			_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: tc.node}}})
			op := setPropsOp(&brawtv1.SetProperties{
				Id: "n1",
				Patch: &brawtv1.Node{
					X:     42,
					Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{CornerRadius: 12}},
				},
				Mask: &fieldmaskpb.FieldMask{Paths: []string{"x", "corner_radius"}},
			})
			if err := Apply(doc, op); !errors.Is(err, ErrNotRectNode) {
				t.Fatalf("expected ErrNotRectNode, got %v", err)
			}
			got := doc.Nodes["n1"]
			if got.GetX() != 0 {
				t.Fatalf("partial mutation leaked despite error: x=%v", got.GetX())
			}
			if _, isRect := got.GetShape().(*brawtv1.Node_Rect); isRect {
				t.Fatal("shape turned into a rect by a rejected setProps")
			}
		})
	}
}

// Un Node senza `shape` è comunque un RETTANGOLO per chiunque legga il
// documento: web/src/store/types.ts::toNodeLite lo mappa esplicitamente su
// kind "rect" ("un nodo senza shape è comunque un rettangolo disegnabile").
// Rifiutare qui il corner_radius farebbe divergere le due implementazioni --
// il client lo applicherebbe, il server no -- quindi il rettangolo implicito
// viene materializzato.
func TestApplySetPropertiesCornerRadiusOnShapelessNodeMaterializesRect(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	n := rectNode("n1", 0, 0)
	n.Shape = nil
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: n}}})
	op := setPropsOp(&brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{CornerRadius: 4}}},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply corner_radius su nodo senza shape: %v", err)
	}
	if got := doc.Nodes["n1"].GetRect().GetCornerRadius(); got != 4 {
		t.Fatalf("corner radius not applied: %v", got)
	}
}

// TestApplyCreateNodeOnNilNodesMap covers the scenario the review flagged:
// a *brawtv1.Document not built via NewDocument (e.g. proto.Unmarshal-ed
// from a snapshot taken while the document had zero nodes — proto3 omits
// empty map fields from the wire, so the decoded Document has Nodes == nil)
// must not panic when the oplog replay hits the first CreateNode.
func TestApplyCreateNodeOnNilNodesMap(t *testing.T) {
	doc := &brawtv1.Document{
		Id: "doc1", Name: "Untitled", SchemaVersion: 1,
		Pages: []*brawtv1.Page{{Id: "page1", Name: "Page 1"}},
		// Nodes intentionally left nil to simulate a decoded empty-snapshot Document.
	}
	if doc.Nodes != nil {
		t.Fatal("test setup invalid: Nodes must start nil")
	}
	op := &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 10, 20)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create on nil Nodes map: %v", err)
	}
	got, ok := doc.Nodes["n1"]
	if !ok {
		t.Fatal("node n1 not present after create")
	}
	if got.X != 10 || got.Y != 20 {
		t.Fatalf("wrong pos: %v,%v", got.X, got.Y)
	}
}

func textNode(id, content string) *brawtv1.Node {
	return &brawtv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Text", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 200, Height: 24,
		Shape: &brawtv1.Node_Text{Text: &brawtv1.TextNode{
			Content: content,
			Style: &brawtv1.TextStyle{
				FontFamily: "Inter", FontSize: 16, FontWeight: "400", LineHeight: 1.2,
				Align: brawtv1.TextAlign_TEXT_ALIGN_LEFT,
			},
		}},
	}
}

func setTextOp(s *brawtv1.SetText) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_SetText{SetText: s}}
}

func TestApplySetTextChangesContent(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: textNode("t1", "ciao")}}})
	if err := Apply(doc, setTextOp(&brawtv1.SetText{Id: "t1", Content: "nuovo testo"})); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	if got := doc.Nodes["t1"].GetText().GetContent(); got != "nuovo testo" {
		t.Fatalf("content not applied: %q", got)
	}
}

func TestApplySetTextOnNonTextNodeFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	err := Apply(doc, setTextOp(&brawtv1.SetText{Id: "n1", Content: "x"}))
	if err == nil {
		t.Fatal("expected error setting text on a non-text node")
	}
	if doc.Nodes["n1"].GetShape() == nil {
		t.Fatal("shape clobbered by a rejected setText")
	}
	if _, ok := doc.Nodes["n1"].GetShape().(*brawtv1.Node_Rect); !ok {
		t.Fatalf("rect turned into %T by a rejected setText", doc.Nodes["n1"].GetShape())
	}
}

func TestApplySetTextMissingNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, setTextOp(&brawtv1.SetText{Id: "ghost", Content: "x"}))
	if !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
}

// Il caso che distingue "non specificato" da "azzera": in proto3 uno stile
// assente e uno con tutti i campi a zero sono indistinguibili dopo il
// round-trip protojson, quindi senza style_present un SetText di solo contenuto
// azzererebbe lo stile del nodo (font a 0 => testo invisibile).
func TestApplySetTextWithoutStylePresentKeepsStyle(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: textNode("t1", "ciao")}}})
	if err := Apply(doc, setTextOp(&brawtv1.SetText{Id: "t1", Content: "altro"})); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	st := doc.Nodes["t1"].GetText().GetStyle()
	if st.GetFontSize() != 16 || st.GetFontFamily() != "Inter" || st.GetLineHeight() != 1.2 {
		t.Fatalf("style clobbered by a style-less setText: %+v", st)
	}
	// Anche uno `style` esplicito ma con style_present=false va ignorato: è il
	// flag, non la presenza del sotto-messaggio, a decidere.
	op := setTextOp(&brawtv1.SetText{Id: "t1", Content: "terzo", Style: &brawtv1.TextStyle{FontSize: 99}})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	if doc.Nodes["t1"].GetText().GetStyle().GetFontSize() != 16 {
		t.Fatalf("style applied despite style_present=false: %+v", doc.Nodes["t1"].GetText().GetStyle())
	}
}

func TestApplySetTextWithStylePresentReplacesStyle(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: textNode("t1", "ciao")}}})
	op := setTextOp(&brawtv1.SetText{
		Id: "t1", Content: "ciao", StylePresent: true,
		Style: &brawtv1.TextStyle{
			FontFamily: "Inter", FontSize: 32, FontWeight: "700", LineHeight: 1.5,
			Align: brawtv1.TextAlign_TEXT_ALIGN_CENTER,
		},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	st := doc.Nodes["t1"].GetText().GetStyle()
	if st.GetFontSize() != 32 || st.GetFontWeight() != "700" || st.GetAlign() != brawtv1.TextAlign_TEXT_ALIGN_CENTER {
		t.Fatalf("style not replaced: %+v", st)
	}
}

func TestApplyDeleteNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	if err := Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_DeleteNode{DeleteNode: &brawtv1.DeleteNode{Id: "n1"}}}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := doc.Nodes["n1"]; ok {
		t.Fatal("node still present after delete")
	}
}

// --- ImageNode (traccia 3) ---------------------------------------------------

// L'hash di un asset è 64 esadecimali minuscoli (lo sha256 dei byte, vedi
// internal/store/assets.go). Qui ne serve uno solo per forma.
const testAssetHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func imageNode(id, hash string) *brawtv1.Node {
	return &brawtv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Image", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 160, Height: 90,
		Shape: &brawtv1.Node_Image{Image: &brawtv1.ImageNode{AssetHash: hash}},
	}
}

// Un ImageNode porta un RIFERIMENTO, mai dei byte: l'op che lo crea pesa quanto
// un hash, e l'op-log resta un registro di intenzioni invece di un archivio di
// immagini.
func TestApplyCreateImageNodeCarriesOnlyTheHash(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	op := &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: imageNode("i1", testAssetHash)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create: %v", err)
	}
	got := doc.Nodes["i1"]
	if got.GetImage().GetAssetHash() != testAssetHash {
		t.Fatalf("asset hash = %q, want %q", got.GetImage().GetAssetHash(), testAssetHash)
	}
	// La prova che nessun byte di immagine viaggia nell'op: l'op serializzato
	// è dell'ordine dell'hash, non dell'ordine di una foto.
	wire, err := proto.Marshal(op)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) > 256 {
		t.Fatalf("un CreateNode con immagine pesa %d byte: qualcosa oltre l'hash sta viaggiando", len(wire))
	}
}

// Spostare e ridimensionare un'immagine è un setProps come per qualunque altro
// nodo: la forma non c'entra, e soprattutto non viene toccata.
func TestApplySetPropertiesOnImageKeepsTheAssetHash(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: imageNode("i1", testAssetHash)}}})
	op := setPropsOp(&brawtv1.SetProperties{
		Id:    "i1",
		Patch: &brawtv1.Node{X: 300, Y: 400},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "y"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setProps: %v", err)
	}
	got := doc.Nodes["i1"]
	if got.GetX() != 300 || got.GetY() != 400 {
		t.Fatalf("move not applied: x=%v y=%v", got.GetX(), got.GetY())
	}
	if got.GetImage().GetAssetHash() != testAssetHash {
		t.Fatalf("asset hash lost on a move: %q", got.GetImage().GetAssetHash())
	}
}

// Stessa regola di un rettangolo (ErrNotTextNode): scrivere del testo dentro
// un'immagine non è "riempire un campo mancante", è un op sul nodo sbagliato --
// e sostituirebbe la forma, cioè butterebbe via il riferimento all'asset.
func TestApplySetTextOnImageNodeFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: imageNode("i1", testAssetHash)}}})
	if err := Apply(doc, setTextOp(&brawtv1.SetText{Id: "i1", Content: "x"})); !errors.Is(err, ErrNotTextNode) {
		t.Fatalf("expected ErrNotTextNode, got %v", err)
	}
	if doc.Nodes["i1"].GetImage().GetAssetHash() != testAssetHash {
		t.Fatal("a rejected setText clobbered the image")
	}
}
