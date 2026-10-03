package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// I tool dell'animazione: l'agente legge e scrive le CLIP del documento (tracce
// di keyframe su proprietà di nodi esistenti). Il modello vive in
// internal/core/animation.go e docs/animation.md; la validazione che i tool
// fanno PRIMA di spedire l'op è la stessa dell'autorità (core.ValidateClip), così
// l'errore che l'agente legge dice cosa correggere invece di un rifiuto opaco.

// ---------------------------------------------------------------------------
// viste e input
// ---------------------------------------------------------------------------

type KeyframeIO struct {
	Time   float64 `json:"time" jsonschema:"millisecondi dall'inizio della clip, 0..duration"`
	Value  float64 `json:"value" jsonschema:"valore della proprietà in quell'istante"`
	Easing string  `json:"easing,omitempty" jsonschema:"curva del segmento che PARTE da questo keyframe: linear (default) | easeIn | easeOut | easeInOut | spring | cubic-bezier(a,b,c,d) con a e c in [0,1]"`
}

type TrackIO struct {
	NodeId    string       `json:"nodeId" jsonschema:"id del nodo animato (vedi list_nodes)"`
	Prop      string       `json:"prop" jsonschema:"opacity (0..1) | x | y (coordinate locali assolute del nodo) | scale (moltiplicatore, base 1) | rotation (gradi assoluti) | draw (0..1: quanto del tracciato è disegnato; solo vector, rect, ellipse, frame con un tratto)"`
	Keyframes []KeyframeIO `json:"keyframes" jsonschema:"almeno uno, ordinati per time (tempi uguali = scatto)"`
}

// ClipBody è il contenuto di una clip, uguale in creazione e in sostituzione.
type ClipBody struct {
	Name     string    `json:"name,omitempty" jsonschema:"nome libero: entrata, hover, caricamento..."`
	TargetId string    `json:"targetId" jsonschema:"il nodo (schermata, gruppo o SVG) a cui la clip appartiene: il suo enter/hover/tap la fa partire. Le tracce possono riguardare il target e i suoi discendenti"`
	Duration float64   `json:"duration" jsonschema:"durata in millisecondi, > 0"`
	Trigger  string    `json:"trigger,omitempty" jsonschema:"enter (all'apparire) | hover | tap | loop | manual (default: la fa partire il codice)"`
	Delay    float64   `json:"delay,omitempty" jsonschema:"ritardo iniziale in ms"`
	Repeat   int       `json:"repeat,omitempty" jsonschema:"ripetizioni EXTRA dopo la prima; -1 = all'infinito"`
	Yoyo     bool      `json:"yoyo,omitempty" jsonschema:"le ripetizioni dispari vanno al contrario"`
	Tracks   []TrackIO `json:"tracks,omitempty"`
}

type SetClipInput struct {
	Id string `json:"id" jsonschema:"id della clip da SOSTITUIRE per intero (vedi list_clips)"`
	ClipBody
}

type ClipIdInput struct {
	Id string `json:"id" jsonschema:"id della clip (vedi list_clips)"`
}

type ClipSummary struct {
	Id         string  `json:"id"`
	Name       string  `json:"name,omitempty"`
	TargetId   string  `json:"targetId"`
	TargetName string  `json:"targetName"`
	Trigger    string  `json:"trigger"`
	Duration   float64 `json:"duration"`
	Delay      float64 `json:"delay,omitempty"`
	Repeat     int     `json:"repeat,omitempty"`
	Yoyo       bool    `json:"yoyo,omitempty"`
	Tracks     int     `json:"tracks"`
}

type ListClipsOutput struct {
	Clips []ClipSummary `json:"clips"`
}

type TrackView struct {
	TrackIO
	NodeName string `json:"nodeName"`
}

type ClipView struct {
	ClipSummary
	TrackList []TrackView `json:"trackList"`
}

type CreateClipOutput struct {
	ClipId string `json:"clipId"`
	Seq    uint64 `json:"seq"`
}

func clipSummary(doc *opendesignerv1.Document, c *opendesignerv1.Clip) ClipSummary {
	trig := c.GetTrigger()
	if trig == "" {
		trig = "manual"
	}
	return ClipSummary{
		Id: c.GetId(), Name: c.GetName(), TargetId: c.GetTargetId(), TargetName: nameOf(doc, c.GetTargetId()),
		Trigger: trig, Duration: c.GetDuration(), Delay: c.GetDelay(), Repeat: int(c.GetRepeat()), Yoyo: c.GetYoyo(),
		Tracks: len(c.GetTracks()),
	}
}

