package diagram

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode"
)

// Flowchart Mermaid: nodi con cinque forme, archi con tre stili, etichette,
// direzione. Di tutto il resto (subgraph, classDef, style, click…) si salta la
// riga invece di rifiutare l'intero diagramma.

type fShape int

const (
	fRect fShape = iota
	fRound
	fStadium
	fCircle
	fDiamond
	fStart // pallino pieno (stati)
	fEnd   // pallino con anello (stati)
)

type fStyle int

const (
	sSolid fStyle = iota
	sDotted
	sThick
)

type flowNode struct {
	ID, Label string
	Shape     fShape
}

type flowEdge struct {
	From, To   string
	Label      string
	Style      fStyle
	ArrowEnd   bool
	ArrowStart bool
}

type flowchart struct {
	Dir   Dir
	Nodes []flowNode
	Edges []flowEdge
}

const (
	MaxNodes = 200
	MaxEdges = 400
)

var flowIgnored = regexp.MustCompile(`^(subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title)\b`)

var shapeDelims = []struct {
	open, close string
	shape       fShape
}{
	{"(((", ")))", fCircle},
	{"((", "))", fCircle},
	{"([", "])", fStadium},
	{"[(", ")]", fRect},
	{"[[", "]]", fRect},
	{"{{", "}}", fDiamond},
	{"[", "]", fRect},
	{"(", ")", fRound},
	{"{", "}", fDiamond},
	{">", "]", fRect},
}

func unquote(s string) string {
	t := strings.TrimSpace(s)
	if len(t) >= 2 && strings.HasPrefix(t, `"`) && strings.HasSuffix(t, `"`) {
		t = t[1 : len(t)-1]
	}
	t = regexp.MustCompile(`(?i)<br\s*/?>`).ReplaceAllString(t, "\n")
	t = strings.ReplaceAll(t, "&quot;", `"`)
	return strings.TrimSpace(t)
}

type cursor struct {
	s []rune
	i int
}

func (c *cursor) rest() string { return string(c.s[c.i:]) }
func (c *cursor) skipWs() {
	for c.i < len(c.s) && unicode.IsSpace(c.s[c.i]) {
		c.i++
	}
}
func (c *cursor) has(p string) bool { return strings.HasPrefix(c.rest(), p) }

func isIDStart(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }
func isIDPart(r rune) bool  { return isIDStart(r) || r == '-' }

// readNode legge `id` e, se c'è, la forma con la sua etichetta.
func readNode(c *cursor) (*flowNode, error) {
	c.skipWs()
	if c.i >= len(c.s) || !isIDStart(c.s[c.i]) {
		return nil, nil
	}
	j := c.i
	for j < len(c.s) && isIDPart(c.s[j]) {
		j++
	}
	id := c.s[c.i:j]
	// Un trattino che apre un arco (`A--B`, `A-->B`) non fa parte dell'id.
	for k := 1; k < len(id); k++ {
		if id[k] != '-' {
			continue
		}
		if k == len(id)-1 || id[k+1] == '-' {
			id = id[:k]
			break
		}
	}
	if len(id) == 0 {
		return nil, nil
	}
	c.i += len(id)
	for _, sh := range shapeDelims {
		if !c.has(sh.open) {
			continue
		}
		start := c.i + len([]rune(sh.open))
		end := -1
		if start < len(c.s) && c.s[start] == '"' {
			if q := indexRune(c.s, '"', start+1); q >= 0 && hasPrefixAt(c.s, sh.close, q+1) {
				end = q + 1
			}
		}
		if end < 0 {
			end = indexStr(c.s, sh.close, start)
		}
		if end < 0 {
			return nil, fmt.Errorf("forma non chiusa dopo %q", string(id))
		}
		label := unquote(string(c.s[start:end]))
		c.i = end + len([]rune(sh.close))
		if label == "" {
			label = string(id)
		}
		return &flowNode{ID: string(id), Label: label, Shape: sh.shape}, nil
	}
	return &flowNode{ID: string(id), Label: string(id), Shape: fRect}, nil
}

func indexRune(s []rune, r rune, from int) int {
	for i := from; i < len(s); i++ {
		if s[i] == r {
			return i
		}
	}
	return -1
}

