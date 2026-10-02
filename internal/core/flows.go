package core

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// FLUSSI -- la metà Go (l'autorità) di web/src/store/applyOp.ts per i quattro op
// setFlow / deleteFlow / setTransition / deleteTransition.
//
// Un flusso è un grafo di schermate: le schermate sono NODI del documento
// (referenziati per id, mai copiati) e le transizioni sono gli archi. Le
// invarianti, speculari a quelle dei nodi e delle pagine:
//
//	1. una transizione appartiene a un flusso ESISTENTE e collega due nodi
//	   ESISTENTI (e, se indicato, l'elemento che la innesca esiste);
//	2. cancellare un flusso cancella le sue transizioni;
//	3. cancellare un nodo (o una pagina) cancella le transizioni che lo
//	   attraversano, svuota il `start_id` dei flussi che partivano da lui e
//	   azzera l'`element_id` delle transizioni che lo usavano come hotspot.
//
// Gli upsert sono ASSOLUTI: il valore che arriva è il valore finale, quindi
// l'inverso di un op è lo stato precedente (vedi web/src/store/history.ts).
//
// Il documento resta un valore proto qualsiasi: le mappe `Flows`/`Transitions`
// possono essere nil (un documento senza flussi, o decodificato da uno snapshot
// scritto prima di questa funzione) e si inizializzano alla prima scrittura.

func nodeExists(doc *opendesignerv1.Document, id string) bool {
	_, ok := doc.GetNodes()[id]
	return ok
}

func applySetFlow(doc *opendesignerv1.Document, s *opendesignerv1.SetFlow) error {
	f := s.GetFlow()
	if f == nil || f.GetId() == "" {
		return ErrNilFlow
	}
	if f.GetStartId() != "" && !nodeExists(doc, f.GetStartId()) {
		return fmt.Errorf("%w: %s (flow %s start)", ErrNodeNotFound, f.GetStartId(), f.GetId())
	}
	if doc.Flows == nil {
		doc.Flows = map[string]*opendesignerv1.Flow{}
	}
	doc.Flows[f.GetId()] = f
	return nil
}

func applyDeleteFlow(doc *opendesignerv1.Document, d *opendesignerv1.DeleteFlow) error {
	if _, ok := doc.GetFlows()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrFlowNotFound, d.GetId())
	}
	delete(doc.Flows, d.GetId())
	for id, t := range doc.GetTransitions() {
		if t.GetFlowId() == d.GetId() {
			delete(doc.Transitions, id)
		}
	}
	return nil
}

func applySetTransition(doc *opendesignerv1.Document, s *opendesignerv1.SetTransition) error {
	t := s.GetTransition()
	if t == nil || t.GetId() == "" {
		return ErrNilTransition
	}
	if _, ok := doc.GetFlows()[t.GetFlowId()]; !ok {
		return fmt.Errorf("%w: %s (transition %s)", ErrFlowNotFound, t.GetFlowId(), t.GetId())
	}
	for _, ref := range []string{t.GetFromId(), t.GetToId()} {
		if !nodeExists(doc, ref) {
			return fmt.Errorf("%w: %s (transition %s)", ErrNodeNotFound, ref, t.GetId())
		}
	}
	if t.GetElementId() != "" && !nodeExists(doc, t.GetElementId()) {
		return fmt.Errorf("%w: %s (transition %s element)", ErrNodeNotFound, t.GetElementId(), t.GetId())
	}
	if doc.Transitions == nil {
		doc.Transitions = map[string]*opendesignerv1.Transition{}
	}
	doc.Transitions[t.GetId()] = t
	return nil
}

func applyDeleteTransition(doc *opendesignerv1.Document, d *opendesignerv1.DeleteTransition) error {
	if _, ok := doc.GetTransitions()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrTransitionNotFound, d.GetId())
	}
	delete(doc.Transitions, d.GetId())
	return nil
}

// cascadeFlows toglie dai flussi ciò che riferiva i nodi appena cancellati. Le
// voci modificate sono SOSTITUITE da copie, mai mutate in place: con il clone
// copy-on-write del server (cowClone) l'oggetto potrebbe essere condiviso con la
// generazione precedente del documento.
func cascadeFlows(doc *opendesignerv1.Document, gone map[string]bool) {
	if len(gone) == 0 {
		return
	}
	for id, t := range doc.GetTransitions() {
		switch {
		case gone[t.GetFromId()] || gone[t.GetToId()]:
			delete(doc.Transitions, id)
		case t.GetElementId() != "" && gone[t.GetElementId()]:
			c := proto.Clone(t).(*opendesignerv1.Transition)
			c.ElementId = ""
			doc.Transitions[id] = c
		}
	}
	for id, f := range doc.GetFlows() {
		if f.GetStartId() != "" && gone[f.GetStartId()] {
			c := proto.Clone(f).(*opendesignerv1.Flow)
			c.StartId = ""
			doc.Flows[id] = c
		}
	}
}