// ClipViews elenca le clip di un documento, ordinate per id (usato anche da
// get_document).
func clipViews(doc *opendesignerv1.Document) []ClipView {
	ids := make([]string, 0, len(doc.GetClips()))
	for id := range doc.GetClips() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]ClipView, 0, len(ids))
	for _, id := range ids {
		out = append(out, clipView(doc, doc.GetClips()[id]))
	}
	return out
}

func clipView(doc *opendesignerv1.Document, c *opendesignerv1.Clip) ClipView {
	v := ClipView{ClipSummary: clipSummary(doc, c), TrackList: []TrackView{}}
	for _, t := range c.GetTracks() {
		tv := TrackView{TrackIO: TrackIO{NodeId: t.GetNodeId(), Prop: t.GetProp(), Keyframes: []KeyframeIO{}}, NodeName: nameOf(doc, t.GetNodeId())}
		for _, k := range t.GetKeyframes() {
			tv.Keyframes = append(tv.Keyframes, KeyframeIO{Time: k.GetTime(), Value: k.GetValue(), Easing: k.GetEasing()})
		}
		v.TrackList = append(v.TrackList, tv)
	}
	return v
}

func (b ClipBody) toProto(id string) *opendesignerv1.Clip {
	c := &opendesignerv1.Clip{
		Id: id, Name: b.Name, Duration: b.Duration, Trigger: b.Trigger, Delay: b.Delay,
		Repeat: int32(b.Repeat), Yoyo: b.Yoyo, TargetId: b.TargetId,
	}
	for _, t := range b.Tracks {
		pt := &opendesignerv1.Track{NodeId: t.NodeId, Prop: t.Prop}
		for _, k := range t.Keyframes {
			pt.Keyframes = append(pt.Keyframes, &opendesignerv1.Keyframe{Time: k.Time, Value: k.Value, Easing: k.Easing})
		}
		c.Tracks = append(c.Tracks, pt)
	}
	return c
}

// checkClip valida una clip sul documento locale con la stessa logica del
// server e restituisce un errore leggibile dall'agente.
func (s *Session) checkClip(tool string, c *opendesignerv1.Clip) error {
	s.mu.Lock()
	// Documento di servizio: condivide i nodi (sola lettura) e nient'altro.
	view := &opendesignerv1.Document{Nodes: s.doc.GetNodes()}
	err := core.ValidateClip(view, c)
	s.mu.Unlock()
	if err != nil {
		return fmt.Errorf("%s: %s (%s)", tool, clipErrHint(err), err)
	}
	return nil
}

// clipErrHint traduce un errore sentinella nel rimedio per l'agente.
func clipErrHint(err error) string {
	switch {
	case errors.Is(err, core.ErrNodeNotFound):
		return "un nodo citato non esiste: usa list_nodes per gli id"
	case errors.Is(err, core.ErrClipDuration):
		return "duration deve essere un numero > 0 (millisecondi)"
	case errors.Is(err, core.ErrClipTiming):
		return "delay deve essere >= 0 e repeat >= -1"
	case errors.Is(err, core.ErrClipTrigger):
		return "trigger deve essere uno di " + strings.Join(core.ClipTriggers, ", ")
	case errors.Is(err, core.ErrTrackProp):
		return "prop deve essere una di " + strings.Join(core.TrackProps, ", ")
	case errors.Is(err, core.ErrTrackKeyframes):
		return "ogni traccia ha bisogno di almeno un keyframe"
	case errors.Is(err, core.ErrKeyframeTime):
		return "i tempi dei keyframe devono essere ordinati e dentro [0, duration]"
	case errors.Is(err, core.ErrKeyframeValue):
		return "valore fuori range (opacity e draw stanno in [0,1])"
	case errors.Is(err, core.ErrEasing):
		return "easing valido: linear, easeIn, easeOut, easeInOut, spring, cubic-bezier(a,b,c,d) con a e c in [0,1]"
	case errors.Is(err, core.ErrDuplicateTrack):
		return "una sola traccia per (nodo, proprietà) in una clip"
	case errors.Is(err, core.ErrDrawTarget):
		return "draw funziona solo su vector, rect, ellipse e frame"
	}
	return "clip non valida"
}

// ---------------------------------------------------------------------------
// list_clips / get_clip
// ---------------------------------------------------------------------------

