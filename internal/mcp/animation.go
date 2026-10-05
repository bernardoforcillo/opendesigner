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

// The animation tools: the agent reads and writes the document's CLIPs
// (keyframe tracks on properties of existing nodes). The model lives in
// internal/core/animation.go and docs/animation.md; the validation that the
// tools run BEFORE sending the op is the same as the authority's
// (core.ValidateClip), so the error the agent reads says what to fix instead
// of an opaque rejection.

// ---------------------------------------------------------------------------
// views and inputs
// ---------------------------------------------------------------------------

type KeyframeIO struct {
	Time   float64 `json:"time" jsonschema:"milliseconds from the start of the clip, 0..duration"`
	Value  float64 `json:"value" jsonschema:"value of the property at that instant"`
	Easing string  `json:"easing,omitempty" jsonschema:"curve of the segment that STARTS at this keyframe: linear (default) | easeIn | easeOut | easeInOut | spring | cubic-bezier(a,b,c,d) with a and c in [0,1]"`
}

type TrackIO struct {
	NodeId    string       `json:"nodeId" jsonschema:"id of the animated node (see list_nodes)"`
	Prop      string       `json:"prop" jsonschema:"opacity (0..1) | x | y (absolute local coordinates of the node) | scale (multiplier, base 1) | rotation (absolute degrees) | draw (0..1: how much of the stroke is drawn; only vector, rect, ellipse, frame with a stroke)"`
	Keyframes []KeyframeIO `json:"keyframes" jsonschema:"at least one, ordered by time (equal times = jump)"`
}

// ClipBody is the content of a clip, the same for creation and replacement.
type ClipBody struct {
	Name     string    `json:"name,omitempty" jsonschema:"free-form name: enter, hover, loading..."`
	TargetId string    `json:"targetId" jsonschema:"the node (screen, group or SVG) the clip belongs to: its enter/hover/tap starts it. The tracks may concern the target and its descendants"`
	Duration float64   `json:"duration" jsonschema:"duration in milliseconds, > 0"`
	Trigger  string    `json:"trigger,omitempty" jsonschema:"enter (on appearance) | hover | tap | loop | manual (default: started by code)"`
	Delay    float64   `json:"delay,omitempty" jsonschema:"initial delay in ms"`
	Repeat   int       `json:"repeat,omitempty" jsonschema:"EXTRA repetitions after the first; -1 = infinite"`
	Yoyo     bool      `json:"yoyo,omitempty" jsonschema:"odd repetitions run backwards"`
	Tracks   []TrackIO `json:"tracks,omitempty"`
}

type SetClipInput struct {
	Id string `json:"id" jsonschema:"id of the clip to REPLACE entirely (see list_clips)"`
	ClipBody
}

