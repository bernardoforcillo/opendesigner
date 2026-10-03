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

// ANIMAZIONE -- la metà Go (l'autorità) di web/src/store/applyOp.ts per i due op
// setClip / deleteClip.
//
// Una CLIP è un insieme di TRACCE (nodo, proprietà) con keyframe, appesa a un
// nodo "target" (schermata, gruppo, SVG) il cui hover/tap/enter la fa partire.
// I nodi animati sono referenziati per id, mai copiati. Le invarianti:
//
//	1. id non vuoto, durata finita > 0, ritardo finito >= 0, repeat >= -1,
//	   trigger nell'insieme noto (vuoto = "manual"), target ESISTENTE;
//	2. ogni traccia ha un nodo esistente, una proprietà della whitelist, almeno
//	   un keyframe con tempi finiti, non decrescenti e dentro [0, duration],
//	   valori finiti (opacity e draw in [0,1]) ed easing nella grammatica;
//	3. due tracce con la stessa coppia (nodo, proprietà) nella stessa clip sono
//	   un conflitto (quale vincerebbe?) e sono rifiutate;
//	4. `draw` ha senso solo dove c'è un tracciato: vector, rect, ellipse, frame;
//	5. cancellare un nodo (o una pagina) toglie le tracce che lo animavano e
//	   cancella le clip il cui target è sparito. Una clip rimasta SENZA tracce
//	   ma con il target vivo si tiene: è una clip vuota, non un orfano.
//
// Gli upsert sono ASSOLUTI: l'inverso di un op è lo stato precedente (vedi
// web/src/store/history.ts). La mappa `Clips` può essere nil e si inizializza
// alla prima scrittura.

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

// ClipTriggers e TrackProps sono gli insiemi chiusi del modello; il TS mirror
// (web/src/animation/engine.ts) e il generatore di codice li ripetono.
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

// easingNum è un numero decimale ristretto (niente inf/nan/esadecimali che
// strconv accetterebbe): la stessa regex vive in web/src/animation/engine.ts.
const easingNum = `[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`

var cubicBezierRe = regexp.MustCompile(`^cubic-bezier\(\s*(` + easingNum + `)\s*,\s*(` + easingNum + `)\s*,\s*(` + easingNum + `)\s*,\s*(` + easingNum + `)\s*\)$`)

// ParseCubicBezier estrae i quattro punti di controllo da "cubic-bezier(a,b,c,d)".
// Come in CSS le ascisse (a, c) devono stare in [0,1]: fuori sarebbe una curva
// non funzione del tempo (e una dichiarazione CSS invalida nell'export html).
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

// ValidEasing dice se la stringa sta nella grammatica degli easing.
func ValidEasing(s string) bool {
	switch s {
	case "", "linear", "easeIn", "easeOut", "easeInOut", "spring":
		return true
	}
	_, ok := ParseCubicBezier(s)
	return ok
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// canDraw: i tipi di nodo che hanno un contorno su cui "disegnare" il tratto.
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

// ValidateClip dice se un SetClip con questa clip sarebbe accettato dal
// documento, senza applicarlo: i chiamanti che vogliono un errore chiaro PRIMA
// di spedire l'op (i tool MCP) usano la stessa logica dell'autorità.
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

// cascadeClips toglie dalle clip ciò che animava i nodi appena cancellati. Le
// voci modificate sono SOSTITUITE da copie, mai mutate in place (come
// cascadeFlows): con il clone copy-on-write del server l'oggetto potrebbe
// essere condiviso con la generazione precedente.
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
