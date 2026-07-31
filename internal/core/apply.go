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

func applyDelete(doc *brawtv1.Document, d *brawtv1.DeleteNode) error {
	if _, ok := doc.Nodes[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, d.GetId())
	}
	// M0: nessun figlio annidato ancora → nessuna cascata. (Aggiunta in M1+.)
	delete(doc.Nodes, d.GetId())
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
		case "x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fills":
			// supported
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
		}
	}
	return nil
}
