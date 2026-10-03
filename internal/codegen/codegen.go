// Package codegen esporta il design come codice: dal documento (scene graph +
// flussi) a un progetto che si apre nel browser e che i test e2e generati da
// internal/flow possono pilotare.
//
// Pipeline, UNA sola implementazione per CLI, MCP e RPC:
//
//	Document -> schermate -> IR (ir.go, build.go) -> renderer (html.go | react.go)
//
// L'IR è un albero di elementi con proprietà CSS in ordine; i due renderer
// leggono lo stesso albero e scrivono CSS in un <style> (target html) oppure
// classi Tailwind (target react, tailwind.go), così le due uscite non possono
// divergere. L'output è DETERMINISTICO: ogni mappa del documento si legge in
// ordine esplicito, e lo stesso documento produce gli stessi byte (golden file,
// diff nei PR).
//
// La semantica del disegno è quella del CANVAS dell'editor
// (web/src/renderer/canvasRenderer.ts), non quella di un editor "tipico": solo
// il primo riempimento, la prima ombra e la prima sfocatura, opacità non
// ereditata dai figli, un frame senza riempimento è trasparente e una forma
// senza riempimento è grigia. Dove CSS non può dire la stessa cosa il commento
// del punto lo spiega e docs/codegen.md lo elenca.
package codegen

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
	"google.golang.org/protobuf/proto"
)

// Target del codice generato.
type Target string

const (
	// TargetHTML: un file HTML autocontenuto per schermata (CSS in <style>,
	// navigazione con <a href>).
	TargetHTML Target = "html"
	// TargetReact: progetto Vite + React + TypeScript + Tailwind v4 +
	// react-router-dom, con i test Playwright dei flussi.
	TargetReact Target = "react"
)

// Options regola la generazione.
type Options struct {
	// Target: html o react (default react).
	Target Target
	// FlowID limita il cablaggio (e i test) a un flusso; vuoto = tutti.
	FlowID string
}

// AssetSource fornisce i byte delle immagini del documento per hash. Può
// essere nil: le immagini diventano segnaposto.
type AssetSource interface {
	Asset(hash string) ([]byte, error)
}

// File è un file generato; Path è relativo alla radice dell'output, con "/".
type File struct {
	Path    string
	Content []byte
}

// Output è l'insieme dei file, ordinato per percorso.
type Output struct {
	Files []File
	// Warnings: cose che il generatore ha dovuto approssimare o omettere
	// (asset mancanti, istanze orfane, transizioni verso nodi non esportati).
	Warnings []string
}

// Generate esporta `doc`. Non modifica il documento.
func Generate(doc *opendesignerv1.Document, opts Options, assets AssetSource) (*Output, error) {
	if doc == nil {
		return nil, errors.New("documento assente")
	}
	if opts.Target == "" {
		opts.Target = TargetReact
	}
	if opts.Target != TargetHTML && opts.Target != TargetReact {
		return nil, fmt.Errorf("target %q sconosciuto: usa %q o %q", opts.Target, TargetReact, TargetHTML)
	}
	if opts.FlowID != "" {
		if _, ok := doc.GetFlows()[opts.FlowID]; !ok {
			return nil, fmt.Errorf("flusso %q non trovato nel documento", opts.FlowID)
		}
	}
	// Lavoriamo su una COPIA: la rotta di default delle schermate si scrive nei
	// meta (serve a flow.PlaywrightTests, che legge `code.route`) senza toccare
	// il documento di chi chiama.
	d := proto.Clone(doc).(*opendesignerv1.Document)

	out := &Output{}
	screens := collectScreens(d, opts.FlowID, &out.Warnings)
	if len(screens) == 0 {
		return nil, errors.New("il documento non ha schermate da esportare: servono frame di primo livello in una pagina")
	}
	assignNames(d, screens, opts)

	files := map[string][]byte{}
	b := &builder{doc: d, assets: assets, files: files, warnings: &out.Warnings}
	switch opts.Target {
	case TargetHTML:
		b.fileDir, b.urlPrefix = "assets/", "assets/"
	default:
		b.fileDir, b.urlPrefix = "public/assets/", "/assets/"
	}
	wireFlows(d, screens, opts, b, &out.Warnings)

	switch opts.Target {
	case TargetHTML:
		renderHTML(d, screens, opts, files)
	default:
		if err := renderReact(d, screens, opts, files, &out.Warnings); err != nil {
			return nil, err
		}
	}

	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		out.Files = append(out.Files, File{Path: p, Content: files[p]})
	}
	sort.Strings(out.Warnings)
	return out, nil
}

