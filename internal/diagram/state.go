package diagram

import (
	"fmt"
	"regexp"
	"strings"
)

// stateDiagram(-v2): si riduce a un flowchart -- stati come rettangoli
// arrotondati, [*] come pallino di inizio/fine, <<choice>> come rombo -- e si
// disegna con lo stesso motore. Gli stati composti (`state X { … }`) si
// appiattiscono: le loro transizioni interne restano, il riquadro no, ma ogni
// composito ha il proprio [*].

var (
	reStateTrans = regexp.MustCompile(`^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)(?:\s*:\s*(.*))?$`)
	reStateDecl  = regexp.MustCompile(`^state\s+"([^"]*)"\s+as\s+([\w.-]+)\s*$`)
	reStateKind  = regexp.MustCompile(`^state\s+([\w.-]+)\s+<<(choice|fork|join)>>\s*$`)
	reStateOpen  = regexp.MustCompile(`^state\s+(?:"([^"]*)"\s+as\s+)?([\w.-]+)\s*\{\s*$`)
	reStateDesc  = regexp.MustCompile(`^([\w.-]+)\s*:\s*(.+)$`)
	reStateHead  = regexp.MustCompile(`(?i)^stateDiagram(?:-v2)?\s*$`)
	reStateDir   = regexp.MustCompile(`(?i)^direction\s+(TB|TD|BT|LR|RL)\s*$`)
)

func parseState(src string) (*flowchart, error) {
	fc := &flowchart{Dir: DirTD}
	idx := map[string]int{}
	ensure := func(id string) (*flowNode, error) {
		if i, ok := idx[id]; ok {
			return &fc.Nodes[i], nil
		}
		if len(fc.Nodes) >= MaxNodes {
			return nil, fmt.Errorf("troppi stati (massimo %d)", MaxNodes)
		}
		idx[id] = len(fc.Nodes)
		fc.Nodes = append(fc.Nodes, flowNode{ID: id, Label: id, Shape: fRound})
		return &fc.Nodes[idx[id]], nil
	}
	var scope []string
	special := func(tok string, isTarget bool) string {
		if tok != "[*]" {
			return tok
		}
		s := strings.Join(scope, "/")
		if isTarget {
			return "[*]end:" + s
		}
		return "[*]start:" + s
	}
	inNote := false
	for _, raw := range strings.Split(strings.ReplaceAll(src, "\r", ""), "\n") {
		line := strings.TrimSpace(reComment.ReplaceAllString(raw, ""))
		if line == "" || reStateHead.MatchString(line) {
			continue
		}
		if inNote {
			if strings.EqualFold(line, "end note") {
				inNote = false
			}
			continue
		}
		if strings.HasPrefix(strings.ToLower(line), "note ") {
			if !strings.Contains(line, ":") {
				inNote = true
			}
			continue
		}
		if m := reStateDir.FindStringSubmatch(line); m != nil {
			fc.Dir = parseDir(m[1])
			continue
		}
		if line == "}" {
			if len(scope) > 0 {
				scope = scope[:len(scope)-1]
			}
			continue
		}
		if m := reStateOpen.FindStringSubmatch(line); m != nil {
			n, err := ensure(m[2])
			if err != nil {
				return nil, err
			}
			if m[1] != "" {
				n.Label = m[1]
			}
			scope = append(scope, m[2])
			continue
		}
		if m := reStateDecl.FindStringSubmatch(line); m != nil {
			n, err := ensure(m[2])
			if err != nil {
				return nil, err
			}
			n.Label = m[1]
			continue
		}
		if m := reStateKind.FindStringSubmatch(line); m != nil {
			n, err := ensure(m[1])
			if err != nil {
				return nil, err
			}
			n.Shape, n.Label = fDiamond, ""
			continue
		}
		if m := reStateTrans.FindStringSubmatch(line); m != nil {
			from, to := special(m[1], false), special(m[2], true)
			for _, id := range []string{from, to} {
				n, err := ensure(id)
				if err != nil {
					return nil, err
				}
				if strings.HasPrefix(id, "[*]start") {
					n.Shape, n.Label = fStart, ""
				} else if strings.HasPrefix(id, "[*]end") {
					n.Shape, n.Label = fEnd, ""
				}
			}
			if len(fc.Edges) >= MaxEdges {
				return nil, fmt.Errorf("troppe transizioni (massimo %d)", MaxEdges)
			}
			fc.Edges = append(fc.Edges, flowEdge{From: from, To: to, Label: unquote(m[3]), ArrowEnd: true})
			continue
		}
		if m := reStateDesc.FindStringSubmatch(line); m != nil {
			n, err := ensure(m[1])
			if err != nil {
				return nil, err
			}
			if n.Label == n.ID {
				n.Label = n.ID + "\n" + unquote(m[2])
			} else {
				n.Label += "\n" + unquote(m[2])
			}
			continue
		}
		if reFlowHead.MatchString(line) {
			return nil, fmt.Errorf("riga non valida in uno stateDiagram: %q", clip(line, 40))
		}
		// Un identificatore da solo dichiara lo stato.
		if regexp.MustCompile(`^[\w.-]+$`).MatchString(line) {
			if _, err := ensure(line); err != nil {
				return nil, err
			}
			continue
		}
		return nil, fmt.Errorf("riga non riconosciuta: %q", clip(line, 40))
	}
	if len(fc.Nodes) == 0 {
		return nil, fmt.Errorf("il diagramma non ha stati")
	}
	return fc, nil
}
