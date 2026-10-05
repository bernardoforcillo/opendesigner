package diagram

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

// classDiagram UML: classi con tre scomparti (nome, attributi, metodi),
// annotazioni (<<interface>>), relazioni con la loro decorazione UML:
//
//	<|--  ereditarietà     *--  composizione    o--  aggregazione
//	-->   associazione     ..>  dipendenza      ..|> realizzazione
//	--    collegamento     ..   collegamento tratteggiato
//
// con molteplicità ("1", "0..*") ed etichetta. Il genitore (chi porta il
// triangolo o il rombo) sta sopra.

type classDef struct {
	ID, Label, Annot string
	Attrs, Methods   []string
}

type headMark int

const (
	mNone headMark = iota
	mTriangle
	mDiamondFilled
	mDiamond
	mArrow
)

type classRel struct {
	A, B         string
	Left, Right  headMark // decorazione sul lato A / sul lato B
	Dashed       bool
	CardA, CardB string
	Label        string
	topIsA       bool
}

type classDiagram struct {
	Dir     Dir
	Classes []classDef
	Rels    []classRel
}

const classIdent = `[A-Za-z_][\w]*(?:~[^~]*~)?`

var (
	reClassHead   = regexp.MustCompile(`(?i)^classDiagram(?:-v2)?\s*$`)
	reClassDir    = regexp.MustCompile(`(?i)^direction\s+(TB|TD|BT|LR|RL)\s*$`)
	reClassDecl   = regexp.MustCompile(`^class\s+(` + classIdent + `)(?:\s*\[\s*"([^"]*)"\s*\])?\s*(\{)?\s*$`)
	reClassMember = regexp.MustCompile(`^(` + classIdent + `)\s*:\s*(.+)$`)
	reClassAnnot  = regexp.MustCompile(`^<<\s*([^>]+?)\s*>>\s*(` + classIdent + `)?\s*$`)
	reClassRel    = regexp.MustCompile(`^(` + classIdent + `)\s*(?:"([^"]*)"\s*)?(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)\s*(?:"([^"]*)"\s*)?(` + classIdent + `)\s*(?::\s*(.*))?$`)
)

func classID(raw string) (id, label string) {
	if i := strings.Index(raw, "~"); i > 0 {
		j := strings.LastIndex(raw, "~")
		if j > i {
			return raw[:i], raw[:i] + "<" + raw[i+1:j] + ">"
		}
		return raw[:i], raw[:i]
	}
	return raw, raw
}

func parseClass(src string) (*classDiagram, error) {
	cd := &classDiagram{Dir: DirTD}
	idx := map[string]int{}
	ensure := func(raw string) (*classDef, error) {
		id, label := classID(raw)
		if i, ok := idx[id]; ok {
			if label != id {
				cd.Classes[i].Label = label
			}
			return &cd.Classes[i], nil
		}
		if len(cd.Classes) >= MaxNodes {
			return nil, fmt.Errorf("troppe classi (massimo %d)", MaxNodes)
		}
		idx[id] = len(cd.Classes)
		cd.Classes = append(cd.Classes, classDef{ID: id, Label: label})
		return &cd.Classes[idx[id]], nil
	}
	addMember := func(c *classDef, m string) {
		m = strings.TrimSpace(m)
		if m == "" {
			return
		}
		if a := reClassAnnot.FindStringSubmatch(m); a != nil && a[2] == "" {
			c.Annot = a[1]
			return
		}
		if strings.Contains(m, "(") {
			c.Methods = append(c.Methods, m)
		} else {
			c.Attrs = append(c.Attrs, m)
		}
	}
	body := ""
	for _, raw := range strings.Split(strings.ReplaceAll(src, "\r", ""), "\n") {
		line := strings.TrimSpace(reComment.ReplaceAllString(raw, ""))
		if line == "" || reClassHead.MatchString(line) {
			continue
		}
		if body != "" {
			if line == "}" {
				body = ""
				continue
			}
			c, _ := ensure(body)
			addMember(c, line)
			continue
		}
		if m := reClassDir.FindStringSubmatch(line); m != nil {
			cd.Dir = parseDir(m[1])
			continue
		}
		if strings.HasPrefix(line, "note ") || strings.HasPrefix(line, "style ") || strings.HasPrefix(line, "classDef ") || strings.HasPrefix(line, "cssClass ") || strings.HasPrefix(line, "click ") || strings.HasPrefix(line, "link ") || strings.HasPrefix(line, "callback ") {
			continue
		}
		if m := reClassDecl.FindStringSubmatch(line); m != nil {
			c, err := ensure(m[1])
			if err != nil {
				return nil, err
			}
			if m[2] != "" {
				c.Label = m[2]
			}
			if m[3] != "" {
				body = m[1]
			}
			continue
		}
		if m := reClassAnnot.FindStringSubmatch(line); m != nil && m[2] != "" {
			c, err := ensure(m[2])
			if err != nil {
				return nil, err
			}
			c.Annot = m[1]
			continue
		}
		if m := reClassRel.FindStringSubmatch(line); m != nil {
			a, err := ensure(m[1])
			if err != nil {
				return nil, err
			}
			b, err := ensure(m[5])
			if err != nil {
				return nil, err
			}
			if len(cd.Rels) >= MaxEdges {
				return nil, fmt.Errorf("troppe relazioni (massimo %d)", MaxEdges)
			}
			r := classRel{A: a.ID, B: b.ID, CardA: m[2], CardB: m[4], Label: strings.TrimSpace(m[6])}
			tok := m[3]
			r.Dashed = strings.Contains(tok, "..")
			switch tok {
			case "<|--", "<|..":
				r.Left = mTriangle
			case "--|>", "..|>":
				r.Right = mTriangle
			case "*--":
				r.Left = mDiamondFilled
			case "--*":
				r.Right = mDiamondFilled
			case "o--":
				r.Left = mDiamond
			case "--o":
				r.Right = mDiamond
			case "<--", "<..":
				r.Left = mArrow
			case "-->", "..>":
				r.Right = mArrow
			}
			r.topIsA = true
			switch {
			case r.Left == mTriangle || r.Left == mDiamond || r.Left == mDiamondFilled:
				r.topIsA = true
			case r.Right == mTriangle || r.Right == mDiamond || r.Right == mDiamondFilled:
				r.topIsA = false
			case r.Left == mArrow:
				r.topIsA = false
			}
			cd.Rels = append(cd.Rels, r)
			continue
		}
		if m := reClassMember.FindStringSubmatch(line); m != nil {
			c, err := ensure(m[1])
			if err != nil {
				return nil, err
			}
			addMember(c, m[2])
			continue
		}
		return nil, fmt.Errorf("riga non riconosciuta: %q", clip(line, 40))
	}
	if len(cd.Classes) == 0 {
		return nil, fmt.Errorf("il diagramma non ha classi")
	}
	return cd, nil
}