// selectedFlows: gli id dei flussi da cablare, ordinati.
func selectedFlows(d *opendesignerv1.Document, flowID string) []string {
	if flowID != "" {
		return []string{flowID}
	}
	ids := make([]string, 0, len(d.GetFlows()))
	for id := range d.GetFlows() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// flowTransitions: le transizioni dei flussi scelti, ordinate per id.
func flowTransitions(d *opendesignerv1.Document, flows []string) []*opendesignerv1.Transition {
	in := map[string]bool{}
	for _, f := range flows {
		in[f] = true
	}
	var ts []*opendesignerv1.Transition
	for _, t := range d.GetTransitions() {
		if in[t.GetFlowId()] {
			ts = append(ts, t)
		}
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].GetId() < ts[j].GetId() })
	return ts
}

// collectScreens: le schermate sono i figli di primo livello delle pagine che
// sono FRAME (i master dei componenti, che sono frame anch'essi, restano fuori:
// sono pezzi da istanziare, non pagine) più qualunque nodo di primo livello che
// un flusso scelto referenzia. L'ordine è quello del documento: pagine, poi
// order_key.
func collectScreens(d *opendesignerv1.Document, flowID string, warnings *[]string) []*Screen {
	masters := map[string]bool{}
	for _, c := range d.GetComponents() {
		masters[c.GetRootNodeId()] = true
	}
	referenced := map[string]bool{}
	flows := selectedFlows(d, flowID)
	for _, f := range flows {
		if s := d.GetFlows()[f].GetStartId(); s != "" {
			referenced[s] = true
		}
	}
	for _, t := range flowTransitions(d, flows) {
		referenced[t.GetFromId()] = true
		referenced[t.GetToId()] = true
	}
	var screens []*Screen
	seen := map[string]bool{}
	for _, p := range d.GetPages() {
		for _, n := range core.ChildrenOf(d, p.GetId()) {
			if !n.GetVisible() || seen[n.GetId()] {
				continue
			}
			_, isFrame := n.GetShape().(*opendesignerv1.Node_Frame)
			if !(isFrame && !masters[n.GetId()]) && !referenced[n.GetId()] {
				continue
			}
			seen[n.GetId()] = true
			screens = append(screens, &Screen{NodeID: n.GetId(), Width: n.GetWidth(), Height: n.GetHeight()})
		}
	}
	for id := range referenced {
		if !seen[id] {
			*warnings = append(*warnings, fmt.Sprintf("il flusso referenzia %q, che non è un nodo di primo livello visibile: non è una schermata esportata", nameOrID(d, id)))
		}
	}
	return screens
}

func nameOrID(d *opendesignerv1.Document, id string) string {
	if n := d.GetNodes()[id].GetName(); n != "" {
		return n
	}
	return id
}

var reservedNames = map[string]bool{
	"App": true, "Route": true, "Routes": true, "Navigate": true, "BrowserRouter": true,
	"StrictMode": true, "React": true, "ReactDOM": true, "Link": true,
}

