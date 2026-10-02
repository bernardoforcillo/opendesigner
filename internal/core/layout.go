package core

import (
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// AUTO LAYOUT -- la metà Go (l'autorità) di web/src/store/layout.ts.
//
// Un frame con `auto_layout` dispone i figli in fila. Il risultato non è uno
// stato a parte: sono x/y dei figli (e width/height del frame, se hug) scritti
// nel documento come qualunque altro campo, dopo OGNI op che può cambiarli. Così
// un client che non sa nulla di auto layout -- un agente MCP, uno strumento di
// export -- legge posizioni già giuste.
//
// Le due implementazioni (Go e TS) devono dare gli STESSI numeri: sono float64
// da entrambe le parti, quindi basta fare le stesse operazioni nello stesso
// ordine. Due precauzioni lo rendono vero:
//   - nessuna moltiplicazione sommata a qualcos'altro nella stessa espressione:
//     su alcune architetture il compilatore Go può FONDERLE (FMA), cambiando
//     l'ultimo bit rispetto a JS. Ogni prodotto passa da float64() esplicito,
//     che per la spec vieta la fusione;
//   - l'ordine dei figli è quello di ChildrenOf (order_key, poi id).
// La fixture testdata/golden/auto_layout.json, eseguita da entrambi i lati, lo
// fissa.
//
// Cosa partecipa: i figli VISIBILI con una misura propria -- rettangolo,
// ellisse, testo, immagine, vettoriale, frame. Gruppi e istanze restano dove
// sono: i loro bounds sono derivati dai figli e non c'è una misura da disporre.

// layoutKind riporta se il nodo ha una misura propria da disporre.
func participates(n *opendesignerv1.Node) bool {
	if !n.GetVisible() {
		return false
	}
	switch n.GetShape().(type) {
	case nil,
		*opendesignerv1.Node_Rect, *opendesignerv1.Node_Ellipse, *opendesignerv1.Node_Text,
		*opendesignerv1.Node_Image, *opendesignerv1.Node_Vector, *opendesignerv1.Node_Frame:
		return true
	}
	return false
}

func autoLayoutOf(n *opendesignerv1.Node) *opendesignerv1.AutoLayout {
	if n == nil {
		return nil
	}
	return n.GetFrame().GetAutoLayout()
}

// layoutFrame ridispone i figli di UN frame e, se hug, ne ridimensiona gli assi.
// Non fa nulla per un nodo che non è un frame con auto layout.
func layoutFrame(doc *opendesignerv1.Document, id string, cow *Shared) {
	frame := doc.GetNodes()[id]
	al := autoLayoutOf(frame)
	if al == nil {
		return
	}
	frame = cow.mut(doc, id)
	al = autoLayoutOf(frame)
	vertical := al.GetDirection() == opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL

	var kids []*opendesignerv1.Node
	for _, c := range ChildrenOf(doc, id) {
		if participates(c) {
			kids = append(kids, cow.mut(doc, c.GetId()))
		}
	}

	// Gli assi nello spazio del frame: "main" è quello della direzione.
	// padMain*/padCross* sono i margini lungo ciascun asse.
	padL, padT, padR, padB := al.GetPaddingLeft(), al.GetPaddingTop(), al.GetPaddingRight(), al.GetPaddingBottom()
	var padMainStart, padMainEnd, padCrossStart, padCrossEnd float64
	var hugMain, hugCross bool
	if vertical {
		padMainStart, padMainEnd, padCrossStart, padCrossEnd = padT, padB, padL, padR
		hugMain, hugCross = al.GetHugHeight(), al.GetHugWidth()
	} else {
		padMainStart, padMainEnd, padCrossStart, padCrossEnd = padL, padR, padT, padB
		hugMain, hugCross = al.GetHugWidth(), al.GetHugHeight()
	}
	mainOf := func(n *opendesignerv1.Node) float64 {
		if vertical {
			return n.GetHeight()
		}
		return n.GetWidth()
	}
	crossOf := func(n *opendesignerv1.Node) float64 {
		if vertical {
			return n.GetWidth()
		}
		return n.GetHeight()
	}

	spacing := al.GetSpacing()
	var sum, maxCross float64
	for _, k := range kids {
		sum += mainOf(k)
		if c := crossOf(k); c > maxCross {
			maxCross = c
		}
	}
	gaps := float64(0)
	if len(kids) > 1 {
		gaps = float64(spacing * float64(len(kids)-1))
	}

	frameMain, frameCross := mainOf(frame), crossOf(frame)
	if hugMain {
		frameMain = padMainStart + sum + gaps + padMainEnd
	}
	if hugCross {
		frameCross = padCrossStart + maxCross + padCrossEnd
	}
	if vertical {
		frame.Width, frame.Height = frameCross, frameMain
	} else {
		frame.Width, frame.Height = frameMain, frameCross
	}

	innerMain := frameMain - padMainStart - padMainEnd
	innerCross := frameCross - padCrossStart - padCrossEnd
	free := innerMain - sum - gaps

	pos := padMainStart
	step := spacing
	switch al.GetMainAlign() {
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
		pos = padMainStart + free/2
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
		pos = padMainStart + free
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN:
		// Con meno di due figli non c'è fra cosa distribuire: resta a inizio.
		// Se lo spazio non basta (free < 0) non si comprime sotto `spacing`.
		if len(kids) > 1 && free > 0 {
			step = spacing + free/float64(len(kids)-1)
		}
	}

	for _, k := range kids {
		cross := padCrossStart
		switch al.GetCrossAlign() {
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
			cross = padCrossStart + (innerCross-crossOf(k))/2
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
			cross = padCrossStart + (innerCross - crossOf(k))
		}
		if vertical {
			k.X, k.Y = cross, pos
		} else {
			k.X, k.Y = pos, cross
		}
		pos = pos + mainOf(k) + step
	}
}

// layoutTargets elenca i frame il cui layout può cambiare per effetto di `op`,
// letti dallo stato `doc` (che per questo si interroga PRIMA e DOPO l'op: un
// nodo cancellato o spostato lascia il vecchio parent solo nello stato di
// prima). Può contenere id che non sono frame con auto layout o che non
// esistono più: layoutFrame li ignora.
func layoutTargets(doc *opendesignerv1.Document, op *opendesignerv1.Op) []string {
	parentOf := func(id string) []string {
		if n := doc.GetNodes()[id]; n != nil {
			return []string{n.GetParentId()}
		}
		return nil
	}
	switch k := op.GetKind().(type) {
	case *opendesignerv1.Op_CreateNode:
		n := k.CreateNode.GetNode()
		return []string{n.GetParentId(), n.GetId()}
	case *opendesignerv1.Op_DeleteNode:
		return parentOf(k.DeleteNode.GetId())
	case *opendesignerv1.Op_ReparentNode:
		return append(parentOf(k.ReparentNode.GetId()), k.ReparentNode.GetNewParentId())
	case *opendesignerv1.Op_SetProps:
		return append(parentOf(k.SetProps.GetId()), k.SetProps.GetId())
	case *opendesignerv1.Op_SetVectorPath:
		return parentOf(k.SetVectorPath.GetId())
	}
	return nil
}

// relayout ridispone i frame toccati e risale: un frame che cambia misura (hug)
// sposta i suoi fratelli, quindi il layout del suo parent va rifatto, e così via
// finché il parent non è un frame con auto layout.
//
// Ordine: dal PIÙ PROFONDO. Un frame hug dentro un altro deve avere la misura
// giusta PRIMA che il contenitore la legga.
func relayout(doc *opendesignerv1.Document, ids []string, cow *Shared) {
	seen := map[string]bool{}
	depth := func(id string) int {
		d := 0
		for cur := doc.GetNodes()[id]; cur != nil && d <= len(doc.GetNodes()); cur = doc.GetNodes()[cur.GetParentId()] {
			d++
		}
		return d
	}
	var frames []string
	for _, id := range ids {
		if id != "" && !seen[id] && autoLayoutOf(doc.GetNodes()[id]) != nil {
			seen[id] = true
			frames = append(frames, id)
		}
	}
	// Anche gli antenati con auto layout: la misura di un hug li riguarda.
	for _, id := range append([]string(nil), frames...) {
		cur := doc.GetNodes()[id]
		for guard := 0; cur != nil && guard <= len(doc.GetNodes()); guard++ {
			p := doc.GetNodes()[cur.GetParentId()]
			if p == nil {
				break
			}
			if autoLayoutOf(p) != nil && !seen[p.GetId()] {
				seen[p.GetId()] = true
				frames = append(frames, p.GetId())
			}
			cur = p
		}
	}
	sort.SliceStable(frames, func(i, j int) bool {
		di, dj := depth(frames[i]), depth(frames[j])
		if di != dj {
			return di > dj
		}
		return frames[i] < frames[j]
	})
	for _, id := range frames {
		layoutFrame(doc, id, cow)
	}
}
