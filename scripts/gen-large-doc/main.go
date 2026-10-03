// gen-large-doc scrive in un workspace un documento sintetico di N nodi, per
// provare l'editor su file grandi: una griglia di frame ritaglianti con una
// ventina di figli ciascuno (rettangoli, ellissi, testi).
//
//	go run ./scripts/gen-large-doc -workspace /tmp/ws -nodes 20000
//
// Scrive direttamente lo snapshot (nessuna op nel log), quindi è istantaneo; poi
// `opendesigner serve -workspace /tmp/ws` lo serve e l'id stampato si apre con
// http://localhost:8080/#doc=<id>.
package main

import (
	"flag"
	"fmt"
	"log"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/store"
	"github.com/google/uuid"
)

func main() {
	workspace := flag.String("workspace", "", "directory dei documenti")
	nodes := flag.Int("nodes", 20000, "numero approssimato di nodi")
	name := flag.String("name", "", "nome del documento (default: large-<nodes>)")
	flag.Parse()
	if *workspace == "" {
		log.Fatal("serve -workspace")
	}
	docName := *name
	if docName == "" {
		docName = fmt.Sprintf("large-%d", *nodes)
	}

	id := uuid.NewString()
	b, err := store.Open(*workspace, id, docName)
	if err != nil {
		log.Fatal(err)
	}
	doc := core.NewDocument(id, docName)

	// PRNG deterministico: due esecuzioni producono lo stesso documento.
	state := uint32(1)
	rnd := func() float64 {
		state = state*1664525 + 1013904223
		return float64(state) / 4294967296
	}
	const perFrame = 20
	frames := int(math.Max(1, math.Round(float64(*nodes)/(perFrame+1))))
	cols := int(math.Ceil(math.Sqrt(float64(frames))))
	key := 0
	nextKey := func() string { k := fmt.Sprintf("a%07d", key); key++; return k }
	create := func(n *opendesignerv1.Node) {
		if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); err != nil {
			log.Fatal(err)
		}
	}
	solid := func(r, g, bl float64) []*opendesignerv1.Paint {
		return []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{
			Color: &opendesignerv1.Color{R: float32(r), G: float32(g), B: float32(bl), A: 1}}}}}
	}
	for f := 0; f < frames; f++ {
		fid := fmt.Sprintf("f%d", f)
		create(&opendesignerv1.Node{
			Id: fid, ParentId: "page1", OrderKey: nextKey(), Name: fid, Visible: true, Opacity: 1,
			X: float64(f%cols) * 420, Y: float64(f/cols) * 320, Width: 400, Height: 300,
			Fills: solid(1, 1, 1),
			Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: true}},
		})
		for i := 0; i < perFrame; i++ {
			n := &opendesignerv1.Node{
				Id: fmt.Sprintf("n%d_%d", f, i), ParentId: fid, OrderKey: nextKey(), Visible: true, Opacity: 1,
				X: rnd() * 300, Y: rnd() * 220, Width: 30 + rnd()*90, Height: 20 + rnd()*60,
				Fills: solid(rnd(), rnd(), rnd()),
			}
			n.Name = n.Id
			switch {
			case i%5 == 0:
				n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{
					Content: "Lorem ipsum dolor", Style: &opendesignerv1.TextStyle{FontSize: 14}}}
			case i%3 == 0:
				n.Shape = &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}}
			default:
				n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 6}}
			}
			create(n)
		}
	}
	if err := b.Snapshot(doc, 0); err != nil {
		log.Fatal(err)
	}
	fmt.Println(id)
}
