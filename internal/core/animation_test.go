package core

import (
	"errors"
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

func setClipOp(c *opendesignerv1.Clip) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: c}}}
}

func deleteClipOp(id string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteClip{DeleteClip: &opendesignerv1.DeleteClip{Id: id}}}
}

func kfs(pairs ...float64) []*opendesignerv1.Keyframe {
	var out []*opendesignerv1.Keyframe
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, &opendesignerv1.Keyframe{Time: pairs[i], Value: pairs[i+1]})
	}
	return out
}

func trk(node, prop string, k ...*opendesignerv1.Keyframe) *opendesignerv1.Track {
	return &opendesignerv1.Track{NodeId: node, Prop: prop, Keyframes: k}
}

func animDoc(t *testing.T) *opendesignerv1.Document {
	doc := NewDocument("d", "t")
	for _, id := range []string{"a", "b"} {
		mustApplyFlow(t, doc, flowCreateOp(flowRect(id, "page1")))
	}
	mustApplyFlow(t, doc, flowCreateOp(flowRect("c", "a")))
	txt := flowRect("txt", "a")
	txt.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{}}
	mustApplyFlow(t, doc, flowCreateOp(txt))
	mustApplyFlow(t, doc, setClipOp(&opendesignerv1.Clip{
		Id: "k1", Name: "enter", Duration: 1000, Trigger: "enter", TargetId: "a",
		Tracks: []*opendesignerv1.Track{trk("a", "opacity", kfs(0, 0, 1000, 1)...), trk("c", "x", kfs(0, 0, 1000, 40)...)},
	}))
	return doc
}

func TestClipRejections(t *testing.T) {
	doc := animDoc(t)
	before := proto.Clone(doc)
	base := func(mut func(c *opendesignerv1.Clip)) *opendesignerv1.Op {
		c := &opendesignerv1.Clip{Id: "k2", Duration: 500, TargetId: "a",
			Tracks: []*opendesignerv1.Track{trk("a", "opacity", kfs(0, 0, 500, 1)...)}}
		mut(c)
		return setClipOp(c)
	}
	cases := []struct {
		name string
		op   *opendesignerv1.Op
		want error
	}{
		{"clip nil", setClipOp(nil), ErrNilClip},
		{"empty id", base(func(c *opendesignerv1.Clip) { c.Id = "" }), ErrNilClip},
		{"zero duration", base(func(c *opendesignerv1.Clip) { c.Duration = 0 }), ErrClipDuration},
		{"negative duration", base(func(c *opendesignerv1.Clip) { c.Duration = -5 }), ErrClipDuration},
		{"NaN duration", base(func(c *opendesignerv1.Clip) { c.Duration = math.NaN() }), ErrClipDuration},
		{"inf duration", base(func(c *opendesignerv1.Clip) { c.Duration = math.Inf(1) }), ErrClipDuration},
		{"negative delay", base(func(c *opendesignerv1.Clip) { c.Delay = -1 }), ErrClipTiming},
		{"repeat < -1", base(func(c *opendesignerv1.Clip) { c.Repeat = -2 }), ErrClipTiming},
		{"unknown trigger", base(func(c *opendesignerv1.Clip) { c.Trigger = "scroll" }), ErrClipTrigger},
		{"missing target", base(func(c *opendesignerv1.Clip) { c.TargetId = "" }), ErrNodeNotFound},
		{"ghost target", base(func(c *opendesignerv1.Clip) { c.TargetId = "ghost" }), ErrNodeNotFound},
		{"ghost track node", base(func(c *opendesignerv1.Clip) { c.Tracks[0].NodeId = "ghost" }), ErrNodeNotFound},
		{"unknown prop", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Prop = "width" }), ErrTrackProp},
		{"zero keyframes", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = nil }), ErrTrackKeyframes},
		{"negative time", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(-1, 0, 500, 1) }), ErrKeyframeTime},
		{"time beyond duration", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(0, 0, 501, 1) }), ErrKeyframeTime},
		{"decreasing time", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(0, 0, 300, 1, 200, 1) }), ErrKeyframeTime},
		{"NaN time", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(math.NaN(), 0) }), ErrKeyframeTime},
		{"NaN value", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(0, math.NaN()) }), ErrKeyframeValue},
		{"opacity > 1", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(0, 1.5) }), ErrKeyframeValue},
		{"opacity < 0", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes = kfs(0, -0.1) }), ErrKeyframeValue},
		{"draw > 1", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Prop = "draw"; c.Tracks[0].Keyframes = kfs(0, 2) }), ErrKeyframeValue},
		{"garbage easing", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes[0].Easing = "bounce" }), ErrEasing},
		{"bezier with 3 numbers", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes[0].Easing = "cubic-bezier(0,0,1)" }), ErrEasing},
		{"bezier with nan", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes[0].Easing = "cubic-bezier(0,nan,1,1)" }), ErrEasing},
		{"bezier with inf", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes[0].Easing = "cubic-bezier(0,inf,1,1)" }), ErrEasing},
		{"bezier x outside [0,1]", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes[0].Easing = "cubic-bezier(2,0,1,1)" }), ErrEasing},
		{"bezier with trailing text", base(func(c *opendesignerv1.Clip) { c.Tracks[0].Keyframes[0].Easing = "cubic-bezier(0,0,1,1)x" }), ErrEasing},
		{"duplicate track", base(func(c *opendesignerv1.Clip) { c.Tracks = append(c.Tracks, trk("a", "opacity", kfs(0, 1)...)) }), ErrDuplicateTrack},
		{"draw on text", base(func(c *opendesignerv1.Clip) {
			c.Tracks = []*opendesignerv1.Track{trk("txt", "draw", kfs(0, 0, 500, 1)...)}
		}), ErrDrawTarget},
		{"delete nonexistent", deleteClipOp("ghost"), ErrClipNotFound},
	}
	for _, c := range cases {
		if err := Apply(doc, c.op); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
	if !proto.Equal(before, doc) {
		t.Fatal("a rejected op modified the document")
	}
}

