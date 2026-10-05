// Package diagram disegna diagrammi a partire da testo Mermaid -- flowchart e
// i tre UML che Mermaid sa descrivere (classi, sequenza, stati) -- e li
// trasforma in nodi normali del documento (un gruppo di forme, vettori e testo).
//
// È puro: nessun accesso al documento. Lo usano l'RPC RenderDiagram (l'editor
// inserisce i nodi in un gesto solo) e i tool MCP create_diagram /
// update_diagram (un agente li inserisce come sequenza di op). Stesso testo,
// stessi nodi a meno degli id.
package diagram

import (
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Chiavi di `meta` sulla radice di un diagramma: bastano a riconoscerlo, a
// rileggerne il testo e a ridisegnarlo (update_diagram).
const (
	MetaKind   = "diagram.kind"
	MetaSource = "diagram.source"
)

// Tipi di diagramma.
const (
	KindFlowchart = "flowchart"
	KindClass     = "class"
	KindSequence  = "sequence"
	KindState     = "state"
)

// Result è il diagramma disegnato.
type Result struct {
	Kind          string
	Nodes         []*opendesignerv1.Node // pre-ordine; Nodes[0] è la radice
	Width, Height float64
	Warnings      []string
}

// Error è un errore del TESTO del diagramma (non del server): il chiamante lo
// mostra così com'è.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func fail(format string, a ...any) error { return &Error{fmt.Sprintf(format, a...)} }

// MaxSourceBytes limita il testo: oltre non è un diagramma, è un abuso.
const MaxSourceBytes = 64 * 1024

var unsupported = []string{"erDiagram", "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline", "quadrantChart", "requirementDiagram", "C4Context", "sankey", "xychart", "block", "architecture", "kanban", "packet"}

// Detect riconosce il tipo dalla prima riga significativa.
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
				return "", fail("il diagramma %q non è supportato: si leggono flowchart, classDiagram, sequenceDiagram e stateDiagram", word)
			}
		}
		// Senza intestazione si assume un flowchart, come fa lo strumento.
		return KindFlowchart, nil
	}
	return "", fail("il testo del diagramma è vuoto")
}

// Render disegna `source`.
func Render(source string) (*Result, error) {
	if len(source) > MaxSourceBytes {
		return nil, fail("il testo del diagramma è troppo lungo (massimo %d KiB)", MaxSourceBytes/1024)
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
