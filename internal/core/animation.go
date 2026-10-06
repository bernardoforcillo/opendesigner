package core

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// ANIMATION -- the Go half (the authority) of web/src/store/applyOp.ts for the
// two ops setClip / deleteClip.
//
// A CLIP is a set of TRACKS (node, property) with keyframes, attached to a
// "target" node (screen, group, SVG) whose hover/tap/enter starts it. Animated
// nodes are referenced by id, never copied. The invariants:
//
//	1. non-empty id, finite duration > 0, finite delay >= 0, repeat >= -1,
//	   trigger in the known set (empty = "manual"), EXISTING target;
//	2. every track has an existing node, a whitelisted property, at least one
//	   keyframe with finite, non-decreasing times inside [0, duration], finite
//	   values (opacity and draw in [0,1]) and an easing within the grammar;
//	3. two tracks with the same (node, property) pair in the same clip are a
//	   conflict (which one would win?) and are rejected;
//	4. `draw` only makes sense where there is an outline: vector, rect, ellipse,
//	   frame;
//	5. deleting a node (or a page) removes the tracks that animated it and
//	   deletes the clips whose target is gone. A clip left WITHOUT tracks but
//	   with a live target is kept: it is an empty clip, not an orphan.
//
// Upserts are ABSOLUTE: the inverse of an op is the previous state (see
// web/src/store/history.ts). The `Clips` map may be nil and is initialized on
// the first write.

var (
	ErrNilClip        = errors.New("core: nil clip")
	ErrClipNotFound   = errors.New("core: clip not found")
	ErrClipDuration   = errors.New("core: clip duration must be finite and > 0")
	ErrClipTiming     = errors.New("core: clip delay must be finite and >= 0, repeat >= -1")
	ErrClipTrigger    = errors.New("core: unknown clip trigger")
	ErrTrackProp      = errors.New("core: unknown track property")
	ErrTrackKeyframes = errors.New("core: track needs at least one keyframe")
	ErrKeyframeTime   = errors.New("core: keyframe times must be finite, non-decreasing and within [0, duration]")
	ErrKeyframeValue  = errors.New("core: keyframe value out of range")
	ErrEasing         = errors.New("core: invalid easing")
	ErrDuplicateTrack = errors.New("core: duplicate (node, prop) track in clip")
	ErrDrawTarget     = errors.New("core: draw needs a node with a stroke path (vector, rect, ellipse, frame)")
)

// ClipTriggers and TrackProps are the closed sets of the model; the TS mirror
// (web/src/animation/engine.ts) and the code generator repeat them.
var (
	ClipTriggers = []string{"enter", "hover", "tap", "loop", "manual"}
	TrackProps   = []string{"opacity", "x", "y", "scale", "rotation", "draw"}
)

func inSet(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// easingNum is a restricted decimal number (no inf/nan/hex that strconv would
// accept): the same regex lives in web/src/animation/engine.ts.
const easingNum = `[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`

var cubicBezierRe = regexp.MustCompile(`^cubic-bezier\(\s*(` + easingNum + `)\s*,\s*(` + easingNum + `)\s*,\s*(` + easingNum + `)\s*,\s*(` + easingNum + `)\s*\)$`)

// ParseCubicBezier extracts the four control points from "cubic-bezier(a,b,c,d)".
// As in CSS the x values (a, c) must be in [0,1]: outside that it would be a
// curve that is not a function of time (and an invalid CSS declaration in the
// html export).
func ParseCubicBezier(s string) (p [4]float64, ok bool) {
	m := cubicBezierRe.FindStringSubmatch(s)
	if m == nil {
		return p, false
	}
	for i := 0; i < 4; i++ {
		v, err := strconv.ParseFloat(m[i+1], 64)
		if err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
			return p, false
		}
		p[i] = v
	}
	if p[0] < 0 || p[0] > 1 || p[2] < 0 || p[2] > 1 {
		return p, false
	}
	return p, true
}

