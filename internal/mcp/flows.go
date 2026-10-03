package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// I tool dei flussi: l'agente legge il grafo disegnato nell'editor come
// specifica, lo corregge, e lo aggancia al codice scrivendo i metadati dei nodi
// (`code.route`, `code.component`, `test.id`, `status`...). Le convenzioni dei
// metadati stanno in internal/flow e nelle descrizioni dei tool qui sotto.

// ---------------------------------------------------------------------------
// viste
// ---------------------------------------------------------------------------

// FlowSummary è una riga di list_flows.
type FlowSummary struct {
	Id          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	StartId     string `json:"startId,omitempty"`
	Screens     int    `json:"screens" jsonschema:"schermate distinte: ingresso più ogni from/to"`
	Transitions int    `json:"transitions"`
}

type ListFlowsOutput struct {
	Flows []FlowSummary `json:"flows"`
}

// ScreenView è una schermata di un flusso con i metadati utili a chi la realizza.
type ScreenView struct {
	NodeId    string            `json:"nodeId"`
	Name      string            `json:"name"`
	Kind      string            `json:"kind" jsonschema:"flow.kind: screen (default), decision, action, start, end o note"`
	Route     string            `json:"route,omitempty" jsonschema:"code.route"`
	Component string            `json:"component,omitempty" jsonschema:"code.component"`
	Status    string            `json:"status" jsonschema:"planned (default), implemented o tested"`
	Meta      map[string]string `json:"meta,omitempty" jsonschema:"tutti i metadati del nodo"`
}

// TransitionView è un arco del flusso.
type TransitionView struct {
	Id        string `json:"id"`
	FlowId    string `json:"flowId"`
	FromId    string `json:"fromId"`
	FromName  string `json:"fromName"`
	ToId      string `json:"toId"`
	ToName    string `json:"toName"`
	Label     string `json:"label,omitempty"`
	Trigger   string `json:"trigger,omitempty"`
	ElementId string `json:"elementId,omitempty"`
	Guard     string `json:"guard,omitempty"`
	Effect    string `json:"effect,omitempty"`
}

type GetFlowInput struct {
	Id string `json:"id" jsonschema:"id del flusso (vedi list_flows)"`
}

type GetFlowOutput struct {
	Id          string           `json:"id"`
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	StartId     string           `json:"startId,omitempty"`
	Screens     []ScreenView     `json:"screens"`
	Transitions []TransitionView `json:"transitions"`
}

func screenView(doc *opendesignerv1.Document, id string) ScreenView {
	n := doc.GetNodes()[id]
	meta := n.GetMeta()
	kind := meta[flow.MetaKind]
	if kind == "" {
		kind = flow.KindScreen
	}
	status := meta[flow.MetaStatus]
	if status == "" {
		status = flow.StatusPlanned
	}
	name := n.GetName()
	if name == "" {
		name = id
	}
	v := ScreenView{NodeId: id, Name: name, Kind: kind, Route: meta[flow.MetaRoute], Component: meta[flow.MetaComponent], Status: status}
	if len(meta) > 0 {
		v.Meta = make(map[string]string, len(meta))
		for k, val := range meta {
			v.Meta[k] = val
		}
	}
	return v
}

func nameOf(doc *opendesignerv1.Document, id string) string {
	if n := doc.GetNodes()[id].GetName(); n != "" {
		return n
	}
	return id
}

func transitionView(doc *opendesignerv1.Document, t *opendesignerv1.Transition) TransitionView {
	return TransitionView{
		Id: t.GetId(), FlowId: t.GetFlowId(),
		FromId: t.GetFromId(), FromName: nameOf(doc, t.GetFromId()),
		ToId: t.GetToId(), ToName: nameOf(doc, t.GetToId()),
		Label: t.GetLabel(), Trigger: t.GetTrigger(), ElementId: t.GetElementId(),
		Guard: t.GetGuard(), Effect: t.GetEffect(),
	}
}

