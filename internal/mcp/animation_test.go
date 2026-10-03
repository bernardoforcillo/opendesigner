package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

func rect(t *testing.T, s *odmcp.Session, parent, name string) string {
	t.Helper()
	out, err := s.CreateRectangle(context.Background(), odmcp.CreateShapeInput{ParentId: parent, X: 10, Y: 20, Width: 30, Height: 30, Name: name})
	if err != nil {
		t.Fatalf("CreateRectangle(%s): %v", name, err)
	}
	return out.NodeId
}

// TestAnimationToolsEndToEnd: crea, legge, estende con animate_node, sostituisce
// e cancella le clip dai tool, e verifica che get_document le includa.
func TestAnimationToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	card := rect(t, s, home, "Card")
	title := rect(t, s, home, "Titolo")

	// create_clip: una clip intera con due tracce
	created, err := s.CreateClip(ctx, odmcp.ClipBody{
		Name: "entrata", TargetId: home, Duration: 800, Trigger: "enter",
		Tracks: []odmcp.TrackIO{
			{NodeId: card, Prop: "opacity", Keyframes: []odmcp.KeyframeIO{{Time: 0, Value: 0, Easing: "easeOut"}, {Time: 800, Value: 1}}},
			{NodeId: title, Prop: "y", Keyframes: []odmcp.KeyframeIO{{Time: 0, Value: 40}, {Time: 800, Value: 20, Easing: "spring"}}},
		},
	})
	if err != nil || created.ClipId == "" {
		t.Fatalf("CreateClip: %+v %v", created, err)
	}
	list, _ := s.ListClips(ctx, struct{}{})
	if len(list.Clips) != 1 || list.Clips[0].Tracks != 2 || list.Clips[0].TargetName != "Home" || list.Clips[0].Trigger != "enter" {
		t.Fatalf("ListClips = %+v", list)
	}
	got, err := s.GetClip(ctx, odmcp.ClipIdInput{Id: created.ClipId})
	if err != nil || len(got.TrackList) != 2 || got.TrackList[0].NodeName == "" || got.TrackList[1].Keyframes[1].Easing != "spring" {
		t.Fatalf("GetClip = %+v %v", got, err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.Clips) != 1 || doc.Clips[0].Id != created.ClipId {
		t.Fatalf("get_document.clips = %+v", doc.Clips)
	}

	// animate_node: estende la clip 'enter' della stessa schermata (target = Home,
	// l'antenato frame del nodo), sostituisce la traccia esistente e allunga la durata.
	ext, err := s.AnimateNode(ctx, odmcp.AnimateNodeInput{NodeId: title, Prop: "opacity", To: ptr(1.0), From: ptr(0.0), Duration: 500, Delay: 700})
	if err != nil || ext.Created || ext.ClipId != created.ClipId || ext.Tracks != 3 || ext.Duration != 1200 || ext.TargetId != home {
		t.Fatalf("AnimateNode extend = %+v %v", ext, err)
	}
	rep, err := s.AnimateNode(ctx, odmcp.AnimateNodeInput{NodeId: title, Prop: "opacity", To: ptr(0.5)})
	if err != nil || rep.Tracks != 3 || rep.Created {
		t.Fatalf("AnimateNode replace = %+v %v", rep, err)
	}
	got, _ = s.GetClip(ctx, odmcp.ClipIdInput{Id: created.ClipId})
	var tr odmcp.TrackView
	for _, x := range got.TrackList {
		if x.NodeId == title && x.Prop == "opacity" {
			tr = x
		}
	}
	// from = valore attuale (opacity 1), nessun ritardo, easing di default easeOut
	if len(tr.Keyframes) != 2 || tr.Keyframes[0].Value != 1 || tr.Keyframes[0].Easing != "easeOut" || tr.Keyframes[1].Value != 0.5 || tr.Keyframes[1].Time != 600 {
		t.Fatalf("traccia sostituita = %+v", tr)
	}
	if got.Duration != 1200 {
		t.Fatalf("la durata non deve ridursi: %v", got.Duration)
	}

	// trigger diverso: clip nuova (hover) appesa allo stesso target; draw di default 0 -> 1 su una rect
	hov, err := s.AnimateNode(ctx, odmcp.AnimateNodeInput{NodeId: card, Prop: "scale", To: ptr(1.1), Trigger: "hover", Duration: 200, ClipName: "hover card", Yoyo: ptr(true)})
	if err != nil || !hov.Created || hov.ClipId == created.ClipId || hov.Tracks != 1 {
		t.Fatalf("AnimateNode hover = %+v %v", hov, err)
	}
	hc, _ := s.GetClip(ctx, odmcp.ClipIdInput{Id: hov.ClipId})
	if hc.Name != "hover card" || !hc.Yoyo || hc.TrackList[0].Keyframes[0].Value != 1 {
		t.Fatalf("clip hover = %+v", hc)
	}
	dr, err := s.AnimateNode(ctx, odmcp.AnimateNodeInput{NodeId: card, Prop: "draw", Trigger: "loop"})
	if err != nil || !dr.Created {
		t.Fatalf("AnimateNode draw = %+v %v", dr, err)
	}

	// un nodo direttamente sulla pagina e' il proprio target
	solo := rect(t, s, "", "Solo")
	so, err := s.AnimateNode(ctx, odmcp.AnimateNodeInput{NodeId: solo, Prop: "x", To: ptr(100.0)})
	if err != nil || so.TargetId != solo {
		t.Fatalf("target di un nodo di pagina = %+v %v", so, err)
	}

	// set_clip: sostituzione per intero
	if _, err := s.SetClip(ctx, odmcp.SetClipInput{Id: created.ClipId, ClipBody: odmcp.ClipBody{TargetId: home, Duration: 100, Trigger: "tap"}}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetClip(ctx, odmcp.ClipIdInput{Id: created.ClipId})
	if got.Duration != 100 || got.Trigger != "tap" || len(got.TrackList) != 0 {
		t.Fatalf("dopo set_clip: %+v", got)
	}

	// delete_clip
	if _, err := s.DeleteClip(ctx, odmcp.ClipIdInput{Id: created.ClipId}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetClip(ctx, odmcp.ClipIdInput{Id: created.ClipId}); err == nil {
		t.Fatal("la clip cancellata e' ancora leggibile")
	}

	// cancellare un nodo ripulisce le tracce (cascata nel core): hov perde 'card'
	if _, err := s.DeleteNode(ctx, odmcp.NodeIdInput{Id: card}); err != nil {
		t.Fatal(err)
	}
	hc, _ = s.GetClip(ctx, odmcp.ClipIdInput{Id: hov.ClipId})
	if len(hc.TrackList) != 0 {
		t.Fatalf("tracce rimaste su un nodo cancellato: %+v", hc.TrackList)
	}
}

func TestAnimationToolValidation(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	home := frame(t, s, "Home")
	txt, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: home, Width: 50, Height: 20, Content: "x"})
	if err != nil {
		t.Fatal(err)
	}
	box := rect(t, s, home, "Box")
	good := func(mut func(b *odmcp.ClipBody)) odmcp.ClipBody {
		b := odmcp.ClipBody{TargetId: home, Duration: 500, Trigger: "hover", Tracks: []odmcp.TrackIO{
			{NodeId: box, Prop: "opacity", Keyframes: []odmcp.KeyframeIO{{Time: 0, Value: 0}, {Time: 500, Value: 1}}}}}
		mut(&b)
		return b
	}
	kf := func(ks ...odmcp.KeyframeIO) []odmcp.KeyframeIO { return ks }
	cases := []struct {
		name string
		body odmcp.ClipBody
		want string
	}{
		{"durata zero", good(func(b *odmcp.ClipBody) { b.Duration = 0 }), "duration"},
		{"trigger ignoto", good(func(b *odmcp.ClipBody) { b.Trigger = "scroll" }), "trigger"},
		{"target fantasma", good(func(b *odmcp.ClipBody) { b.TargetId = "zz" }), "list_nodes"},
		{"nodo fantasma", good(func(b *odmcp.ClipBody) { b.Tracks[0].NodeId = "zz" }), "list_nodes"},
		{"prop ignota", good(func(b *odmcp.ClipBody) { b.Tracks[0].Prop = "width" }), "prop"},
		{"niente keyframe", good(func(b *odmcp.ClipBody) { b.Tracks[0].Keyframes = nil }), "keyframe"},
		{"tempo fuori durata", good(func(b *odmcp.ClipBody) { b.Tracks[0].Keyframes = kf(odmcp.KeyframeIO{Time: 900}) }), "tempi"},
		{"opacity fuori range", good(func(b *odmcp.ClipBody) { b.Tracks[0].Keyframes = kf(odmcp.KeyframeIO{Value: 2}) }), "range"},
		{"easing spazzatura", good(func(b *odmcp.ClipBody) { b.Tracks[0].Keyframes[0].Easing = "bounce" }), "easing"},
		{"traccia duplicata", good(func(b *odmcp.ClipBody) { b.Tracks = append(b.Tracks, b.Tracks[0]) }), "una sola traccia"},
		{"draw su testo", good(func(b *odmcp.ClipBody) {
			b.Tracks = []odmcp.TrackIO{{NodeId: txt.NodeId, Prop: "draw", Keyframes: kf(odmcp.KeyframeIO{Value: 1})}}
		}), "draw"},
	}
	for _, c := range cases {
		_, err := s.CreateClip(ctx, c.body)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, vuoto o senza %q", c.name, err, c.want)
		}
	}
	if list, _ := s.ListClips(ctx, struct{}{}); len(list.Clips) != 0 {
		t.Fatalf("un create_clip rifiutato ha lasciato clip: %+v", list)
	}

	anim := []struct {
		name string
		in   odmcp.AnimateNodeInput
		want string
	}{
		{"nodo inesistente", odmcp.AnimateNodeInput{NodeId: "zz", Prop: "opacity", To: ptr(1.0)}, "non trovato"},
		{"prop ignota", odmcp.AnimateNodeInput{NodeId: box, Prop: "width", To: ptr(1.0)}, "prop"},
		{"to mancante", odmcp.AnimateNodeInput{NodeId: box, Prop: "x"}, "`to`"},
		{"trigger ignoto", odmcp.AnimateNodeInput{NodeId: box, Prop: "x", To: ptr(1.0), Trigger: "boh"}, "trigger"},
		{"easing ignoto", odmcp.AnimateNodeInput{NodeId: box, Prop: "x", To: ptr(1.0), Easing: "boh"}, "easing"},
		{"durata negativa", odmcp.AnimateNodeInput{NodeId: box, Prop: "x", To: ptr(1.0), Duration: -3}, "duration"},
		{"clip inesistente", odmcp.AnimateNodeInput{NodeId: box, Prop: "x", To: ptr(1.0), ClipId: "zz"}, "non trovata"},
		{"opacity > 1", odmcp.AnimateNodeInput{NodeId: box, Prop: "opacity", To: ptr(3.0)}, "range"},
		{"draw su testo", odmcp.AnimateNodeInput{NodeId: txt.NodeId, Prop: "draw"}, "draw"},
	}
	for _, c := range anim {
		_, err := s.AnimateNode(ctx, c.in)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("animate_node %s: err = %v, vuoto o senza %q", c.name, err, c.want)
		}
	}
	for name, call := range map[string]func() error{
		"get": func() error { _, err := s.GetClip(ctx, odmcp.ClipIdInput{Id: "zz"}); return err },
		"set": func() error {
			_, err := s.SetClip(ctx, odmcp.SetClipInput{Id: "zz", ClipBody: good(func(*odmcp.ClipBody) {})})
			return err
		},
		"delete": func() error { _, err := s.DeleteClip(ctx, odmcp.ClipIdInput{Id: "zz"}); return err },
	} {
		if err := call(); err == nil || !strings.Contains(err.Error(), "non trovata") {
			t.Errorf("%s clip sconosciuta: %v", name, err)
		}
	}
}