type ClipIdInput struct {
	Id string `json:"id" jsonschema:"id of the clip (see list_clips)"`
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

// ClipViews lists a document's clips, sorted by id (also used by
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

// checkClip validates a clip against the local document with the same logic as
// the server and returns an error the agent can read.
func (s *Session) checkClip(tool string, c *opendesignerv1.Clip) error {
	s.mu.Lock()
	// Service document: it shares the nodes (read-only) and nothing else.
	view := &opendesignerv1.Document{Nodes: s.doc.GetNodes()}
	err := core.ValidateClip(view, c)
	s.mu.Unlock()
	if err != nil {
		return fmt.Errorf("%s: %s (%s)", tool, clipErrHint(err), err)
	}
	return nil
}

// clipErrHint translates a sentinel error into the remedy for the agent.
func clipErrHint(err error) string {
	switch {
	case errors.Is(err, core.ErrNodeNotFound):
		return "a referenced node does not exist: use list_nodes for the ids"
	case errors.Is(err, core.ErrClipDuration):
		return "duration must be a number > 0 (milliseconds)"
	case errors.Is(err, core.ErrClipTiming):
		return "delay must be >= 0 and repeat >= -1"
	case errors.Is(err, core.ErrClipTrigger):
		return "trigger must be one of " + strings.Join(core.ClipTriggers, ", ")
	case errors.Is(err, core.ErrTrackProp):
		return "prop must be one of " + strings.Join(core.TrackProps, ", ")
	case errors.Is(err, core.ErrTrackKeyframes):
		return "every track needs at least one keyframe"
	case errors.Is(err, core.ErrKeyframeTime):
		return "keyframe times must be ordered and within [0, duration]"
	case errors.Is(err, core.ErrKeyframeValue):
		return "value out of range (opacity and draw are in [0,1])"
	case errors.Is(err, core.ErrEasing):
		return "valid easing: linear, easeIn, easeOut, easeInOut, spring, cubic-bezier(a,b,c,d) with a and c in [0,1]"
	case errors.Is(err, core.ErrDuplicateTrack):
		return "only one track per (node, property) in a clip"
	case errors.Is(err, core.ErrDrawTarget):
		return "draw only works on vector, rect, ellipse and frame"
	}
	return "invalid clip"
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
		return ClipView{}, fmt.Errorf("clip %q not found: use list_clips for the ids", in.Id)
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

// SetClip REPLACES the clip entirely (absolute upsert): to tweak a clip you
// read it with get_clip, modify it and send it all back.
func (s *Session) SetClip(ctx context.Context, in SetClipInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetClips()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("set_clip: clip %q not found (create_clip to create a new one; list_clips for the ids)", in.Id)
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
		return SeqOutput{}, fmt.Errorf("delete_clip: clip %q not found", in.Id)
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
	NodeId   string   `json:"nodeId" jsonschema:"the node to animate"`
	Prop     string   `json:"prop" jsonschema:"opacity | x | y | scale | rotation | draw"`
	From     *float64 `json:"from,omitempty" jsonschema:"initial value; omitted = the node's current value (opacity/x/y/rotation), 1 for scale, 0 for draw"`
	To       *float64 `json:"to,omitempty" jsonschema:"final value; omitted only for draw (default 1)"`
	Duration float64  `json:"duration,omitempty" jsonschema:"duration in ms (default 600)"`
	Easing   string   `json:"easing,omitempty" jsonschema:"curve (default easeOut): linear | easeIn | easeOut | easeInOut | spring | cubic-bezier(a,b,c,d)"`
	Trigger  string   `json:"trigger,omitempty" jsonschema:"enter (default) | hover | tap | loop | manual"`
	Delay    float64  `json:"delay,omitempty" jsonschema:"delay of THIS track in ms: use it to stagger several elements in the same clip"`
	ClipId   string   `json:"clipId,omitempty" jsonschema:"extend exactly this clip instead of looking for one"`
	ClipName string   `json:"clipName,omitempty" jsonschema:"name of the clip to create/reuse (if omitted and no clip with the same trigger exists, it is named after the trigger)"`
	Repeat   *int     `json:"repeat,omitempty" jsonschema:"extra repetitions of the clip; -1 = infinite (only on creation, or if passed)"`
	Yoyo     *bool    `json:"yoyo,omitempty" jsonschema:"back and forth (only on creation, or if passed)"`
}

type AnimateNodeOutput struct {
	ClipId   string  `json:"clipId"`
	TargetId string  `json:"targetId" jsonschema:"the node the clip is attached to"`
	Created  bool    `json:"created" jsonschema:"true if a new clip was created, false if an existing one was extended"`
	Tracks   int     `json:"tracks" jsonschema:"total tracks in the clip after the operation"`
	Duration float64 `json:"duration" jsonschema:"duration of the clip after the operation, in ms"`
	Seq      uint64  `json:"seq"`
}

// animationTarget: the node to attach a clip to in order to animate `id` -- the
// nearest ancestor frame/group (the "screen" or the group that contains it); if
// it has none (it sits directly on the page) the node itself.
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
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: prop must be one of %s, not %q", strings.Join(core.TrackProps, ", "), in.Prop)
	}
	if in.Trigger != "" && !oneOf(in.Trigger, core.ClipTriggers) {
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: trigger must be one of %s, not %q", strings.Join(core.ClipTriggers, ", "), in.Trigger)
	}
	if in.Duration < 0 || math.IsNaN(in.Duration) || math.IsInf(in.Duration, 0) || in.Delay < 0 || math.IsNaN(in.Delay) || math.IsInf(in.Delay, 0) {
		return AnimateNodeOutput{}, errors.New("animate_node: duration and delay must be finite numbers >= 0")
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
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: invalid easing %q (%s)", easing, clipErrHint(core.ErrEasing))
	}
	trigger := in.Trigger
	if trigger == "" {
		trigger = "enter"
	}

	s.mu.Lock()
	n, ok := s.doc.GetNodes()[in.NodeId]
	if !ok {
		s.mu.Unlock()
		return AnimateNodeOutput{}, fmt.Errorf("animate_node: node %q not found (see list_nodes)", in.NodeId)
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
		return AnimateNodeOutput{}, errors.New("animate_node: `to` is required (it can only be omitted for draw)")
	}
	target := animationTarget(s.doc, in.NodeId)

	// The clip to extend: the indicated one, or one already attached to the same
	// target with the same trigger (and, if given, the same name).
	var existing *opendesignerv1.Clip
	if in.ClipId != "" {
		existing = s.doc.GetClips()[in.ClipId]
		if existing == nil {
			s.mu.Unlock()
			return AnimateNodeOutput{}, fmt.Errorf("animate_node: clip %q not found (list_clips)", in.ClipId)
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

	// The track's keyframes: with a delay the initial value is held until
	// `delay`, then it animates for `dur`.
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
	// Replaces the (node, property) track if it already existed, otherwise appends.
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

// cloneClip: deep copy (the local document's clip must not be mutated: the
// Subscribe stream shares it).
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

// animationConventions is the manual that every animation tool repeats in
// brief: whoever sees a single tool must be able to drive everything.
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