func hasPrefixAt(s []rune, p string, at int) bool {
	pr := []rune(p)
	if at+len(pr) > len(s) {
		return false
	}
	for i, r := range pr {
		if s[at+i] != r {
			return false
		}
	}
	return true
}

func indexStr(s []rune, p string, from int) int {
	for i := from; i < len(s); i++ {
		if hasPrefixAt(s, p, i) {
			return i
		}
	}
	return -1
}

type edgeTok struct {
	style      fStyle
	arrowEnd   bool
	arrowStart bool
	label      string
}

var (
	reEdgeMid = regexp.MustCompile(`^(--|==|-\.)\s+(.+?)\s+(-{2,}>?|={2,}>?|\.+-+>?)(?:\s|$)`)
	reEdge    = regexp.MustCompile(`^(<)?(-\.+-|-{2,}|={2,})([>xo])?`)
)

func closeKind(t string) edgeTok {
	st := sSolid
	if strings.HasPrefix(t, "=") {
		st = sThick
	} else if strings.Contains(t, ".") {
		st = sDotted
	}
	return edgeTok{style: st, arrowEnd: strings.HasSuffix(t, ">")}
}

func readEdge(c *cursor) (*edgeTok, error) {
	c.skipWs()
	rest := c.rest()
	if m := reEdgeMid.FindStringSubmatch(rest); m != nil && !strings.ContainsAny(m[2][:1], "-=.") {
		c.i += len([]rune(m[0]))
		t := closeKind(m[3])
		t.label = unquote(m[2])
		return &t, nil
	}
	m := reEdge.FindStringSubmatch(rest)
	if m == nil {
		return nil, nil
	}
	c.i += len([]rune(m[0]))
	t := closeKind(m[2])
	t.arrowEnd = m[3] == ">" || m[3] == "x" || m[3] == "o"
	t.arrowStart = m[1] == "<"
	if c.i < len(c.s) && c.s[c.i] == '|' {
		end := indexRune(c.s, '|', c.i+1)
		if end < 0 {
			return nil, fmt.Errorf("etichetta dell'arco non chiusa")
		}
		t.label = unquote(string(c.s[c.i+1 : end]))
		c.i = end + 1
	}
	return &t, nil
}

var (
	reFlowHead = regexp.MustCompile(`(?i)^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$`)
	reComment  = regexp.MustCompile(`%%.*$`)
)

func parseDir(d string) Dir {
	switch strings.ToUpper(d) {
	case "BT":
		return DirBT
	case "LR":
		return DirLR
	case "RL":
		return DirRL
	}
	return DirTD
}