// assignNames dà a ogni schermata nome di componente, slug, rotta e file, e
// scrive la rotta nei meta delle schermate dei flussi che ne sono prive.
func assignNames(d *opendesignerv1.Document, screens []*Screen, opts Options) {
	compUsed, slugUsed, routeUsed := map[string]bool{}, map[string]bool{"index": true}, map[string]bool{}
	flows := selectedFlows(d, opts.FlowID)
	inFlow := map[string]bool{}
	startOf := ""
	for _, f := range flows {
		if s := d.GetFlows()[f].GetStartId(); s != "" {
			inFlow[s] = true
			if startOf == "" {
				startOf = s
			}
		}
	}
	for _, t := range flowTransitions(d, flows) {
		inFlow[t.GetFromId()] = true
		inFlow[t.GetToId()] = true
	}
	for _, s := range screens {
		n := d.GetNodes()[s.NodeID]
		base := n.GetMeta()[flow.MetaComponent]
		if base == "" {
			base = n.GetName()
		}
		name := pascal(base)
		if reservedNames[name] {
			name += "Screen"
		}
		s.Name = dedupe(compUsed, name, "")
		s.Slug = dedupe(slugUsed, slug(n.GetName()), "-")
		route := strings.TrimSpace(n.GetMeta()[flow.MetaRoute])
		if route == "" {
			route = "/" + s.Slug
		} else if !strings.HasPrefix(route, "/") {
			route = "/" + route
		}
		s.Route = route
		routeUsed[route] = true
		if inFlow[s.NodeID] && n.GetMeta()[flow.MetaRoute] == "" {
			if n.Meta == nil {
				n.Meta = map[string]string{}
			}
			n.Meta[flow.MetaRoute] = route
		}
		s.File = s.Slug + ".html"
	}
	// Il punto d'ingresso del primo flusso con una schermata iniziale è
	// index.html (html) e la rotta "/" (react).
	if opts.Target == TargetHTML && startOf != "" {
		for _, s := range screens {
			if s.NodeID == startOf {
				s.File = "index.html"
			}
		}
	}
}

// wireFlows costruisce l'IR di ogni schermata e vi aggancia le transizioni.
func wireFlows(d *opendesignerv1.Document, screens []*Screen, opts Options, b *builder, warnings *[]string) {
	byNode := map[string]*Screen{}
	for _, s := range screens {
		byNode[s.NodeID] = s
	}
	trans := flowTransitions(d, selectedFlows(d, opts.FlowID))
	perScreen := map[string][]*opendesignerv1.Transition{}
	for _, t := range trans {
		if byNode[t.GetFromId()] == nil {
			continue
		}
		perScreen[t.GetFromId()] = append(perScreen[t.GetFromId()], t)
	}

	for _, s := range screens {
		node := d.GetNodes()[s.NodeID]
		b.triggers = map[string][]Trigger{}
		var nav, keys []Trigger
		for _, t := range perScreen[s.NodeID] {
			tr := Trigger{
				TransitionID: t.GetId(), FlowID: t.GetFlowId(), Label: t.GetLabel(), Kind: t.GetTrigger(),
				Guard: t.GetGuard(), Effect: t.GetEffect(), Dest: byNode[t.GetToId()],
			}
			if tr.Dest == nil && tr.Kind != "back" {
				*warnings = append(*warnings, fmt.Sprintf("transizione %s: la destinazione %q non è una schermata esportata", t.GetId(), nameOrID(d, t.GetToId())))
			}
			switch tr.Kind {
			case "key":
				if strings.TrimSpace(tr.Label) == "" {
					*warnings = append(*warnings, fmt.Sprintf("transizione %s: trigger key senza etichetta (il tasto da premere), non cablata", t.GetId()))
					continue
				}
				keys = append(keys, tr)
			case "auto":
				nav = append(nav, tr)
			default:
				el := t.GetElementId()
				inside := el != "" && (el == s.NodeID || core.IsAncestorOf(d, s.NodeID, el))
				if inside && len(b.triggers[el]) == 0 && tr.Kind != "back" {
					b.triggers[el] = append(b.triggers[el], tr)
				} else {
					nav = append(nav, tr)
				}
			}
		}
		s.Root = b.buildScreen(node)
		if s.Root == nil {
			// Schermata senza elementi (frame con lato nullo e nessun figlio): resta un contenitore vuoto.
			s.Root = &Element{Tag: "div", NodeID: node.GetId(), NodeName: node.GetName()}
			s.Root.Attrs = []Attr{{"data-node-id", node.GetId()}}
		}
		// Un trigger il cui elemento non è stato emesso (nodo nascosto, forma
		// degenere) non può innescare niente: ripiega sul pulsante nascosto.
		attached := map[string]bool{}
		s.Root.walk(func(e *Element) {
			for _, tr := range e.Triggers {
				attached[tr.TransitionID] = true
			}
		})
		for _, trs := range b.triggers {
			for _, tr := range trs {
				if !attached[tr.TransitionID] {
					nav = append(nav, tr)
				}
			}
		}
		sort.SliceStable(nav, func(i, j int) bool { return nav[i].TransitionID < nav[j].TransitionID })
		s.Root.NavTriggers = nav
		s.Root.KeyTriggers = keys
	}
}