// flowTransitions: le transizioni di un flusso, ordinate per id.
func flowTransitions(doc *opendesignerv1.Document, flowID string) []*opendesignerv1.Transition {
	var ts []*opendesignerv1.Transition
	for _, t := range doc.GetTransitions() {
		if t.GetFlowId() == flowID {
			ts = append(ts, t)
		}
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].GetId() < ts[j].GetId() })
	return ts
}

// ---------------------------------------------------------------------------
// list_flows / get_flow
// ---------------------------------------------------------------------------

// ListFlows elenca i flussi del documento (ordinati per id).
func (s *Session) ListFlows(_ context.Context, _ struct{}) (ListFlowsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListFlowsOutput{Flows: []FlowSummary{}}
	ids := make([]string, 0, len(s.doc.GetFlows()))
	for id := range s.doc.GetFlows() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		f := s.doc.GetFlows()[id]
		ts := flowTransitions(s.doc, id)
		screens := map[string]bool{}
		if f.GetStartId() != "" {
			screens[f.GetStartId()] = true
		}
		for _, t := range ts {
			screens[t.GetFromId()] = true
			screens[t.GetToId()] = true
		}
		out.Flows = append(out.Flows, FlowSummary{
			Id: id, Name: f.GetName(), Description: f.GetDescription(), StartId: f.GetStartId(),
			Screens: len(screens), Transitions: len(ts),
		})
	}
	return out, nil
}

// GetFlow ritorna un flusso con le sue schermate (nome, tipo, rotta, componente,
// stato) e le sue transizioni.
func (s *Session) GetFlow(_ context.Context, in GetFlowInput) (GetFlowOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.doc.GetFlows()[in.Id]
	if !ok {
		return GetFlowOutput{}, fmt.Errorf("flusso %q non trovato: usa list_flows per gli id", in.Id)
	}
	ts := flowTransitions(s.doc, in.Id)
	screenIDs := map[string]bool{}
	if f.GetStartId() != "" {
		screenIDs[f.GetStartId()] = true
	}
	for _, t := range ts {
		screenIDs[t.GetFromId()] = true
		screenIDs[t.GetToId()] = true
	}
	out := GetFlowOutput{Id: f.GetId(), Name: f.GetName(), Description: f.GetDescription(), StartId: f.GetStartId(),
		Screens: []ScreenView{}, Transitions: []TransitionView{}}
	for id := range screenIDs {
		out.Screens = append(out.Screens, screenView(s.doc, id))
	}
	sort.Slice(out.Screens, func(i, j int) bool {
		if out.Screens[i].Name != out.Screens[j].Name {
			return out.Screens[i].Name < out.Screens[j].Name
		}
		return out.Screens[i].NodeId < out.Screens[j].NodeId
	})
	for _, t := range ts {
		out.Transitions = append(out.Transitions, transitionView(s.doc, t))
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// create_flow / delete_flow
// ---------------------------------------------------------------------------

type CreateFlowInput struct {
	Name        string `json:"name" jsonschema:"nome del flusso, es. \"Acquisto\""`
	Description string `json:"description,omitempty"`
	StartId     string `json:"startId,omitempty" jsonschema:"id del nodo (frame) che è la schermata iniziale; si può impostare dopo"`
}

type CreateFlowOutput struct {
	FlowId string `json:"flowId"`
	Seq    uint64 `json:"seq"`
}

// CreateFlow crea un flusso vuoto.
func (s *Session) CreateFlow(ctx context.Context, in CreateFlowInput) (CreateFlowOutput, error) {
	if strings.TrimSpace(in.Name) == "" {
		return CreateFlowOutput{}, errors.New("create_flow: name obbligatorio")
	}
	if in.StartId != "" && !s.hasNode(in.StartId) {
		return CreateFlowOutput{}, fmt.Errorf("create_flow: startId %q non è un nodo del documento", in.StartId)
	}
	id := uuid.NewString()
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{
		Flow: &opendesignerv1.Flow{Id: id, Name: in.Name, Description: in.Description, StartId: in.StartId},
	}}})
	if err != nil {
		return CreateFlowOutput{}, err
	}
	return CreateFlowOutput{FlowId: id, Seq: seq}, nil
}