// statements spezza una riga sui `;` fuori dalle virgolette.
func statements(line string) []string {
	var out []string
	var cur strings.Builder
	q := false
	for _, r := range line {
		if r == '"' {
			q = !q
		}
		if r == ';' && !q {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteRune(r)
	}
	return append(out, cur.String())
}

func parseFlowchart(src string) (*flowchart, error) {
	fc := &flowchart{Dir: DirTD}
	idx := map[string]int{}
	touch := func(n *flowNode) error {
		if i, ok := idx[n.ID]; ok {
			if n.Shape != fRect || n.Label != n.ID {
				fc.Nodes[i] = *n
			}
			return nil
		}
		if len(fc.Nodes) >= MaxNodes {
			return fmt.Errorf("troppi nodi (massimo %d)", MaxNodes)
		}
		idx[n.ID] = len(fc.Nodes)
		fc.Nodes = append(fc.Nodes, *n)
		return nil
	}
	sawHeader := false
	for _, raw := range strings.Split(strings.ReplaceAll(src, "\r", ""), "\n") {
		for _, stmt := range statements(raw) {
			stmt = strings.TrimSpace(reComment.ReplaceAllString(stmt, ""))
			if stmt == "" {
				continue
			}
			if m := reFlowHead.FindStringSubmatch(stmt); m != nil {
				sawHeader = true
				fc.Dir = parseDir(m[2])
				continue
			}
			if flowIgnored.MatchString(stmt) {
				continue
			}
			cur := &cursor{s: []rune(stmt)}
			first, err := readNode(cur)
			if err != nil {
				return nil, err
			}
			if first == nil {
				return nil, fmt.Errorf("riga non riconosciuta: %q", clip(stmt, 40))
			}
			if err := touch(first); err != nil {
				return nil, err
			}
			prev := []*flowNode{first}
			for {
				cur.skipWs()
				if cur.i >= len(cur.s) {
					break
				}
				if cur.s[cur.i] == '&' {
					cur.i++
					n, err := readNode(cur)
					if err != nil || n == nil {
						return nil, fmt.Errorf(`dopo "&" manca un nodo: %q`, clip(stmt, 40))
					}
					if err := touch(n); err != nil {
						return nil, err
					}
					prev = append(prev, n)
					continue
				}
				e, err := readEdge(cur)
				if err != nil {
					return nil, err
				}
				if e == nil {
					return nil, fmt.Errorf("riga non riconosciuta: %q", clip(stmt, 40))
				}
				n0, err := readNode(cur)
				if err != nil {
					return nil, err
				}
				if n0 == nil {
					return nil, fmt.Errorf("dopo l'arco manca un nodo: %q", clip(stmt, 40))
				}
				if err := touch(n0); err != nil {
					return nil, err
				}
				next := []*flowNode{n0}
				for {
					cur.skipWs()
					if cur.i >= len(cur.s) || cur.s[cur.i] != '&' {
						break
					}
					cur.i++
					n, err := readNode(cur)
					if err != nil || n == nil {
						return nil, fmt.Errorf(`dopo "&" manca un nodo: %q`, clip(stmt, 40))
					}
					if err := touch(n); err != nil {
						return nil, err
					}
					next = append(next, n)
				}
				for _, a := range prev {
					for _, b := range next {
						if len(fc.Edges) >= MaxEdges {
							return nil, fmt.Errorf("troppi archi (massimo %d)", MaxEdges)
						}
						fc.Edges = append(fc.Edges, flowEdge{From: a.ID, To: b.ID, Label: e.label, Style: e.style, ArrowEnd: e.arrowEnd, ArrowStart: e.arrowStart})
					}
				}
				prev = next
			}
		}
	}
	if len(fc.Nodes) == 0 {
		if sawHeader {
			return nil, fmt.Errorf("il diagramma non ha nodi")
		}
		return nil, fmt.Errorf("nessun nodo trovato")
	}
	return fc, nil
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// --- disegno -------------------------------------------------------------------

func flowSize(n flowNode) (w, h float64) {
	tw, th := textW(n.Label, fontSize), textH(n.Label, fontSize)
	switch n.Shape {
	case fDiamond:
		return math.Max(104, tw*1.7+24), math.Max(68, th*1.9+24)
	case fCircle:
		d := math.Max(60, math.Max(tw+30, th+30))
		return d, d
	case fStadium:
		return math.Max(92, tw+44), math.Max(44, th+22)
	case fStart:
		return 20, 20
	case fEnd:
		return 26, 26
	}
	return math.Max(80, tw+32), math.Max(44, th+22)
}

const (
	margin     = 28.0
	nodeGap    = 44.0
	rankGap    = 64.0
	labelPad   = 6.0
	loopOffset = 26.0
)

func renderFlowchart(fc *flowchart) *Scene {
	idx := map[string]int{}
	for i, n := range fc.Nodes {
		idx[n.ID] = i
	}
	lnodes := make([]lnode, len(fc.Nodes))
	for i, n := range fc.Nodes {
		w, h := flowSize(n)
		lnodes[i] = lnode{w, h}
	}
	ledges := make([]ledge, len(fc.Edges))
	for i, e := range fc.Edges {
		ledges[i] = ledge{idx[e.From], idx[e.To]}
	}
	gapY := rankGap
	for _, e := range fc.Edges {
		if e.Label != "" {
			gapY += 24 // le etichette stanno sull'arco: serve spazio fra i livelli
			break
		}
	}
	lay := layered(lnodes, ledges, fc.Dir, nodeGap, gapY)
	vertical := fc.Dir.vertical()

	type placedEdge struct {
		pts   []Pt
		label Pt
	}
	pe := make([]placedEdge, len(fc.Edges))
	nodeRect := func(i int) (x, y, w, h float64) {
		return lay.Pos[i].X, lay.Pos[i].Y, lnodes[i].W, lnodes[i].H
	}
	clipTo := func(i int, toward Pt) Pt {
		x, y, w, h := nodeRect(i)
		switch fc.Nodes[i].Shape {
		case fDiamond:
			return clipDiamond(x, y, w, h, toward)
		case fCircle, fStart, fEnd:
			return clipEllipse(x, y, w, h, toward)
		}
		return clipRect(x, y, w, h, toward)
	}
	for i, e := range fc.Edges {
		a, b := idx[e.From], idx[e.To]
		if a == b {
			x, y, w, h := nodeRect(a)
			var r []Pt
			if vertical {
				r = []Pt{{x + w, y + h*0.3}, {x + w + loopOffset, y + h*0.3}, {x + w + loopOffset, y + h*0.7}, {x + w, y + h*0.7}}
				pe[i] = placedEdge{r, Pt{r[1].X + 4, (r[1].Y + r[2].Y) / 2}}
			} else {
				r = []Pt{{x + w*0.3, y + h}, {x + w*0.3, y + h + loopOffset}, {x + w*0.7, y + h + loopOffset}, {x + w*0.7, y + h}}
				pe[i] = placedEdge{r, Pt{(r[1].X + r[2].X) / 2, r[1].Y + 12}}
			}
			continue
		}
		pts := append([]Pt(nil), lay.Paths[i]...)
		pts[0] = clipTo(a, pts[1])
		pts[len(pts)-1] = clipTo(b, pts[len(pts)-2])
		pe[i] = placedEdge{pts, midpointOf(pts)}
	}
	spreadParallel(len(fc.Edges), func(i int) (int, int) { return idx[fc.Edges[i].From], idx[fc.Edges[i].To] }, func(i int, dx, dy float64) {
		for k := range pe[i].pts {
			pe[i].pts[k].X += dx
			pe[i].pts[k].Y += dy
		}
		pe[i].label = midpointOf(pe[i].pts)
	}, func(i int) []Pt { return pe[i].pts }, func(i int) float64 {
		if l := fc.Edges[i].Label; l != "" {
			return textW(l, fontSize) + 2*labelPad + 8
		}
		return 0
	})

	// riquadro del contenuto
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	grow := func(x, y float64) {
		minX, minY = math.Min(minX, x), math.Min(minY, y)
		maxX, maxY = math.Max(maxX, x), math.Max(maxY, y)
	}
	for i := range fc.Nodes {
		x, y, w, h := nodeRect(i)
		grow(x, y)
		grow(x+w, y+h)
	}
	for i, e := range fc.Edges {
		for _, p := range pe[i].pts {
			grow(p.X, p.Y)
		}
		if e.Label != "" {
			hw, hh := textW(e.Label, fontSize)/2+labelPad, textH(e.Label, fontSize)/2+3
			grow(pe[i].label.X-hw, pe[i].label.Y-hh)
			grow(pe[i].label.X+hw, pe[i].label.Y+hh)
		}
	}
	dx, dy := margin-minX, margin-minY
	sh := func(p Pt) Pt { return Pt{p.X + dx, p.Y + dy} }

	sc := &Scene{W: maxX - minX + 2*margin, H: maxY - minY + 2*margin}
	for i, e := range fc.Edges {
		pts := make([]Pt, len(pe[i].pts))
		for k, p := range pe[i].pts {
			pts[k] = sh(p)
		}
		ln := Line{Pts: pts, Color: colLine, Dashed: e.Style == sDotted, Weight: 1.5, Name: fmt.Sprintf("Arco %s → %s", e.From, e.To)}
		if e.Style == sThick {
			ln.Weight = 3
		}
		if e.ArrowEnd {
			ln.End = HeadArrow
		}
		if e.ArrowStart {
			ln.Start = HeadArrow
		}
		sc.add(ln)
		if e.Label != "" {
			addLabel(sc, e.Label, sh(pe[i].label))
		}
	}
	for i, n := range fc.Nodes {
		x, y, w, h := nodeRect(i)
		x, y = x+dx, y+dy
		nm := name("Nodo", n.Label)
		switch n.Shape {
		case fStart:
			sc.add(Box{X: x, Y: y, W: w, H: h, Shape: ShapeEllipse, Fill: rgb(colInk), Stroke: rgb(colInk), StrokeW: 1, Name: "Inizio"})
			continue
		case fEnd:
			sc.add(Box{X: x, Y: y, W: w, H: h, Shape: ShapeEllipse, Fill: rgb(colWhite), Stroke: rgb(colInk), StrokeW: 1.5, Name: "Fine"},
				Box{X: x + 6, Y: y + 6, W: w - 12, H: h - 12, Shape: ShapeEllipse, Fill: rgb(colInk), Name: "Fine (centro)"})
			continue
		}
		b := Box{X: x, Y: y, W: w, H: h, Fill: rgb(colNodeFill), Stroke: rgb(colNodeLine), StrokeW: 1.5, Name: nm}
		switch n.Shape {
		case fDiamond:
			b.Shape = ShapeDiamond
		case fCircle:
			b.Shape = ShapeEllipse
		case fStadium:
			b.Shape = ShapeStadium
		case fRound:
			b.Shape, b.Radius = ShapeRound, 12
		default:
			b.Shape, b.Radius = ShapeRect, 4
		}
		sc.add(b)
		if n.Label != "" {
			th := textH(n.Label, fontSize)
			sc.add(Text{X: x + 6, Y: y + h/2 - th/2, W: w - 12, H: th, Content: n.Label, Size: fontSize, Align: "center", Color: colInk, Name: name("Etichetta", n.Label)})
		}
	}
	return sc
}

// addLabel disegna un'etichetta d'arco: testo su un riquadro bianco.
func addLabel(sc *Scene, label string, at Pt) {
	w, h := textW(label, fontSize)+2*labelPad, textH(label, fontSize)+6
	sc.add(
		Box{X: at.X - w/2, Y: at.Y - h/2, W: w, H: h, Shape: ShapeRound, Radius: 4, Fill: rgb(colWhite), Stroke: rgb(RGB{0.8, 0.82, 0.86}), StrokeW: 1, Name: "Sfondo etichetta"},
		Text{X: at.X - w/2, Y: at.Y - h/2 + 3, W: w, H: h - 6, Content: label, Size: fontSize, Align: "center", Color: colInk, Name: name("Etichetta", label)},
	)
}

// spreadParallel separa gli archi che collegano la stessa coppia di nodi (anche
// in versi opposti): senza, `A --> B` e `B --> A` si disegnerebbero uno
// sull'altro. Ogni arco del gruppo si sposta di lato di un passo fisso, in
// modo simmetrico, nella direzione perpendicolare al segmento medio.
func spreadParallel(n int, ends func(i int) (int, int), move func(i int, dx, dy float64), pts func(i int) []Pt, width func(i int) float64) {
	groups := map[[2]int][]int{}
	var keys [][2]int
	for i := 0; i < n; i++ {
		a, b := ends(i)
		if a == b {
			continue
		}
		if a > b {
			a, b = b, a
		}
		k := [2]int{a, b}
		if _, ok := groups[k]; !ok {
			keys = append(keys, k)
		}
		groups[k] = append(groups[k], i)
	}
	for _, k := range keys {
		g := groups[k]
		if len(g) < 2 {
			continue
		}
		// normale fissa per il gruppo: dal nodo minore al maggiore
		p := pts(g[0])
		a, _ := ends(g[0])
		var d Pt
		if a == k[0] {
			d = unit(p[0], p[len(p)-1])
		} else {
			d = unit(p[len(p)-1], p[0])
		}
		nx, ny := -d.Y, d.X
		// il passo è largo quanto la più larga delle etichette: così non si toccano
		step := 22.0
		for _, i := range g {
			step = math.Max(step, width(i))
		}
		for j, i := range g {
			off := (float64(j) - float64(len(g)-1)/2) * step
			move(i, nx*off, ny*off)
		}
	}
}