func (s *Session) ListClips(_ context.Context, _ struct{}) (ListClipsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListClipsOutput{Clips: []ClipSummary{}}
	for _, v := range clipViews(s.doc) {
		out.Clips = append(out.Clips, v.ClipSummary)
	}
	return out, nil
}

func (s *Session) GetClip(_ context.Context, in ClipIdInput) (ClipView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.doc.GetClips()[in.Id]
	if !ok {
		return ClipView{}, fmt.Errorf("clip %q non trovata: usa list_clips per gli id", in.Id)
	}
	return clipView(s.doc, c), nil
}

// ---------------------------------------------------------------------------
// create_clip / set_clip / delete_clip
// ---------------------------------------------------------------------------

func (s *Session) CreateClip(ctx context.Context, in ClipBody) (CreateClipOutput, error) {
	c := in.toProto(uuid.NewString())
	if err := s.checkClip("create_clip", c); err != nil {
		return CreateClipOutput{}, err
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: c}}})
	if err != nil {
		return CreateClipOutput{}, err
	}
	return CreateClipOutput{ClipId: c.GetId(), Seq: seq}, nil
}

// SetClip SOSTITUISCE la clip per intero (upsert assoluto): per ritoccare una
// clip si legge con get_clip, si modifica e si rimanda tutta.
func (s *Session) SetClip(ctx context.Context, in SetClipInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetClips()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("set_clip: clip %q non trovata (create_clip per crearne una nuova; list_clips per gli id)", in.Id)
	}
	c := in.ClipBody.toProto(in.Id)
	if err := s.checkClip("set_clip", c); err != nil {
		return SeqOutput{}, err
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: c}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

