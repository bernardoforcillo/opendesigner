// Package diagram draws diagrams from Mermaid text -- flowchart and
// the three UML ones Mermaid can describe (class, sequence, state) -- and
// turns them into normal document nodes (a group of shapes, vectors and text).
//
// It is pure: no access to the document. It is used by the RenderDiagram RPC (the editor
// inserts the nodes in a single gesture) and by the MCP tools create_diagram /
// update_diagram (an agent inserts them as a sequence of ops). Same text,
// same nodes up to the ids.
package diagram

import (
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// `meta` keys on a diagram's root: enough to recognize it, to
// re-read its text and to redraw it (update_diagram).
const (
	MetaKind   = "diagram.kind"
	MetaSource = "diagram.source"
)

// Diagram kinds.
const (
	KindFlowchart = "flowchart"
	KindClass     = "class"
	KindSequence  = "sequence"
	KindState     = "state"
)

// Result is the drawn diagram.
type Result struct {
	Kind          string
	Nodes         []*opendesignerv1.Node // pre-order; Nodes[0] is the root
	Width, Height float64
	Warnings      []string
}

// Error is an error in the diagram's TEXT (not the server's): the caller
// shows it as is.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func fail(format string, a ...any) error { return &Error{fmt.Sprintf(format, a...)} }

// MaxSourceBytes limits the text: beyond that it is not a diagram, it is abuse.
const MaxSourceBytes = 64 * 1024

var unsupported = []string{"erDiagram", "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline", "quadrantChart", "requirementDiagram", "C4Context", "sankey", "xychart", "block", "architecture", "kanban", "packet"}

// Detect recognizes the kind from the first significant line.
func Detect(src string) (kind string, err error) {
	for _, raw := range strings.Split(src, "\n") {
		l := strings.TrimSpace(strings.TrimPrefix(raw, "\uFEFF"))
		if l == "" || strings.HasPrefix(l, "%%") {
			continue
		}
		word := strings.Fields(l)[0]
		lw := strings.ToLower(word)
		switch {
		case lw == "flowchart" || lw == "graph":
			return KindFlowchart, nil
		case lw == "classdiagram" || lw == "classdiagram-v2":
			return KindClass, nil
		case lw == "sequencediagram":
			return KindSequence, nil
		case lw == "statediagram" || lw == "statediagram-v2":
			return KindState, nil
		}
		for _, u := range unsupported {
			if strings.EqualFold(word, u) || strings.HasPrefix(strings.ToLower(word), strings.ToLower(u)+"-") {
				return "", fail("diagram %q is not supported: flowchart, classDiagram, sequenceDiagram and stateDiagram are supported", word)
			}
		}
		// Without a header a flowchart is assumed, as the tool does.
		return KindFlowchart, nil
	}
	return "", fail("the diagram text is empty")
}

// Render draws `source`.
func Render(source string) (*Result, error) {
	if len(source) > MaxSourceBytes {
		return nil, fail("the diagram text is too long (maximum %d KiB)", MaxSourceBytes/1024)
	}
	kind, err := Detect(source)
	if err != nil {
		return nil, err
	}
	var sc *Scene
	switch kind {
	case KindFlowchart:
		fc, perr := parseFlowchart(source)
		if perr != nil {
			return nil, fail("%s", perr.Error())
		}
		sc = renderFlowchart(fc)
	case KindState:
		fc, perr := parseState(source)
		if perr != nil {
			return nil, fail("%s", perr.Error())
		}
		sc = renderFlowchart(fc)
	case KindClass:
		cd, perr := parseClass(source)
		if perr != nil {
			return nil, fail("%s", perr.Error())
		}
		sc = renderClass(cd)
	case KindSequence:
		sd, perr := parseSequence(source)
		if perr != nil {
			return nil, fail("%s", perr.Error())
		}
		sc = renderSequence(sd)
	}
	return &Result{Kind: kind, Nodes: buildNodes(sc, kind, source), Width: r2(sc.W), Height: r2(sc.H)}, nil
}