const (
	memSize  = 12.0
	memLine  = 17.0
	headBase = 30.0
)

func classBox(c classDef) (w, h, headH, attrH, methH float64) {
	nameW := textW(c.Label, fontSize) + 28
	w = math.Max(120, nameW)
	for _, m := range c.Attrs {
		w = math.Max(w, textW(m, memSize)+24)
	}
	for _, m := range c.Methods {
		w = math.Max(w, textW(m, memSize)+24)
	}
	if c.Annot != "" {
		w = math.Max(w, textW("«"+c.Annot+"»", memSize)+28)
	}
	headH = headBase
	if c.Annot != "" {
		headH += 16
	}
	attrH = math.Max(float64(len(c.Attrs))*memLine+10, 16)
	methH = math.Max(float64(len(c.Methods))*memLine+10, 16)
	return w, headH + attrH + methH, headH, attrH, methH
}

func heads(m headMark) HeadKind {
	switch m {
	case mTriangle:
		return HeadTriangle
	case mDiamondFilled:
		return HeadDiamondFilled
	case mDiamond:
		return HeadDiamond
	case mArrow:
		return HeadOpen
	}
	return HeadNone
}

func renderClass(cd *classDiagram) *Scene {
	idx := map[string]int{}
	for i, c := range cd.Classes {
		idx[c.ID] = i
	}
	n := len(cd.Classes)
	lnodes := make([]lnode, n)
	for i, c := range cd.Classes {
		w, h, _, _, _ := classBox(c)
		lnodes[i] = lnode{w, h}
	}
	ledges := make([]ledge, len(cd.Rels))
	for i, r := range cd.Rels {
		a, b := idx[r.A], idx[r.B]
		if r.topIsA {
			ledges[i] = ledge{a, b}
		} else {
			ledges[i] = ledge{b, a}
		}
	}
	lay := layered(lnodes, ledges, cd.Dir, 56, 84)
	vertical := cd.Dir.vertical()

	type placed struct {
		pts        []Pt
		label      Pt
		ca, cb     Pt // posizioni delle molteplicità
		dirA, dirB Pt
	}
	pl := make([]placed, len(cd.Rels))
	rect := func(i int) (x, y, w, h float64) { return lay.Pos[i].X, lay.Pos[i].Y, lnodes[i].W, lnodes[i].H }
	for i, r := range cd.Rels {
		a, b := idx[r.A], idx[r.B]
		var pts []Pt
		if a == b {
			x, y, w, h := rect(a)
			if vertical {
				pts = []Pt{{x + w, y + h*0.3}, {x + w + loopOffset, y + h*0.3}, {x + w + loopOffset, y + h*0.7}, {x + w, y + h*0.7}}
			} else {
				pts = []Pt{{x + w*0.3, y + h}, {x + w*0.3, y + h + loopOffset}, {x + w*0.7, y + h + loopOffset}, {x + w*0.7, y + h}}
			}
		} else {
			path := append([]Pt(nil), lay.Paths[i]...)
			// il cammino va da "sopra" a "sotto": si orienta da A a B
			if !r.topIsA {
				for p, q := 0, len(path)-1; p < q; p, q = p+1, q-1 {
					path[p], path[q] = path[q], path[p]
				}
			}
			ax, ay, aw, ah := rect(a)
			bx, by, bw, bh := rect(b)
			path[0] = clipRect(ax, ay, aw, ah, path[1])
			path[len(path)-1] = clipRect(bx, by, bw, bh, path[len(path)-2])
			pts = path
		}
		p := placed{pts: pts, label: midpointOf(pts)}
		p.dirA, p.dirB = unit(pts[0], pts[1]), unit(pts[len(pts)-1], pts[len(pts)-2])
		pl[i] = p
	}

	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	grow := func(x, y float64) {
		minX, minY = math.Min(minX, x), math.Min(minY, y)
		maxX, maxY = math.Max(maxX, x), math.Max(maxY, y)
	}
	for i := range cd.Classes {
		x, y, w, h := rect(i)
		grow(x, y)
		grow(x+w, y+h)
	}
	for i, r := range cd.Rels {
		for _, p := range pl[i].pts {
			grow(p.X, p.Y)
		}
		if r.Label != "" {
			hw, hh := textW(r.Label, fontSize)/2+labelPad, textH(r.Label, fontSize)/2+3
			grow(pl[i].label.X-hw, pl[i].label.Y-hh)
			grow(pl[i].label.X+hw, pl[i].label.Y+hh)
		}
		// le molteplicità sporgono dalle estremità
		grow(pl[i].pts[0].X-24, pl[i].pts[0].Y-24)
		grow(pl[i].pts[0].X+24, pl[i].pts[0].Y+24)
		e := pl[i].pts[len(pl[i].pts)-1]
		grow(e.X-24, e.Y-24)
		grow(e.X+24, e.Y+24)
	}
	dx, dy := margin-minX, margin-minY
	sh := func(p Pt) Pt { return Pt{p.X + dx, p.Y + dy} }
	sc := &Scene{W: maxX - minX + 2*margin, H: maxY - minY + 2*margin}

	for i, r := range cd.Rels {
		pts := make([]Pt, len(pl[i].pts))
		for k, p := range pl[i].pts {
			pts[k] = sh(p)
		}
		sc.add(Line{Pts: pts, Color: colLine, Dashed: r.Dashed, Weight: 1.5, Start: heads(r.Left), End: heads(r.Right), Name: fmt.Sprintf("Relazione %s – %s", r.A, r.B)})
		if r.Label != "" {
			addLabel(sc, r.Label, sh(pl[i].label))
		}
		card := func(s string, end Pt, dir Pt) {
			if s == "" {
				return
			}
			// 18 px lungo la linea, 12 di lato
			p := Pt{end.X + dir.X*20 - dir.Y*14, end.Y + dir.Y*20 + dir.X*14}
			w := textW(s, memSize) + 6
			sc.add(Text{X: p.X - w/2, Y: p.Y - memSize*lineMul/2, W: w, H: memSize * lineMul, Content: s, Size: memSize, Align: "center", Color: colMuted, Name: "Molteplicità " + s})
		}
		card(r.CardA, pts[0], pl[i].dirA)
		card(r.CardB, pts[len(pts)-1], pl[i].dirB)
	}

	for i, c := range cd.Classes {
		x, y, _, _ := rect(i)
		x, y = x+dx, y+dy
		w, h, headH, attrH, _ := classBox(c)
		sc.add(Box{X: x, Y: y, W: w, H: h, Shape: ShapeRect, Fill: rgb(colWhite), Stroke: rgb(colNodeLine), StrokeW: 1.5, Name: "Classe " + c.Label})
		sc.add(Box{X: x, Y: y, W: w, H: headH, Shape: ShapeRect, Fill: rgb(colHeader), Stroke: rgb(colNodeLine), StrokeW: 1.5, Name: "Intestazione " + c.Label})
		ty := y + 8
		if c.Annot != "" {
			sc.add(Text{X: x + 4, Y: ty - 2, W: w - 8, H: memSize * lineMul, Content: "«" + c.Annot + "»", Size: memSize, Align: "center", Color: colMuted, Name: "Annotazione"})
			ty += 16
		}
		sc.add(Text{X: x + 4, Y: ty, W: w - 8, H: fontSize * lineMul, Content: c.Label, Size: fontSize, Bold: true, Align: "center", Color: colInk, Name: "Nome " + c.Label})
		sc.add(Line{Pts: []Pt{{x, y + headH + attrH}, {x + w, y + headH + attrH}}, Color: colNodeLine, Weight: 1.5, Name: "Separatore"})
		for k, m := range c.Attrs {
			sc.add(Text{X: x + 10, Y: y + headH + 5 + float64(k)*memLine, W: w - 20, H: memSize * lineMul, Content: m, Size: memSize, Align: "left", Color: colInk, Name: "Attributo " + m})
		}
		for k, m := range c.Methods {
			sc.add(Text{X: x + 10, Y: y + headH + attrH + 5 + float64(k)*memLine, W: w - 20, H: memSize * lineMul, Content: m, Size: memSize, Align: "left", Color: colInk, Name: "Metodo " + m})
		}
	}
	return sc
}