// DeleteFlow cancella un flusso e le sue transizioni (le schermate restano).
func (s *Session) DeleteFlow(ctx context.Context, in GetFlowInput) (SeqOutput, error) {
	if !s.hasFlow(in.Id) {
		return SeqOutput{}, fmt.Errorf("delete_flow: flusso %q non trovato", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteFlow{DeleteFlow: &opendesignerv1.DeleteFlow{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

func (s *Session) hasNode(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.doc.GetNodes()[id]
	return ok
}

func (s *Session) hasFlow(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.doc.GetFlows()[id]
	return ok
}

// ---------------------------------------------------------------------------
// set_transition / delete_transition
// ---------------------------------------------------------------------------

// SetTransitionInput crea (senza id) o aggiorna (con id) una transizione. In
// aggiornamento i campi omessi restano quelli che sono; per svuotare un testo
// passa la stringa vuota.
type SetTransitionInput struct {
	Id        string  `json:"id,omitempty" jsonschema:"vuoto = crea una nuova transizione; un id esistente = aggiorna"`
	FlowId    string  `json:"flowId,omitempty" jsonschema:"obbligatorio in creazione"`
	FromId    string  `json:"fromId,omitempty" jsonschema:"nodo di partenza; obbligatorio in creazione"`
	ToId      string  `json:"toId,omitempty" jsonschema:"nodo di arrivo; obbligatorio in creazione"`
	Label     *string `json:"label,omitempty" jsonschema:"testo dell'elemento che innesca (es. il bottone); usato dai test generati come ripiego di test.id/test.text"`
	Trigger   *string `json:"trigger,omitempty" jsonschema:"click (default), submit, auto, key, back oppure testo libero; con key la label è il tasto"`
	ElementId *string `json:"elementId,omitempty" jsonschema:"opzionale: il nodo DENTRO fromId che innesca (l'hotspot); i suoi meta test.id/test.text danno il locator del test"`
	Guard     *string `json:"guard,omitempty" jsonschema:"condizione per cui l'arco è percorribile, testo libero"`
	Effect    *string `json:"effect,omitempty" jsonschema:"ciò che l'arco cambia, testo libero"`
}

type SetTransitionOutput struct {
	TransitionId string `json:"transitionId"`
	Created      bool   `json:"created"`
	Seq          uint64 `json:"seq"`
}

// SetTransition valida i riferimenti sul documento locale (messaggi chiari per
// l'agente) e invia l'upsert assoluto della transizione.
func (s *Session) SetTransition(ctx context.Context, in SetTransitionInput) (SetTransitionOutput, error) {
	s.mu.Lock()
	var t *opendesignerv1.Transition
	created := in.Id == ""
	if created {
		t = &opendesignerv1.Transition{Id: uuid.NewString(), Trigger: "click"}
	} else if old, ok := s.doc.GetTransitions()[in.Id]; ok {
		t = &opendesignerv1.Transition{
			Id: old.GetId(), FlowId: old.GetFlowId(), FromId: old.GetFromId(), ToId: old.GetToId(),
			Label: old.GetLabel(), Trigger: old.GetTrigger(), ElementId: old.GetElementId(),
			Guard: old.GetGuard(), Effect: old.GetEffect(),
		}
	} else {
		s.mu.Unlock()
		return SetTransitionOutput{}, fmt.Errorf("set_transition: transizione %q non trovata (ometti id per crearne una nuova)", in.Id)
	}
	if in.FlowId != "" {
		t.FlowId = in.FlowId
	}
	if in.FromId != "" {
		t.FromId = in.FromId
	}
	if in.ToId != "" {
		t.ToId = in.ToId
	}
	if in.Label != nil {
		t.Label = *in.Label
	}
	if in.Trigger != nil {
		t.Trigger = *in.Trigger
	}
	if in.ElementId != nil {
		t.ElementId = *in.ElementId
	}
	if in.Guard != nil {
		t.Guard = *in.Guard
	}
	if in.Effect != nil {
		t.Effect = *in.Effect
	}
	err := validateTransition(s.doc, t)
	s.mu.Unlock()
	if err != nil {
		return SetTransitionOutput{}, err
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: t}}})
	if err != nil {
		return SetTransitionOutput{}, err
	}
	return SetTransitionOutput{TransitionId: t.GetId(), Created: created, Seq: seq}, nil
}

func validateTransition(doc *opendesignerv1.Document, t *opendesignerv1.Transition) error {
	if t.GetFlowId() == "" {
		return errors.New("set_transition: flowId obbligatorio (vedi list_flows / create_flow)")
	}
	if _, ok := doc.GetFlows()[t.GetFlowId()]; !ok {
		return fmt.Errorf("set_transition: il flusso %q non esiste (vedi list_flows / create_flow)", t.GetFlowId())
	}
	if t.GetFromId() == "" || t.GetToId() == "" {
		return errors.New("set_transition: fromId e toId sono obbligatori")
	}
	if _, ok := doc.GetNodes()[t.GetFromId()]; !ok {
		return fmt.Errorf("set_transition: fromId %q non è un nodo del documento (vedi list_nodes)", t.GetFromId())
	}
	if _, ok := doc.GetNodes()[t.GetToId()]; !ok {
		return fmt.Errorf("set_transition: toId %q non è un nodo del documento (vedi list_nodes)", t.GetToId())
	}
	if e := t.GetElementId(); e != "" {
		if _, ok := doc.GetNodes()[e]; !ok {
			return fmt.Errorf("set_transition: elementId %q non è un nodo del documento", e)
		}
	}
	return nil
}

// DeleteTransition cancella una transizione.
func (s *Session) DeleteTransition(ctx context.Context, in NodeIdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetTransitions()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_transition: transizione %q non trovata", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTransition{DeleteTransition: &opendesignerv1.DeleteTransition{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// set_node_meta
// ---------------------------------------------------------------------------

// SetNodeMetaInput fonde chiavi nei metadati di un nodo.
type SetNodeMetaInput struct {
	Id    string            `json:"id" jsonschema:"id del nodo"`
	Meta  map[string]string `json:"meta,omitempty" jsonschema:"chiavi da impostare, fuse con quelle esistenti. Convenzioni: flow.kind (screen|decision|action|start|end|note), code.route, code.component, test.id, test.text, status (planned|implemented|tested)"`
	Unset []string          `json:"unset,omitempty" jsonschema:"chiavi da rimuovere"`
}

type SetNodeMetaOutput struct {
	Meta map[string]string `json:"meta" jsonschema:"i metadati del nodo dopo la modifica"`
	Seq  uint64            `json:"seq"`
}

var (
	validKinds    = []string{"screen", "decision", "action", "start", "end", "note"}
	validStatuses = []string{flow.StatusPlanned, flow.StatusImplemented, flow.StatusTested}
)

func oneOf(v string, list []string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// SetNodeMeta fa read-modify-write: la mask "meta" di SetProperties SOSTITUISCE
// l'intera mappa, quindi si legge quella corrente, si fondono le chiavi e si
// scrive il risultato intero. Un autore concorrente sullo stesso nodo nello
// stesso istante può vincere sull'altro (ultimo scrittore): i metadati sono
// pochi e di norma li scrive un solo agente.
func (s *Session) SetNodeMeta(ctx context.Context, in SetNodeMetaInput) (SetNodeMetaOutput, error) {
	if len(in.Meta) == 0 && len(in.Unset) == 0 {
		return SetNodeMetaOutput{}, errors.New("set_node_meta: niente da fare, passa meta e/o unset")
	}
	if k, ok := in.Meta[flow.MetaKind]; ok && !oneOf(k, validKinds) {
		return SetNodeMetaOutput{}, fmt.Errorf("set_node_meta: flow.kind deve essere uno di %s, non %q", strings.Join(validKinds, ", "), k)
	}
	if st, ok := in.Meta[flow.MetaStatus]; ok && !oneOf(st, validStatuses) {
		return SetNodeMetaOutput{}, fmt.Errorf("set_node_meta: status deve essere uno di %s, non %q", strings.Join(validStatuses, ", "), st)
	}
	s.mu.Lock()
	n, ok := s.doc.GetNodes()[in.Id]
	if !ok {
		s.mu.Unlock()
		return SetNodeMetaOutput{}, fmt.Errorf("set_node_meta: nodo %q non trovato", in.Id)
	}
	merged := make(map[string]string, len(n.GetMeta())+len(in.Meta))
	for k, v := range n.GetMeta() {
		merged[k] = v
	}
	s.mu.Unlock()
	for _, k := range in.Unset {
		delete(merged, k)
	}
	for k, v := range in.Meta {
		merged[k] = v
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: in.Id, Patch: &opendesignerv1.Node{Meta: merged}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"meta"}},
	}}})
	if err != nil {
		return SetNodeMetaOutput{}, err
	}
	return SetNodeMetaOutput{Meta: merged, Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// analyze_flows / get_flow_spec
// ---------------------------------------------------------------------------

type AnalyzeFlowsInput struct {
	FlowId string `json:"flowId,omitempty" jsonschema:"un solo flusso; vuoto = tutti"`
}

type FlowIssueView struct {
	Kind         string `json:"kind" jsonschema:"empty | no_start | unreachable | dead_end | ambiguous"`
	NodeId       string `json:"nodeId,omitempty"`
	TransitionId string `json:"transitionId,omitempty"`
	Message      string `json:"message"`
}

type FlowPathView struct {
	Screens       []string `json:"screens" jsonschema:"nomi delle schermate nell'ordine del percorso"`
	NodeIds       []string `json:"nodeIds"`
	TransitionIds []string `json:"transitionIds"`
	Loops         bool     `json:"loops,omitempty" jsonschema:"il percorso termina tornando su una schermata già visitata"`
}

type FlowReportView struct {
	FlowId         string          `json:"flowId"`
	Name           string          `json:"name"`
	Screens        int             `json:"screens"`
	Transitions    int             `json:"transitions"`
	Issues         []FlowIssueView `json:"issues"`
	Paths          []FlowPathView  `json:"paths"`
	PathsTruncated bool            `json:"pathsTruncated,omitempty"`
}

type AnalyzeFlowsOutput struct {
	Reports []FlowReportView `json:"reports"`
	Issues  int              `json:"issues" jsonschema:"totale dei problemi in tutti i report"`
}

// AnalyzeFlows analizza i flussi sul documento locale (stessa logica dell'RPC
// AnalyzeFlows e di `opendesigner flow check`).
func (s *Session) AnalyzeFlows(_ context.Context, in AnalyzeFlowsInput) (AnalyzeFlowsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.FlowId != "" {
		if _, ok := s.doc.GetFlows()[in.FlowId]; !ok {
			return AnalyzeFlowsOutput{}, fmt.Errorf("flusso %q non trovato: usa list_flows per gli id", in.FlowId)
		}
	}
	out := AnalyzeFlowsOutput{Reports: []FlowReportView{}}
	for _, r := range flow.Analyze(s.doc, in.FlowId) {
		v := FlowReportView{
			FlowId: r.GetFlowId(), Name: s.doc.GetFlows()[r.GetFlowId()].GetName(),
			Screens: int(r.GetScreens()), Transitions: int(r.GetTransitions()),
			Issues: []FlowIssueView{}, Paths: []FlowPathView{}, PathsTruncated: r.GetPathsTruncated(),
		}
		for _, is := range r.GetIssues() {
			v.Issues = append(v.Issues, FlowIssueView{Kind: is.GetKind(), NodeId: is.GetNodeId(), TransitionId: is.GetTransitionId(), Message: is.GetMessage()})
		}
		for _, p := range r.GetPaths() {
			names := make([]string, len(p.GetNodeIds()))
			for i, id := range p.GetNodeIds() {
				names[i] = nameOf(s.doc, id)
			}
			v.Paths = append(v.Paths, FlowPathView{Screens: names, NodeIds: p.GetNodeIds(), TransitionIds: p.GetTransitionIds(), Loops: p.GetLoops()})
		}
		out.Issues += len(v.Issues)
		out.Reports = append(out.Reports, v)
	}
	return out, nil
}

type FlowSpecOutput struct {
	Markdown string `json:"markdown"`
}

// GetFlowSpec ritorna la specifica Markdown (stessa di `opendesigner flow spec`).
func (s *Session) GetFlowSpec(_ context.Context, in AnalyzeFlowsInput) (FlowSpecOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.FlowId != "" {
		if _, ok := s.doc.GetFlows()[in.FlowId]; !ok {
			return FlowSpecOutput{}, fmt.Errorf("flusso %q non trovato: usa list_flows per gli id", in.FlowId)
		}
	}
	return FlowSpecOutput{Markdown: flow.Spec(s.doc, in.FlowId)}, nil
}

// flowConventions è il manuale che ogni tool dei flussi ripete in breve: un
// agente che vede solo uno di questi tool deve poter pilotare tutto il flusso di
// lavoro.
const flowConventions = " Flow model: a FLOW is a user journey made of TRANSITIONS (edges) between SCREENS, which are ordinary document nodes (frames) referenced by id. " +
	"Node meta conventions: flow.kind (screen|decision|action|start|end|note, default screen), code.route (app route that realises the screen), code.component (component name), " +
	"test.id (data-testid of an element), test.text (accessible text of an element), status (planned|implemented|tested). " +
	"Typical loop: get_flow_spec or analyze_flows to read the design, build the screens, write code.route/code.component with set_node_meta, then generate tests with `opendesigner flow tests`."

func registerFlowTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_flows", "List the document's flows with their start screen and size."+flowConventions, s.ListFlows)
	addTool(srv, "get_flow", "Return one flow: its screens (name, kind, route, component, status, meta) and its transitions (from/to ids and names, label, trigger, element, guard, effect)."+flowConventions, s.GetFlow)
	addTool(srv, "create_flow", "Create an empty flow, optionally with its start screen (a node id). Add edges with set_transition. Returns the flow id."+flowConventions, s.CreateFlow)
	addTool(srv, "delete_flow", "Delete a flow and all its transitions. The screens (nodes) are kept.", s.DeleteFlow)
	addTool(srv, "set_transition", "Create (omit id) or update (pass id) a transition between two existing nodes of a flow. trigger: click (default), submit, auto, key (label = the key), back, or free text. "+
		"label is the visible text of the trigger element; elementId optionally points at the node INSIDE fromId that triggers it (its meta test.id/test.text give the test locator). "+
		"guard = condition under which the edge is taken, effect = what it changes (free text). Two edges out of one screen with the same trigger+element and no distinguishing guard are reported as ambiguous. On update, omitted fields are kept."+flowConventions, s.SetTransition)
	addTool(srv, "delete_transition", "Delete a transition by id.", s.DeleteTransition)
	addTool(srv, "set_node_meta", "Merge keys into a node's meta (and optionally remove some with unset); other keys are preserved. Use it to link a screen to the code (code.route, code.component), to its test locators (test.id, test.text) and to mark progress (status)."+flowConventions, s.SetNodeMeta)
	addTool(srv, "analyze_flows", "Analyse flows (all, or one with flowId): issues (empty, no_start, unreachable, dead_end, ambiguous) with Italian messages naming the screens, plus every path from the start screen to an end or a loop (capped at 200 paths / depth 50, then pathsTruncated)."+flowConventions, s.AnalyzeFlows)
	addTool(srv, "get_flow_spec", "Return the Markdown specification of the flows (screens table, numbered transitions, Given/When/Then scenarios, issues). Use it as the requirements to implement."+flowConventions, s.GetFlowSpec)
}
