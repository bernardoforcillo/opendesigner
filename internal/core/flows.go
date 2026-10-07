package core

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// FLOWS -- the Go half (the authority) of web/src/store/applyOp.ts for the four
// ops setFlow / deleteFlow / setTransition / deleteTransition.
//
// A flow is a graph of screens: screens are document NODES (referenced by id,
// never copied) and transitions are the edges. The invariants, mirroring those
// of nodes and pages:
//
//	1. a transition belongs to an EXISTING flow and connects two EXISTING nodes
//	   (and, if given, the element that triggers it exists);
//	2. deleting a flow deletes its transitions;
//	3. deleting a node (or a page) deletes the transitions that go through it,
//	   clears the `start_id` of the flows that started from it, and resets the
//	   `element_id` of the transitions that used it as a hotspot.
//
// Upserts are ABSOLUTE: the incoming value is the final value, so the inverse
// of an op is the previous state (see web/src/store/history.ts).
//
// The document remains any proto value: the `Flows`/`Transitions` maps may be
// nil (a document without flows, or decoded from a snapshot written before this
// feature) and are initialized on the first write.

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

// TransitionAnimations is the closed set of Transition.animation (the empty string is a cut).
var TransitionAnimations = []string{
	"dissolve", "slide-left", "slide-right", "slide-up", "slide-down",
	"push-left", "push-right", "push-up", "push-down", "smart",
}

// ValidTransitionAnimation: "" (a cut) or one of TransitionAnimations.
func ValidTransitionAnimation(a string) bool { return a == "" || inSet(TransitionAnimations, a) }

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
	if t.GetAnimation() != "" && !inSet(TransitionAnimations, t.GetAnimation()) {
		return fmt.Errorf("%w: %q (transition %s)", ErrTransitionAnim, t.GetAnimation(), t.GetId())
	}
	if t.GetDurationMs() < 0 || t.GetDurationMs() > 10000 || t.GetDelayMs() < 0 || t.GetDelayMs() > 60000 || !ValidEasing(t.GetEasing()) {
		return fmt.Errorf("%w: timing (transition %s)", ErrTransitionAnim, t.GetId())
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

// cascadeFlows removes from the flows whatever referenced the nodes just deleted.
// Modified entries are REPLACED by copies, never mutated in place: with the
// server's copy-on-write clone (cowClone) the object might be shared with the
// document's previous generation.
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