// ValidEasing reports whether the string is within the easing grammar.
func ValidEasing(s string) bool {
	switch s {
	case "", "linear", "easeIn", "easeOut", "easeInOut", "spring":
		return true
	}
	_, ok := ParseCubicBezier(s)
	return ok
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// canDraw: the node types that have an outline on which to "draw" the stroke.
func canDraw(n *opendesignerv1.Node) bool {
	switch n.GetShape().(type) {
	case *opendesignerv1.Node_Vector, *opendesignerv1.Node_Rect, *opendesignerv1.Node_Ellipse, *opendesignerv1.Node_Frame:
		return true
	}
	return false
}

func validateClip(doc *opendesignerv1.Document, c *opendesignerv1.Clip) error {
	id := c.GetId()
	if !finite(c.GetDuration()) || c.GetDuration() <= 0 {
		return fmt.Errorf("%w: %v (clip %s)", ErrClipDuration, c.GetDuration(), id)
	}
	if !finite(c.GetDelay()) || c.GetDelay() < 0 || c.GetRepeat() < -1 {
		return fmt.Errorf("%w (clip %s)", ErrClipTiming, id)
	}
	if c.GetTrigger() != "" && !inSet(ClipTriggers, c.GetTrigger()) {
		return fmt.Errorf("%w: %q (clip %s)", ErrClipTrigger, c.GetTrigger(), id)
	}
	if !nodeExists(doc, c.GetTargetId()) {
		return fmt.Errorf("%w: %q (clip %s target)", ErrNodeNotFound, c.GetTargetId(), id)
	}
	type key struct{ node, prop string }
	seen := map[key]bool{}
	for _, t := range c.GetTracks() {
		n, ok := doc.GetNodes()[t.GetNodeId()]
		if !ok {
			return fmt.Errorf("%w: %q (clip %s track)", ErrNodeNotFound, t.GetNodeId(), id)
		}
		if !inSet(TrackProps, t.GetProp()) {
			return fmt.Errorf("%w: %q (clip %s)", ErrTrackProp, t.GetProp(), id)
		}
		k := key{t.GetNodeId(), t.GetProp()}
		if seen[k] {
			return fmt.Errorf("%w: %s.%s (clip %s)", ErrDuplicateTrack, k.node, k.prop, id)
		}
		seen[k] = true
		if t.GetProp() == "draw" && !canDraw(n) {
			return fmt.Errorf("%w: %s (clip %s)", ErrDrawTarget, t.GetNodeId(), id)
		}
		if len(t.GetKeyframes()) == 0 {
			return fmt.Errorf("%w: %s.%s (clip %s)", ErrTrackKeyframes, k.node, k.prop, id)
		}
		prev := 0.0
		for i, kf := range t.GetKeyframes() {
			tm := kf.GetTime()
			if !finite(tm) || tm < 0 || tm > c.GetDuration() || (i > 0 && tm < prev) {
				return fmt.Errorf("%w: %v (clip %s %s.%s)", ErrKeyframeTime, tm, id, k.node, k.prop)
			}
			prev = tm
			v := kf.GetValue()
			bounded := t.GetProp() == "opacity" || t.GetProp() == "draw"
			if !finite(v) || (bounded && (v < 0 || v > 1)) {
				return fmt.Errorf("%w: %v (clip %s %s.%s)", ErrKeyframeValue, v, id, k.node, k.prop)
			}
			if !ValidEasing(kf.GetEasing()) {
				return fmt.Errorf("%w: %q (clip %s %s.%s)", ErrEasing, kf.GetEasing(), id, k.node, k.prop)
			}
		}
	}
	return nil
}

// ValidateClip reports whether a SetClip with this clip would be accepted by
// the document, without applying it: callers that want a clear error BEFORE
// sending the op (the MCP tools) use the same logic as the authority.
func ValidateClip(doc *opendesignerv1.Document, c *opendesignerv1.Clip) error {
	if c == nil || c.GetId() == "" {
		return ErrNilClip
	}
	return validateClip(doc, c)
}

func applySetClip(doc *opendesignerv1.Document, s *opendesignerv1.SetClip) error {
	c := s.GetClip()
	if c == nil || c.GetId() == "" {
		return ErrNilClip
	}
	if err := validateClip(doc, c); err != nil {
		return err
	}
	if doc.Clips == nil {
		doc.Clips = map[string]*opendesignerv1.Clip{}
	}
	doc.Clips[c.GetId()] = c
	return nil
}

func applyDeleteClip(doc *opendesignerv1.Document, d *opendesignerv1.DeleteClip) error {
	if _, ok := doc.GetClips()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrClipNotFound, d.GetId())
	}
	delete(doc.Clips, d.GetId())
	return nil
}

// cascadeClips removes from the clips whatever animated the nodes just deleted.
// Modified entries are REPLACED by copies, never mutated in place (like
// cascadeFlows): with the server's copy-on-write clone the object might be
// shared with the previous generation.
func cascadeClips(doc *opendesignerv1.Document, gone map[string]bool) {
	if len(gone) == 0 {
		return
	}
	for id, c := range doc.GetClips() {
		if gone[c.GetTargetId()] {
			delete(doc.Clips, id)
			continue
		}
		hit := false
		for _, t := range c.GetTracks() {
			if gone[t.GetNodeId()] {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		cp := proto.Clone(c).(*opendesignerv1.Clip)
		cp.Tracks = cp.Tracks[:0]
		for _, t := range c.GetTracks() {
			if !gone[t.GetNodeId()] {
				cp.Tracks = append(cp.Tracks, proto.Clone(t).(*opendesignerv1.Track))
			}
		}
		doc.Clips[id] = cp
	}
}
