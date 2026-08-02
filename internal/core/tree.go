package core

import (
	"sort"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

// Attraversamento del documento come ALBERO. `Node.parent_id` esisteva da M0 ma
// nessuno lo leggeva: la scena era piatta e ogni nodo figlio di "page1". Da qui
// in poi è la struttura portante -- gruppi, frame e componenti sono tutti
// sottoalberi -- e core.Apply ne fa rispettare gli invarianti:
//
//	1. il parent di un nodo ESISTE (un altro nodo, oppure una Page);
//	2. cancellare un nodo cancella tutto il suo sottoalbero;
//	3. nessun ciclo: un nodo non può finire sotto un proprio discendente.
//
// Le funzioni qui sono la METÀ Go di web/src/store/tree.ts: stesse regole,
// stesso ordine, stessa tolleranza a un documento malformato. Un documento con
// un ciclo non è producibile da Apply, ma può arrivare da un op-log scritto
// prima di queste invarianti: l'attraversamento non deve andare in loop
// infinito, quindi ogni discesa tiene l'insieme dei nodi già visti.

// ChildrenOf ritorna i figli DIRETTI di parentID (un id di nodo o di Page),
// ordinati per order_key crescente -- cioè dal fondo alla cima nell'ordine di
// disegno.
//
// L'ordinamento è totale anche a parità di chiave: l'id fa da spareggio.
// L'iterazione di una map Go è deliberatamente randomizzata, quindi senza lo
// spareggio due chiamate sullo stesso documento potrebbero dare ordini diversi
// -- e la cascata di delete, che ne dipende, produrrebbe inversi diversi a ogni
// esecuzione.
func ChildrenOf(doc *brawtv1.Document, parentID string) []*brawtv1.Node {
	var out []*brawtv1.Node
	for _, n := range doc.GetNodes() {
		if n.GetParentId() == parentID {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].GetOrderKey() != out[j].GetOrderKey() {
			return out[i].GetOrderKey() < out[j].GetOrderKey()
		}
		return out[i].GetId() < out[j].GetId()
	})
	return out
}

// SubtreeOf ritorna il nodo e TUTTI i suoi discendenti in pre-ordine: ogni nodo
// compare sempre DOPO il proprio parent, e i fratelli in ordine di order_key.
//
// L'ordine non è un dettaglio estetico: è ciò che rende la lista riusabile
// come sequenza di ricreazione (l'inverso di una delete a cascata, vedi
// web/src/store/history.ts). Ricreare i nodi in quest'ordine soddisfa
// l'invariante "il parent esiste" a ogni passo; in ordine inverso ogni figlio
// verrebbe rifiutato.
//
// Lista vuota se il nodo non esiste.
func SubtreeOf(doc *brawtv1.Document, id string) []*brawtv1.Node {
	root := doc.GetNodes()[id]
	if root == nil {
		return nil
	}
	var out []*brawtv1.Node
	seen := map[string]bool{}
	// PILA esplicita e non ricorsione: la profondità dell'albero la decide
	// l'utente (gruppi dentro gruppi dentro frame), e un documento malformato
	// potrebbe renderla illimitata. In pila i figli vanno in ordine INVERSO,
	// così escono in ordine di order_key.
	stack := []*brawtv1.Node{root}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[n.GetId()] {
			// Ciclo in un documento malformato: il nodo è già stato visitato,
			// visitarlo di nuovo non finirebbe mai.
			continue
		}
		seen[n.GetId()] = true
		out = append(out, n)
		children := ChildrenOf(doc, n.GetId())
		for i := len(children) - 1; i >= 0; i-- {
			stack = append(stack, children[i])
		}
	}
	return out
}

// IsAncestorOf dice se ancestorID è un antenato STRETTO di id (un nodo non è
// antenato di se stesso). Sale la catena dei parent invece di scendere
// l'albero: la profondità è tipicamente molto minore del numero di discendenti,
// ed è la direzione in cui il controllo dei cicli va fatto (vedi applyReparent).
func IsAncestorOf(doc *brawtv1.Document, ancestorID, id string) bool {
	seen := map[string]bool{}
	cur := doc.GetNodes()[id]
	for cur != nil && !seen[cur.GetId()] {
		seen[cur.GetId()] = true
		if cur.GetParentId() == ancestorID {
			return true
		}
		cur = doc.GetNodes()[cur.GetParentId()]
	}
	return false
}

// parentExists dice se parentID è un contenitore valido: un nodo esistente
// oppure una Page del documento. Una stringa vuota non è né l'uno né l'altro --
// un nodo senza parent non è raggiungibile da nessuna pagina, quindi non è
// disegnabile né selezionabile: esisterebbe solo dentro la mappa.
func parentExists(doc *brawtv1.Document, parentID string) bool {
	if _, ok := doc.GetNodes()[parentID]; ok {
		return true
	}
	for _, p := range doc.GetPages() {
		if p.GetId() == parentID {
			return true
		}
	}
	return false
}