func (s *Session) DeleteClip(ctx context.Context, in ClipIdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetClips()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_clip: clip %q non trovata", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteClip{DeleteClip: &opendesignerv1.DeleteClip{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// animate_node
// ---------------------------------------------------------------------------

type AnimateNodeInput struct {
	NodeId   string   `json:"nodeId" jsonschema:"il nodo da animare"`
	Prop     string   `json:"prop" jsonschema:"opacity | x | y | scale | rotation | draw"`
	From     *float64 `json:"from,omitempty" jsonschema:"valore iniziale; omesso = il valore attuale del nodo (opacity/x/y/rotation), 1 per scale, 0 per draw"`
	To       *float64 `json:"to,omitempty" jsonschema:"valore finale; omesso solo per draw (default 1)"`
	Duration float64  `json:"duration,omitempty" jsonschema:"durata in ms (default 600)"`
	Easing   string   `json:"easing,omitempty" jsonschema:"curva (default easeOut): linear | easeIn | easeOut | easeInOut | spring | cubic-bezier(a,b,c,d)"`
	Trigger  string   `json:"trigger,omitempty" jsonschema:"enter (default) | hover | tap | loop | manual"`
	Delay    float64  `json:"delay,omitempty" jsonschema:"ritardo di QUESTA traccia in ms: la usa per sfalsare più elementi nella stessa clip"`
	ClipId   string   `json:"clipId,omitempty" jsonschema:"estendi proprio questa clip invece di cercarne una"`
	ClipName string   `json:"clipName,omitempty" jsonschema:"nome della clip da creare/riusare (se omesso e manca una clip con lo stesso trigger, si chiama come il trigger)"`
	Repeat   *int     `json:"repeat,omitempty" jsonschema:"ripetizioni extra della clip; -1 = infinito (solo creazione, o se passato)"`
	Yoyo     *bool    `json:"yoyo,omitempty" jsonschema:"andata e ritorno (solo creazione, o se passato)"`
}

type AnimateNodeOutput struct {
	ClipId   string  `json:"clipId"`
	TargetId string  `json:"targetId" jsonschema:"il nodo a cui la clip è appesa"`
	Created  bool    `json:"created" jsonschema:"true se è stata creata una clip nuova, false se ne è stata estesa una"`
	Tracks   int     `json:"tracks" jsonschema:"tracce totali nella clip dopo l'operazione"`
	Duration float64 `json:"duration" jsonschema:"durata della clip dopo l'operazione, in ms"`
	Seq      uint64  `json:"seq"`
}

// animationTarget: il nodo a cui appendere una clip per animare `id` -- il più
// vicino antenato frame/gruppo (la "schermata" o il gruppo che lo contiene); se
// non ne ha (sta direttamente sulla pagina) il nodo stesso.
func animationTarget(doc *opendesignerv1.Document, id string) string {
	cur := doc.GetNodes()[id]
	for p := doc.GetNodes()[cur.GetParentId()]; p != nil; p = doc.GetNodes()[p.GetParentId()] {
		switch p.GetShape().(type) {
		case *opendesignerv1.Node_Frame, *opendesignerv1.Node_Group:
			return p.GetId()
		}
	}
	return id
}

func currentValue(n *opendesignerv1.Node, prop string) float64 {
	switch prop {
	case "opacity":
		return n.GetOpacity()
	case "x":
		return n.GetX()
	case "y":
		return n.GetY()
	case "rotation":
		return n.GetRotation()
	case "scale":
		return 1
	}
	return 0 // draw
}

func (s *Session) AnimateNode(ctx context.Context, in AnimateNodeInput) (AnimateNodeOutput, error) {
	if !oneOf(in.Prop, core.TrackProps) {
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: prop deve essere una di %s, non %q", strings.Join(core.TrackProps, ", "), in.Prop)
	}
	if in.Trigger != "" && !oneOf(in.Trigger, core.ClipTriggers) {
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: trigger deve essere uno di %s, non %q", strings.Join(core.ClipTriggers, ", "), in.Trigger)
	}
	if in.Duration < 0 || math.IsNaN(in.Duration) || math.IsInf(in.Duration, 0) || in.Delay < 0 || math.IsNaN(in.Delay) || math.IsInf(in.Delay, 0) {
		return AnimateNodeOutput{}, errors.New("animate_node: duration e delay devono essere numeri finiti >= 0")
	}
	dur := in.Duration
	if dur == 0 {
		dur = 600
	}
	easing := in.Easing
	if easing == "" {
		easing = "easeOut"
	}
	if !core.ValidEasing(easing) {
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: easing %q non valido (%s)", easing, clipErrHint(core.ErrEasing))
	}
	trigger := in.Trigger
	if trigger == "" {
		trigger = "enter"
	}

	s.mu.Lock()
	n, ok := s.doc.GetNodes()[in.NodeId]
	if !ok {
		s.mu.Unlock()
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: nodo %q non trovato (vedi list_nodes)", in.NodeId)
	}
	from := currentValue(n, in.Prop)
	if in.From != nil {
		from = *in.From
	}
	var to float64
	switch {
	case in.To != nil:
		to = *in.To
	case in.Prop == "draw":
		to = 1
	default:
		s.mu.Unlock()
		return AnimateNodeOutput{}, errors.New("animate_node: `to` è obbligatorio (si può omettere solo per draw)")
	}
	target := animationTarget(s.doc, in.NodeId)

	// La clip da estendere: quella indicata, oppure una già appesa allo stesso
	// target con lo stesso trigger (e, se dato, lo stesso nome).
	var existing *opendesignerv1.Clip
	if in.ClipId != "" {
		existing = s.doc.GetClips()[in.ClipId]
		if existing == nil {
			s.mu.Unlock()
			return AnimateNodeOutput{}, fmt.Errorf("animate_node: clip %q non trovata (list_clips)", in.ClipId)
		}
	} else {
		ids := make([]string, 0, len(s.doc.GetClips()))
		for id := range s.doc.GetClips() {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			c := s.doc.GetClips()[id]
			ct := c.GetTrigger()
			if ct == "" {
				ct = "manual"
			}
			if c.GetTargetId() == target && ct == trigger && (in.ClipName == "" || c.GetName() == in.ClipName) {
				existing = c
				break
			}
		}
	}

	// I keyframe della traccia: con un ritardo si tiene il valore iniziale fino
	// a `delay`, poi si anima per `dur`.
	kfs := []*opendesignerv1.Keyframe{{Time: 0, Value: from, Easing: easing}}
	if in.Delay > 0 {
		kfs = []*opendesignerv1.Keyframe{{Time: 0, Value: from}, {Time: in.Delay, Value: from, Easing: easing}}
	}
	kfs = append(kfs, &opendesignerv1.Keyframe{Time: in.Delay + dur, Value: to})
	track := &opendesignerv1.Track{NodeId: in.NodeId, Prop: in.Prop, Keyframes: kfs}

	var clip *opendesignerv1.Clip
	created := existing == nil
	if created {
		name := in.ClipName
		if name == "" {
			name = trigger
		}
		clip = &opendesignerv1.Clip{Id: uuid.NewString(), Name: name, Trigger: trigger, TargetId: target}
	} else {
		clip = cloneClip(existing)
		target = clip.GetTargetId()
	}
	// Sostituisce la traccia (nodo, proprietà) se c'era già, altrimenti accoda.
	replaced := false
	for i, t := range clip.Tracks {
		if t.GetNodeId() == in.NodeId && t.GetProp() == in.Prop {
			clip.Tracks[i] = track
			replaced = true
		}
	}
	if !replaced {
		clip.Tracks = append(clip.Tracks, track)
	}
	if total := in.Delay + dur; total > clip.Duration {
		clip.Duration = total
	}
	if in.Repeat != nil {
		clip.Repeat = int32(*in.Repeat)
	}
	if in.Yoyo != nil {
		clip.Yoyo = *in.Yoyo
	}
	view := &opendesignerv1.Document{Nodes: s.doc.GetNodes()}
	err := core.ValidateClip(view, clip)
	s.mu.Unlock()
	if err != nil {
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: %s (%s)", clipErrHint(err), err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: clip}}})
	if err != nil {
		return AnimateNodeOutput{}, err
	}
	return AnimateNodeOutput{ClipId: clip.GetId(), TargetId: target, Created: created, Tracks: len(clip.Tracks), Duration: clip.GetDuration(), Seq: seq}, nil
}

// cloneClip: copia profonda (la clip del documento locale non va mutata: la
// condivide il flusso di Subscribe).
func cloneClip(c *opendesignerv1.Clip) *opendesignerv1.Clip {
	out := &opendesignerv1.Clip{
		Id: c.GetId(), Name: c.GetName(), Duration: c.GetDuration(), Trigger: c.GetTrigger(), Delay: c.GetDelay(),
		Repeat: c.GetRepeat(), Yoyo: c.GetYoyo(), TargetId: c.GetTargetId(),
	}
	for _, t := range c.GetTracks() {
		nt := &opendesignerv1.Track{NodeId: t.GetNodeId(), Prop: t.GetProp()}
		for _, k := range t.GetKeyframes() {
			nt.Keyframes = append(nt.Keyframes, &opendesignerv1.Keyframe{Time: k.GetTime(), Value: k.GetValue(), Easing: k.GetEasing()})
		}
		out.Tracks = append(out.Tracks, nt)
	}
	return out
}

// animationConventions è il manuale che ogni tool dell'animazione ripete in
// breve: chi vede un solo tool deve poter pilotare tutto.
const animationConventions = " Animation model: a CLIP belongs to a TARGET node (a screen, group or imported SVG) whose enter/hover/tap starts it, and holds TRACKS: one per (node, property) with KEYFRAMES {time ms, value, easing}. " +
	"Properties: opacity 0..1 (absolute), x/y (absolute local coordinates), scale (multiplier, base 1), rotation (absolute degrees), draw 0..1 (how much of the stroke is drawn; vector/rect/ellipse/frame only). " +
	"Triggers: enter (on mount), hover, tap, loop, manual. Easing of a keyframe applies to the segment that STARTS at it: linear, easeIn, easeOut, easeInOut, spring, cubic-bezier(a,b,c,d). " +
	"Before the first keyframe the first value holds, after the last the last value holds. Deleting a node removes its tracks; deleting a clip's target deletes the clip. export_code turns clips into Motion code (react) or CSS keyframes (html)."

func registerAnimationTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_clips", "List the document's animation clips (id, name, target, trigger, duration, repeat, track count)."+animationConventions, s.ListClips)
	addTool(srv, "get_clip", "Return one clip with all its tracks and keyframes (node names included)."+animationConventions, s.GetClip)
	addTool(srv, "create_clip", "Create a whole clip with its tracks in one call; returns the clip id. targetId and every track nodeId must exist; duration is in ms; keyframe times are in [0, duration]."+animationConventions, s.CreateClip)
	addTool(srv, "set_clip", "REPLACE a clip entirely (read it with get_clip, edit, send it all back). To add one animated property use animate_node instead."+animationConventions, s.SetClip)
	addTool(srv, "delete_clip", "Delete a clip by id (the nodes are untouched).", s.DeleteClip)
	addTool(srv, "animate_node", "Convenience: animate ONE property of a node from a value to a value. It finds (or creates) a clip on the node's nearest enclosing frame/group (or the node itself if it sits on the page) with the same trigger and adds/replaces the track there, growing the clip's duration if needed. "+
		"Call it several times with the same trigger to build one clip (use delay to stagger tracks). from defaults to the node's current value; draw defaults to 0 -> 1. Returns the clip id."+animationConventions, s.AnimateNode)
}