func TestClipAccepts(t *testing.T) {
	doc := animDoc(t)
	ok := []*opendesignerv1.Clip{
		// empty trigger = manual; same time repeated = jump; valid easings
		{Id: "k2", Duration: 100, TargetId: "a", Tracks: []*opendesignerv1.Track{
			{NodeId: "a", Prop: "scale", Keyframes: []*opendesignerv1.Keyframe{
				{Time: 0, Value: 1, Easing: "spring"}, {Time: 50, Value: 2, Easing: "cubic-bezier(0.25, -0.5, .75, 1.5)"}, {Time: 50, Value: 3}, {Time: 100, Value: 1, Easing: "easeInOut"}}},
			trk("a", "draw", kfs(0, 0, 100, 1)...), // rect has an outline
		}},
		// clip without tracks but with a live target
		{Id: "k3", Duration: 1, TargetId: "b", Trigger: "loop", Repeat: -1, Yoyo: true, Delay: 20},
	}
	for _, c := range ok {
		if err := Apply(doc, setClipOp(c)); err != nil {
			t.Errorf("%s: %v", c.Id, err)
		}
	}
	// absolute upsert: k1 is replaced
	mustApplyFlow(t, doc, setClipOp(&opendesignerv1.Clip{Id: "k1", Duration: 10, TargetId: "b"}))
	if len(doc.Clips["k1"].Tracks) != 0 || doc.Clips["k1"].TargetId != "b" {
		t.Fatal("upsert is not absolute")
	}
	mustApplyFlow(t, doc, deleteClipOp("k1"))
	if _, ok := doc.Clips["k1"]; ok {
		t.Fatal("clip not deleted")
	}
}

