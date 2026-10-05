package diagram

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

// sequenceDiagram UML: partecipanti con linea di vita, messaggi (sincroni,
// di risposta tratteggiati, asincroni, persi), auto-messaggi, attivazioni
// (`+`/`-`, activate/deactivate), note, numerazione automatica e frammenti
// combinati (loop, alt/else, opt, par/and, critical/option, break).

type seqPart struct {
	ID, Label string
	Actor     bool
}

type seqEv struct {
	Kind     string // msg | note | start | else | end | activate | deactivate
	From, To string
	Text     string
	Dashed   bool
	Head     HeadKind
	Act      bool // `+` sul destinatario
	Deact    bool // `-`: disattiva il mittente
	Mode     string
	Over     []string
	Block    string
}

type seqDiagram struct {
	Parts []seqPart
	Evs   []seqEv
	Auto  bool
}

var (
	reSeqHead  = regexp.MustCompile(`(?i)^sequenceDiagram\s*$`)
	reSeqPart  = regexp.MustCompile(`^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$`)
	reSeqNote  = regexp.MustCompile(`(?i)^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$`)
	reSeqBlock = regexp.MustCompile(`^(loop|alt|opt|par|critical|break|rect|box)\b\s*(.*)$`)
	reSeqElse  = regexp.MustCompile(`^(else|and|option)\b\s*(.*)$`)
	reSeqAct   = regexp.MustCompile(`^(activate|deactivate)\s+(\S+)\s*$`)
	reSeqMsg   = regexp.MustCompile(`^(.+?)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*([+-]?)\s*(\S.*?)\s*:\s*(.*)$`)
)

func parseSequence(src string) (*seqDiagram, error) {
	sd := &seqDiagram{}
	idx := map[string]int{}
	part := func(id string) error {
		if _, ok := idx[id]; ok {
			return nil
		}
		if len(sd.Parts) >= 60 {
			return fmt.Errorf("troppi partecipanti (massimo 60)")
		}
		idx[id] = len(sd.Parts)
		sd.Parts = append(sd.Parts, seqPart{ID: id, Label: id})
		return nil
	}
	depth := 0
	for _, raw := range strings.Split(strings.ReplaceAll(src, "\r", ""), "\n") {
		line := strings.TrimSpace(reComment.ReplaceAllString(raw, ""))
		if line == "" || reSeqHead.MatchString(line) {
			continue
		}
		low := strings.ToLower(line)
		switch {
		case low == "autonumber":
			sd.Auto = true
			continue
		case strings.HasPrefix(low, "title ") || strings.HasPrefix(low, "title:") || strings.HasPrefix(low, "link ") || strings.HasPrefix(low, "links ") || strings.HasPrefix(low, "properties ") || strings.HasPrefix(low, "details "):
			continue
		}
		if m := reSeqPart.FindStringSubmatch(line); m != nil {
			if err := part(m[2]); err != nil {
				return nil, err
			}
			p := &sd.Parts[idx[m[2]]]
			p.Actor = m[1] == "actor"
			if m[3] != "" {
				p.Label = unquote(m[3])
			}
			continue
		}
		if m := reSeqNote.FindStringSubmatch(line); m != nil {
			ev := seqEv{Kind: "note", Text: unquote(m[3])}
			switch strings.ToLower(m[1]) {
			case "left of":
				ev.Mode = "left"
			case "right of":
				ev.Mode = "right"
			default:
				ev.Mode = "over"
			}
			for _, id := range strings.Split(m[2], ",") {
				id = strings.TrimSpace(id)
				if id == "" {
					continue
				}
				if err := part(id); err != nil {
					return nil, err
				}
				ev.Over = append(ev.Over, id)
			}
			if len(ev.Over) == 0 || (ev.Mode != "over" && len(ev.Over) != 1) {
				return nil, fmt.Errorf("nota senza partecipante: %q", clip(line, 40))
			}
			sd.Evs = append(sd.Evs, ev)
			continue
		}
		if m := reSeqAct.FindStringSubmatch(line); m != nil {
			if err := part(m[2]); err != nil {
				return nil, err
			}
			sd.Evs = append(sd.Evs, seqEv{Kind: m[1], To: m[2], From: m[2]})
			continue
		}
		if m := reSeqBlock.FindStringSubmatch(line); m != nil {
			depth++
			sd.Evs = append(sd.Evs, seqEv{Kind: "start", Block: m[1], Text: unquote(m[2])})
			continue
		}
		if m := reSeqElse.FindStringSubmatch(line); m != nil && depth > 0 {
			sd.Evs = append(sd.Evs, seqEv{Kind: "else", Block: m[1], Text: unquote(m[2])})
			continue
		}
		if low == "end" {
			if depth == 0 {
				return nil, fmt.Errorf(`"end" senza un blocco aperto`)
			}
			depth--
			sd.Evs = append(sd.Evs, seqEv{Kind: "end"})
			continue
		}
		if m := reSeqMsg.FindStringSubmatch(line); m != nil {
			from, to := strings.TrimSpace(m[1]), strings.TrimSpace(m[4])
			if err := part(from); err != nil {
				return nil, err
			}
			if err := part(to); err != nil {
				return nil, err
			}
			ev := seqEv{Kind: "msg", From: from, To: to, Text: unquote(m[5]), Act: m[3] == "+", Deact: m[3] == "-"}
			switch m[2] {
			case "->>":
				ev.Head = HeadArrow
			case "-->>":
				ev.Head, ev.Dashed = HeadArrow, true
			case "->":
			case "-->":
				ev.Dashed = true
			case "-x":
				ev.Head = HeadCross
			case "--x":
				ev.Head, ev.Dashed = HeadCross, true
			case "-)":
				ev.Head = HeadOpen
			case "--)":
				ev.Head, ev.Dashed = HeadOpen, true
			}
			sd.Evs = append(sd.Evs, ev)
			if len(sd.Evs) > 2000 {
				return nil, fmt.Errorf("troppi eventi (massimo 2000)")
			}
			continue
		}
		return nil, fmt.Errorf("riga non riconosciuta: %q", clip(line, 40))
	}
	if depth > 0 {
		return nil, fmt.Errorf(`manca "end" per chiudere un blocco`)
	}
	if len(sd.Parts) == 0 {
		return nil, fmt.Errorf("il diagramma non ha partecipanti")
	}
	return sd, nil
}

