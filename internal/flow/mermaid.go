package flow

import (
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Mermaid draws the flows (flowID "" = all) as a Mermaid flowchart: the other direction of the diagram import
// (internal/diagram reads Mermaid text and draws it; this writes the flows as text that reads back).
//
//   - a screen is a node (`flow.kind`: a decision is a diamond, a start or an end a pill, an action rounded, the rest
//     a rectangle);
//   - a transition is an edge, labelled with its label, or its trigger when that is not a plain click, and its guard
//     in brackets; `auto` and `back` transitions are dotted;
//   - with several flows, each is a `subgraph` with its own node ids, so a screen shared by two flows appears in both.
//
// The output is stable: same document, same bytes.
func Mermaid(doc *opendesignerv1.Document, flowID string) string {
	var b strings.Builder
	b.WriteString("flowchart LR\n")
	ids := flowIDs(doc, flowID)
	if len(ids) == 0 {
		b.WriteString("  %% no flow in the document\n")
		return b.String()
	}
	many := len(ids) > 1
	for i, id := range ids {
		g := buildGraph(doc, id)
		indent := "  "
		if many {
			title := g.flow.GetName()
			if title == "" {
				title = id
			}
			fmt.Fprintf(&b, "  subgraph f%d [%s]\n", i+1, mermaidText(title))
			indent = "    "
		}
		node := map[string]string{}
		for j, sid := range g.screens {
			nid := fmt.Sprintf("f%dn%d", i+1, j+1)
			node[sid] = nid
			b.WriteString(indent + mermaidNode(nid, nodeName(doc, sid), nodeKind(doc, sid)) + "\n")
		}
		for _, t := range g.trans {
			arrow := "-->"
			if tr := t.GetTrigger(); tr == "auto" || tr == "back" {
				arrow = "-.->"
			}
			label := edgeLabel(t)
			if label != "" {
				arrow += "|" + label + "|"
			}
			fmt.Fprintf(&b, "%s%s %s %s\n", indent, node[t.GetFromId()], arrow, node[t.GetToId()])
		}
		if many {
			b.WriteString("  end\n")
		}
	}
	return b.String()
}

func mermaidNode(id, name, kind string) string {
	label := mermaidText(name)
	switch kind {
	case "decision":
		return fmt.Sprintf(`%s{"%s"}`, id, label)
	case "start", KindEnd:
		return fmt.Sprintf(`%s(["%s"])`, id, label)
	case "action":
		return fmt.Sprintf(`%s("%s")`, id, label)
	}
	return fmt.Sprintf(`%s["%s"]`, id, label)
}

// edgeLabel is what is written on the arrow: the label, else the trigger when it is not a plain click, then the
// guard in brackets.
func edgeLabel(t *opendesignerv1.Transition) string {
	label := oneLine(t.GetLabel())
	if label == "" {
		if tr := t.GetTrigger(); tr != "" && tr != "click" {
			label = tr
		}
	}
	if g := oneLine(t.GetGuard()); g != "" {
		if label != "" {
			label += " "
		}
		label += "[" + g + "]"
	}
	return mermaidText(strings.ReplaceAll(label, "|", "/"))
}

// mermaidText makes a name safe inside Mermaid's quotes and bars.
func mermaidText(s string) string {
	return strings.ReplaceAll(oneLine(s), `"`, "'")
}