func TestClipCascade(t *testing.T) {
	doc := animDoc(t)
	mustApplyFlow(t, doc, setClipOp(&opendesignerv1.Clip{Id: "k2", Duration: 100, TargetId: "b",
		Tracks: []*opendesignerv1.Track{trk("c", "opacity", kfs(0, 0, 100, 1)...), trk("b", "y", kfs(0, 0, 100, 9)...)}}))
	// deleting "c": k1 and k2 lose their track on c but remain (live target)
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "c"}}})
	if len(doc.Clips["k1"].Tracks) != 1 || doc.Clips["k1"].Tracks[0].NodeId != "a" {
		t.Fatalf("k1: %v", doc.Clips["k1"])
	}
	if len(doc.Clips["k2"].Tracks) != 1 || doc.Clips["k2"].Tracks[0].NodeId != "b" {
		t.Fatalf("k2: %v", doc.Clips["k2"])
	}
	// deleting "a" (k1's target) deletes k1 and keeps k2
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "a"}}})
	if _, ok := doc.Clips["k1"]; ok || doc.Clips["k2"] == nil {
		t.Fatalf("clips: %v", doc.Clips)
	}
	// a clip with zero remaining tracks is kept
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "b"}}})
	if len(doc.Clips) != 0 {
		t.Fatalf("target gone: clip left %v", doc.Clips)
	}
}

func TestClipCascadeKeepsEmptyClip(t *testing.T) {
	doc := animDoc(t)
	mustApplyFlow(t, doc, setClipOp(&opendesignerv1.Clip{Id: "k2", Duration: 100, TargetId: "b",
		Tracks: []*opendesignerv1.Track{trk("c", "opacity", kfs(0, 0)...)}}))
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "c"}}})
	if k := doc.Clips["k2"]; k == nil || len(k.Tracks) != 0 {
		t.Fatalf("an empty clip with a live target must remain: %v", k)
	}
}

func TestClipCascadeOnPageDelete(t *testing.T) {
	doc := animDoc(t)
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: &opendesignerv1.Page{Id: "p2", Name: "P2"}}}})
	mustApplyFlow(t, doc, flowCreateOp(flowRect("z", "p2")))
	mustApplyFlow(t, doc, setClipOp(&opendesignerv1.Clip{Id: "k9", Duration: 100, TargetId: "a",
		Tracks: []*opendesignerv1.Track{trk("z", "opacity", kfs(0, 0)...)}}))
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePage{DeletePage: &opendesignerv1.DeletePage{Id: "p2"}}})
	if len(doc.Clips["k9"].Tracks) != 0 {
		t.Fatal("track on a node of a deleted page left over")
	}
}

// The server's copy-on-write clone shares the clips' pointers: the cascade
// must replace, never mutate.
func TestClipCascadeDoesNotMutateShared(t *testing.T) {
	doc := animDoc(t)
	prev := doc.Clips["k1"]
	snapshot := proto.Clone(prev)
	next := &opendesignerv1.Document{Id: doc.Id, Pages: doc.Pages, Nodes: doc.Nodes,
		Clips: map[string]*opendesignerv1.Clip{"k1": prev}}
	cascadeClips(next, map[string]bool{"c": true})
	if len(next.Clips["k1"].Tracks) != 1 {
		t.Fatal("cascade not applied")
	}
	if !proto.Equal(prev, snapshot) {
		t.Fatal("the cascade mutated a shared clip")
	}
	cascadeClips(next, map[string]bool{"a": true})
	if len(next.Clips) != 0 || !proto.Equal(prev, snapshot) {
		t.Fatal("wrong cascade on the target")
	}
}

func TestValidEasing(t *testing.T) {
	good := []string{"", "linear", "easeIn", "easeOut", "easeInOut", "spring", "cubic-bezier(0,0,1,1)", "cubic-bezier( 0.1 , -2 , 0.9 , 3 )", "cubic-bezier(.4,0,.2,1)", "cubic-bezier(1e-1,0,1,1)"}
	bad := []string{"ease", "Linear", "cubic-bezier()", "cubic-bezier(0,0,1,1,1)", "cubic-bezier(a,b,c,d)", "cubic-bezier(0,0,1,)", "cubic-bezier(0,0,1,1) ", " linear", "cubic-bezier(-0.1,0,1,1)", "cubic-bezier(0,0,1.1,1)", "cubic-bezier(0,0,1,1e999)", "cubic-bezier(0x1,0,1,1)"}
	for _, s := range good {
		if !ValidEasing(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range bad {
		if ValidEasing(s) {
			t.Errorf("%q should be rejected", s)
		}
	}
}