type seqBlock struct {
	kind, label string
	startY      float64
	minX, maxX  float64
	dividers    []seqDivider
}

type seqDivider struct {
	y     float64
	label string
}

const (
	seqSize = 13.0
	actW    = 10.0
	seqPad  = 14.0
)

func renderSequence(sd *seqDiagram) *Scene {
	n := len(sd.Parts)
	idx := map[string]int{}
	bw := make([]float64, n)
	hh := 40.0
	for i, p := range sd.Parts {
		idx[p.ID] = i
		bw[i] = math.Max(100, textW(p.Label, fontSize)+28)
		hh = math.Max(hh, textH(p.Label, fontSize)+20)
	}
	// distanze fra i centri
	gap := make([]float64, n)
	for i := 0; i+1 < n; i++ {
		gap[i] = (bw[i]+bw[i+1])/2 + 24
	}
	need := func(p, q int, w float64) {
		if p > q {
			p, q = q, p
		}
		if p == q || q > n-1 {
			return
		}
		cur := 0.0
		for i := p; i < q; i++ {
			cur += gap[i]
		}
		if cur < w {
			add := (w - cur) / float64(q-p)
			for i := p; i < q; i++ {
				gap[i] += add
			}
		}
	}
	for _, e := range sd.Evs {
		switch e.Kind {
		case "msg":
			w := textW(e.Text, seqSize) + 40
			if e.From == e.To {
				need(idx[e.From], idx[e.From]+1, w+40)
			} else {
				need(idx[e.From], idx[e.To], w)
			}
		case "note":
			w := textW(e.Text, seqSize) + 24
			a := idx[e.Over[0]]
			switch e.Mode {
			case "left":
				need(a-1, a, w+20)
			case "right":
				need(a, a+1, w+20)
			default:
				if len(e.Over) > 1 {
					b := idx[e.Over[len(e.Over)-1]]
					need(a, b, w)
				}
			}
		}
	}
	cx := make([]float64, n)
	cx[0] = bw[0] / 2
	for i := 1; i < n; i++ {
		cx[i] = cx[i-1] + gap[i-1]
	}

	var back, life, front []any
	y := hh + 26
	minX, maxX := math.Inf(1), math.Inf(-1)
	extend := func(x0, x1 float64) {
		minX, maxX = math.Min(minX, x0), math.Max(maxX, x1)
	}
	for i := range sd.Parts {
		extend(cx[i]-bw[i]/2, cx[i]+bw[i]/2)
	}
	var blocks []*seqBlock
	touch := func(x0, x1 float64) {
		if len(blocks) > 0 {
			b := blocks[len(blocks)-1]
			b.minX, b.maxX = math.Min(b.minX, x0), math.Max(b.maxX, x1)
		}
		extend(x0, x1)
	}
	acts := make([][]float64, n)
	drawAct := func(p int, from, to float64) {
		d := float64(len(acts[p]))
		front = append(front, Box{X: cx[p] - actW/2 + d*4, Y: from, W: actW, H: math.Max(to-from, 6), Shape: ShapeRect, Fill: rgb(colHeader), Stroke: rgb(colNodeLine), StrokeW: 1, Name: "Attivazione " + sd.Parts[p].Label})
	}
	num := 0
	for _, e := range sd.Evs {
		switch e.Kind {
		case "msg":
			label := e.Text
			if sd.Auto {
				num++
				label = fmt.Sprintf("%d. %s", num, label)
			}
			th := 0.0
			if label != "" {
				th = textH(label, seqSize)
			}
			f, t := idx[e.From], idx[e.To]
			lineY := y + th + 14
			if label == "" {
				lineY = y + 18
			}
			if f == t {
				x0 := cx[f] + float64(len(acts[f]))*4 + actW/2
				pts := []Pt{{x0, lineY}, {x0 + 34, lineY}, {x0 + 34, lineY + 24}, {x0, lineY + 24}}
				front = append(front, Line{Pts: pts, Color: colLine, Dashed: e.Dashed, Weight: 1.5, End: e.Head, Name: "Messaggio " + clip(label, 30)})
				if label != "" {
					w := textW(label, seqSize) + 8
					front = append(front, Text{X: x0 + 40, Y: lineY - 2, W: w, H: th, Content: label, Size: seqSize, Align: "left", Color: colInk, Name: name("Etichetta", label)})
					touch(x0, x0+40+w)
				} else {
					touch(x0, x0+34)
				}
				if e.Act {
					acts[t] = append(acts[t], lineY+24)
				}
				if e.Deact && len(acts[f]) > 0 {
					s := acts[f][len(acts[f])-1]
					acts[f] = acts[f][:len(acts[f])-1]
					drawAct(f, s, lineY)
				}
				y = lineY + 24 + 18
			} else {
				xf, xt := cx[f], cx[t]
				// la linea tocca il bordo dell'attivazione, non il centro
				if t > f {
					xf += float64(len(acts[f])) * 4 * 0
					xt -= actW / 2 * boolf(len(acts[t]) > 0 || e.Act)
				} else {
					xt += actW / 2 * boolf(len(acts[t]) > 0 || e.Act)
				}
				front = append(front, Line{Pts: []Pt{{xf, lineY}, {xt, lineY}}, Color: colLine, Dashed: e.Dashed, Weight: 1.5, End: e.Head, Name: "Messaggio " + clip(label, 30)})
				if label != "" {
					x0 := math.Min(cx[f], cx[t])
					front = append(front, Text{X: x0, Y: lineY - th - 5, W: math.Abs(cx[t] - cx[f]), H: th, Content: label, Size: seqSize, Align: "center", Color: colInk, Name: name("Etichetta", label)})
				}
				touch(math.Min(cx[f], cx[t]), math.Max(cx[f], cx[t]))
				if e.Act {
					acts[t] = append(acts[t], lineY)
				}
				if e.Deact && len(acts[f]) > 0 {
					s := acts[f][len(acts[f])-1]
					acts[f] = acts[f][:len(acts[f])-1]
					drawAct(f, s, lineY)
				}
				y = lineY + 18
			}
		case "activate":
			p := idx[e.To]
			acts[p] = append(acts[p], y)
			y += 6
		case "deactivate":
			p := idx[e.To]
			if len(acts[p]) > 0 {
				s := acts[p][len(acts[p])-1]
				acts[p] = acts[p][:len(acts[p])-1]
				drawAct(p, s, y)
			}
			y += 6
		case "note":
			tw := textW(e.Text, seqSize) + 24
			th := textH(e.Text, seqSize)
			a := idx[e.Over[0]]
			var x0, x1 float64
			switch e.Mode {
			case "left":
				x1, x0 = cx[a]-10, cx[a]-10-tw
			case "right":
				x0, x1 = cx[a]+10, cx[a]+10+tw
			default:
				b := idx[e.Over[len(e.Over)-1]]
				lo, hi := math.Min(cx[a], cx[b])-30, math.Max(cx[a], cx[b])+30
				if hi-lo < tw {
					mid := (lo + hi) / 2
					lo, hi = mid-tw/2, mid+tw/2
				}
				x0, x1 = lo, hi
			}
			h := th + 14
			front = append(front,
				Box{X: x0, Y: y, W: x1 - x0, H: h, Shape: ShapeRect, Fill: rgb(colNote), Stroke: rgb(colNoteLine), StrokeW: 1, Name: "Nota"},
				Text{X: x0 + 4, Y: y + 7, W: x1 - x0 - 8, H: th, Content: e.Text, Size: seqSize, Align: "center", Color: colInk, Name: name("Nota", e.Text)})
			touch(x0, x1)
			y += h + 14
		case "start":
			blocks = append(blocks, &seqBlock{kind: e.Block, label: e.Text, startY: y, minX: math.Inf(1), maxX: math.Inf(-1)})
			y += 34
		case "else":
			if len(blocks) > 0 {
				b := blocks[len(blocks)-1]
				b.dividers = append(b.dividers, seqDivider{y + 2, e.Text})
			}
			y += 30
		case "end":
			if len(blocks) == 0 {
				continue
			}
			b := blocks[len(blocks)-1]
			blocks = blocks[:len(blocks)-1]
			if math.IsInf(b.minX, 1) {
				b.minX, b.maxX = cx[0]-bw[0]/2, cx[n-1]+bw[n-1]/2
			}
			x0, x1 := b.minX-seqPad, b.maxX+seqPad
			endY := y + 4
			if b.kind != "rect" && b.kind != "box" {
				w, h := x1-x0, endY-b.startY
				back = append(back, Box{X: x0, Y: b.startY, W: w, H: h, Shape: ShapeRect, Stroke: rgb(colMuted), StrokeW: 1, Name: "Frammento " + b.kind})
				tabW := textW(b.kind, seqSize) + 20
				back = append(back,
					Box{X: x0, Y: b.startY, W: tabW, H: 22, Shape: ShapeRect, Fill: rgb(colFrag), Stroke: rgb(colMuted), StrokeW: 1, Name: "Etichetta frammento"},
					Text{X: x0, Y: b.startY + 4, W: tabW, H: seqSize * lineMul, Content: b.kind, Size: seqSize, Bold: true, Align: "center", Color: colInk, Name: "Tipo " + b.kind})
				if b.label != "" {
					back = append(back, Text{X: x0 + tabW + 8, Y: b.startY + 4, W: textW("["+b.label+"]", seqSize) + 8, H: seqSize * lineMul, Content: "[" + b.label + "]", Size: seqSize, Align: "left", Color: colMuted, Name: name("Condizione", b.label)})
				}
				for _, d := range b.dividers {
					back = append(back, Line{Pts: []Pt{{x0, d.y}, {x1, d.y}}, Color: colMuted, Dashed: true, Weight: 1, Name: "Divisore frammento"})
					if d.label != "" {
						back = append(back, Text{X: x0 + 8, Y: d.y + 4, W: textW("["+d.label+"]", seqSize) + 8, H: seqSize * lineMul, Content: "[" + d.label + "]", Size: seqSize, Align: "left", Color: colMuted, Name: name("Condizione", d.label)})
					}
				}
			}
			// il frammento contiene i figli: il genitore li include con un po' d'aria
			if len(blocks) > 0 {
				p := blocks[len(blocks)-1]
				p.minX, p.maxX = math.Min(p.minX, x0), math.Max(p.maxX, x1)
			}
			extend(x0, x1)
			y += 18
		}
	}
	for len(blocks) > 0 { // difensivo: il parser garantisce la chiusura
		blocks = blocks[:len(blocks)-1]
	}
	y += 8
	for p := range acts {
		for len(acts[p]) > 0 {
			s := acts[p][len(acts[p])-1]
			acts[p] = acts[p][:len(acts[p])-1]
			drawAct(p, s, y)
		}
	}
	footY := y + 10
	for i, p := range sd.Parts {
		life = append(life, Line{Pts: []Pt{{cx[i], hh}, {cx[i], footY}}, Color: RGB{0.62, 0.66, 0.72}, Dashed: true, Weight: 1, Name: "Linea di vita " + p.Label})
	}
	var heads []any
	for i, p := range sd.Parts {
		for _, top := range []float64{0, footY} {
			b := Box{X: cx[i] - bw[i]/2, Y: top, W: bw[i], H: hh, Shape: ShapeRect, Radius: 4, Fill: rgb(colNodeFill), Stroke: rgb(colNodeLine), StrokeW: 1.5, Name: "Partecipante " + p.Label}
			if p.Actor {
				b.Shape, b.Name = ShapeStadium, "Attore "+p.Label
			}
			th := textH(p.Label, fontSize)
			heads = append(heads, b, Text{X: b.X + 6, Y: top + hh/2 - th/2, W: bw[i] - 12, H: th, Content: p.Label, Size: fontSize, Bold: true, Align: "center", Color: colInk, Name: name("Nome", p.Label)})
		}
	}
	sc := &Scene{}
	sc.Items = append(sc.Items, back...)
	sc.Items = append(sc.Items, life...)
	sc.Items = append(sc.Items, front...)
	sc.Items = append(sc.Items, heads...)
	sc.shift(margin-minX, margin)
	sc.W = maxX - minX + 2*margin
	sc.H = footY + hh + 2*margin
	return sc
}

func boolf(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
