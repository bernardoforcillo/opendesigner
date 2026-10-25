// Package figimport reads a Figma .fig file and turns it into nodes of this editor.
//
// EXPERIMENTAL, and honest about what it is: .fig is not a public format. This reader follows the
// layout that open-source tools have documented (a zip with canvas.fig, or the bare canvas; "fig-kiwi"
// chunks of deflate or zstd data; a Kiwi schema inside; a Message of NodeChange records) and was
// tested against files built to that layout, not against files exported by every version of
// Figma. What it cannot place it reports as a warning instead of guessing; a file it cannot read at
// all is an error.
//
// It maps pages, frames (with auto layout), groups, rectangles, ellipses, text, vector paths,
// fills (solid, linear and radial gradient, image), strokes, shadows and blurs, masks and
// constraints, and variable collections with their modes, variables (color, number, string, boolean,
// aliases) and the bindings of layers to them. Components and instances are NOT carried over as such:
// an instance becomes a plain frame.
package figimport

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Limits: a hostile file must not make the server allocate without bound.
const (
	maxFile      = 256 << 20
	maxInflated  = 512 << 20
	maxNodes     = 200000
	maxTextRunes = 100000
)

// Options of an import.
type Options struct {
	// Name of the wrapper group (the file name, usually).
	Name string
	// PutAsset stores image bytes and returns the asset hash (sha256 hex). Nil: images become a flat grey.
	PutAsset func(data []byte) (string, error)
}

// Result is what the import produced.
type Result struct {
	// Nodes: the wrapper group first, then every node after its own parent.
	Nodes         []*opendesignerv1.Node
	Width, Height float64
	Warnings      []string
	// Imported counts the layers that came in, by Figma kind ("FRAME": 12); Skipped counts the kinds
	// left out. Together they are the import report's numbers.
	Imported map[string]int
	Skipped  map[string]int
	// Collections and Variables are the file's variables with their modes; the nodes' Bindings and Modes
	// name them. Variables come with the targets of aliases first, so the editor can create them in order.
	Collections []*opendesignerv1.VariableCollection
	Variables   []*opendesignerv1.Variable
}

// Import reads a .fig file (a zip, or the bare canvas.fig).
func Import(data []byte, opt Options) (*Result, error) {
	if len(data) > maxFile {
		return nil, errors.New("figimport: the file is too large")
	}
	canvas, images, err := open(data)
	if err != nil {
		return nil, err
	}
	msg, err := decodeCanvas(canvas)
	if err != nil {
		return nil, err
	}
	return convert(msg, images, opt)
}

// open finds the canvas (and the images) in a zip, or takes the bare canvas.
func open(data []byte) (canvas []byte, images map[string][]byte, err error) {
	images = map[string][]byte{}
	if len(data) >= 2 && data[0] == 'P' && data[1] == 'K' {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, nil, fmt.Errorf("figimport: not a readable zip: %w", err)
		}
		var total int64
		for _, f := range zr.File {
			name := path.Clean(f.Name)
			isCanvas := name == "canvas.fig"
			isImage := strings.HasPrefix(name, "images/") && !f.FileInfo().IsDir()
			if !isCanvas && !isImage {
				continue
			}
			if f.UncompressedSize64 > maxInflated {
				return nil, nil, errors.New("figimport: a file inside is too large")
			}
			rc, err := f.Open()
			if err != nil {
				return nil, nil, err
			}
			b, err := io.ReadAll(io.LimitReader(rc, maxInflated+1))
			rc.Close()
			if err != nil {
				return nil, nil, err
			}
			total += int64(len(b))
			if total > maxInflated {
				return nil, nil, errors.New("figimport: the file expands too much")
			}
			if isCanvas {
				canvas = b
			} else {
				images[strings.ToLower(path.Base(name))] = b
			}
		}
		if canvas == nil {
			return nil, nil, errors.New("figimport: no canvas.fig inside (is this a .fig file?)")
		}
		return canvas, images, nil
	}
	return data, images, nil
}

// decodeCanvas reads the container: "fig-kiwi", a version, then length-prefixed chunks. The first
// holds the schema, the second the message.
func decodeCanvas(canvas []byte) (map[string]any, error) {
	if len(canvas) < 12 || !bytes.HasPrefix(canvas, []byte("fig-")) {
		return nil, errors.New("figimport: this is not a Figma canvas (no fig-kiwi header)")
	}
	pos := 12 // 8 bytes of magic, 4 of version
	var chunks [][]byte
	for pos+4 <= len(canvas) {
		n := int(binary.LittleEndian.Uint32(canvas[pos:]))
		pos += 4
		if n < 0 || pos+n > len(canvas) {
			return nil, errors.New("figimport: a chunk runs past the end of the file")
		}
		chunks = append(chunks, canvas[pos:pos+n])
		pos += n
	}
	if len(chunks) < 2 {
		return nil, errors.New("figimport: the canvas has no schema or no data")
	}
	schemaBytes, err := inflate(chunks[0])
	if err != nil {
		return nil, fmt.Errorf("figimport: the schema: %w", err)
	}
	dataBytes, err := inflate(chunks[1])
	if err != nil {
		return nil, fmt.Errorf("figimport: the data: %w", err)
	}
	s, err := decodeSchema(schemaBytes)
	if err != nil {
		return nil, err
	}
	if _, ok := s.defs["Message"]; !ok {
		return nil, errors.New("figimport: the schema has no Message type")
	}
	v, err := s.decode(&reader{data: dataBytes}, "Message", 0)
	if err != nil {
		return nil, err
	}
	m, _ := v.(map[string]any)
	if m == nil {
		return nil, errors.New("figimport: the message is empty")
	}
	return m, nil
}

// inflate decompresses a chunk: zstd when it says so, raw deflate otherwise.
func inflate(b []byte) ([]byte, error) {
	if len(b) >= 4 && b[0] == 0x28 && b[1] == 0xb5 && b[2] == 0x2f && b[3] == 0xfd {
		dec, err := zstd.NewReader(nil, zstd.WithDecoderMaxMemory(maxInflated))
		if err != nil {
			return nil, err
		}
		defer dec.Close()
		return dec.DecodeAll(b, nil)
	}
	out, err := io.ReadAll(io.LimitReader(flate.NewReader(bytes.NewReader(b)), maxInflated+1))
	if err != nil {
		return nil, err
	}
	if len(out) > maxInflated {
		return nil, errors.New("the data expands too much")
	}
	return out, nil
}

// ---- reading the decoded values ----

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asList(v any) []any         { l, _ := v.([]any); return l }
func asStr(v any) string         { s, _ := v.(string); return s }

func num(m map[string]any, key string, def float64) float64 {
	if f, ok := m[key].(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
		return f
	}
	return def
}

func boolOf(m map[string]any, key string, def bool) bool {
	if b, ok := m[key].(bool); ok {
		return b
	}
	return def
}

func guidKey(v any) string {
	g := asMap(v)
	if g == nil {
		return ""
	}
	return strconv.FormatFloat(num(g, "sessionID", 0), 'f', -1, 64) + ":" + strconv.FormatFloat(num(g, "localID", 0), 'f', -1, 64)
}

type fnode struct {
	raw      map[string]any
	key      string
	position string
	children []*fnode
}

// convert builds our nodes from the decoded message.
func convert(msg map[string]any, images map[string][]byte, opt Options) (*Result, error) {
	changes := asList(msg["nodeChanges"])
	if len(changes) == 0 {
		return nil, errors.New("figimport: the file has no nodes")
	}
	if len(changes) > maxNodes {
		return nil, errors.New("figimport: the file has too many nodes")
	}
	byKey := map[string]*fnode{}
	var all []*fnode
	for _, c := range changes {
		m := asMap(c)
		if m == nil {
			continue
		}
		n := &fnode{raw: m, key: guidKey(m["guid"])}
		if n.key == "" {
			continue
		}
		byKey[n.key] = n
		all = append(all, n)
	}
	var doc *fnode
	for _, n := range all {
		pi := asMap(n.raw["parentIndex"])
		if pi == nil {
			if asStr(n.raw["type"]) == "DOCUMENT" {
				doc = n
			}
			continue
		}
		if p := byKey[guidKey(pi["guid"])]; p != nil {
			n.position = asStr(pi["position"])
			p.children = append(p.children, n)
		}
	}
	if doc == nil {
		return nil, errors.New("figimport: the file has no document node")
	}
	for _, n := range all {
		sort.SliceStable(n.children, func(i, j int) bool { return n.children[i].position < n.children[j].position })
	}

	var blobs [][]byte
	for _, b := range asList(msg["blobs"]) {
		if bs, ok := asMap(b)["bytes"].([]byte); ok {
			blobs = append(blobs, bs)
		} else {
			blobs = append(blobs, nil)
		}
	}
	c := &converter{opt: opt, images: images, blobs: blobs, counters: map[string]int{}, seenAssets: map[string]string{}, skipped: map[string]int{}, imported: map[string]int{}}
	c.byKey = byKey
	c.readVariables(all)

	name := strings.TrimSpace(opt.Name)
	if name == "" {
		name = "Figma import"
	}
	root := c.newNode("", name, &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}})
	var pageY, maxW float64
	pages := 0
	for _, p := range doc.children {
		if asStr(p.raw["type"]) != "CANVAS" || boolOf(p.raw, "internalOnly", false) {
			continue
		}
		pg := c.newNode(root.Id, asStr(p.raw["name"]), &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}})
		if pg.Name == "" {
			pg.Name = "Page"
		}
		first := len(c.nodes)
		for _, ch := range p.children {
			c.convertNode(ch, pg.Id)
		}
		// The page's box is what its top-level children cover; they are re-expressed from its origin.
		minX, minY, maxX, maxY, any := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1), false
		var tops []*opendesignerv1.Node
		for _, n := range c.nodes[first:] {
			if n.ParentId == pg.Id {
				tops = append(tops, n)
				minX, minY = math.Min(minX, n.X), math.Min(minY, n.Y)
				maxX, maxY = math.Max(maxX, n.X+n.Width), math.Max(maxY, n.Y+n.Height)
				any = true
			}
		}
		if !any {
			continue
		}
		for _, n := range tops {
			n.X -= minX
			n.Y -= minY
		}
		pg.X, pg.Y, pg.Width, pg.Height = 0, pageY, maxX-minX, maxY-minY
		maxW = math.Max(maxW, pg.Width)
		pageY += pg.Height + 200
		pages++
	}
	if pages == 0 {
		return nil, errors.New("figimport: the file has no page with content")
	}
	root.X, root.Y, root.Width, root.Height = 0, 0, maxW, pageY-200
	nodes := append([]*opendesignerv1.Node{root}, c.nodes...)
	// Drop empty page groups (nothing converted) so the tree has no hollow shells.
	nodes = pruneEmpty(nodes)
	res := &Result{Nodes: nodes, Width: root.Width, Height: root.Height, Warnings: c.warnings, Imported: c.imported, Skipped: c.skipped}
	res.Collections, res.Variables = c.vt.output()
	res.Warnings = append(res.Warnings, c.vt.warnings()...)
	for t, n := range c.skipped {
		res.Warnings = append(res.Warnings, fmt.Sprintf("%d %s layers were not imported (that kind is not supported)", n, strings.ToLower(strings.ReplaceAll(t, "_", " "))))
	}
	sort.Strings(res.Warnings)
	return res, nil
}

func pruneEmpty(nodes []*opendesignerv1.Node) []*opendesignerv1.Node {
	has := map[string]bool{}
	for _, n := range nodes {
		has[n.ParentId] = true
	}
	out := nodes[:0]
	for i, n := range nodes {
		if i > 0 && n.GetGroup() != nil && !has[n.Id] && n.Width == 0 && n.Height == 0 {
			continue
		}
		out = append(out, n)
	}
	return out
}

type converter struct {
	opt        Options
	images     map[string][]byte
	blobs      [][]byte
	nodes      []*opendesignerv1.Node
	counters   map[string]int
	warnings   []string
	skipped    map[string]int
	imported   map[string]int
	byKey      map[string]*fnode // every node of the file by guid
	vt         varTable          // the file's variable collections and variables (variables.go)
	seenAssets map[string]string
	instances  int
}

func (c *converter) warn(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	for _, w := range c.warnings {
		if w == msg {
			return
		}
	}
	if len(c.warnings) < 50 {
		c.warnings = append(c.warnings, msg)
	}
}

// newNode makes a node under `parent` (it is appended by convertNode / the caller for the wrapper).
func (c *converter) newNode(parent, name string, shape any) *opendesignerv1.Node {
	c.counters[parent]++
	n := &opendesignerv1.Node{
		Id: uuid.NewString(), ParentId: parent, OrderKey: fmt.Sprintf("%06d", c.counters[parent]),
		Name: name, Visible: true, Opacity: 1,
	}
	switch s := shape.(type) {
	case *opendesignerv1.Node_Group:
		n.Shape = s
	case *opendesignerv1.Node_Frame:
		n.Shape = s
	case *opendesignerv1.Node_Rect:
		n.Shape = s
	case *opendesignerv1.Node_Ellipse:
		n.Shape = s
	case *opendesignerv1.Node_Polygon:
		n.Shape = s
	case *opendesignerv1.Node_Star:
		n.Shape = s
	case *opendesignerv1.Node_Text:
		n.Shape = s
	case *opendesignerv1.Node_Vector:
		n.Shape = s
	}
	if parent != "" || len(c.nodes) > 0 {
		c.nodes = append(c.nodes, n)
	}
	return n
}

// ellipseNode reads an ellipse's arc: Figma's arcData holds the start and end angles (radians, clockwise from
// +x) and the ring's inner radius as a fraction.
func ellipseNode(raw map[string]any) *opendesignerv1.EllipseNode {
	e := &opendesignerv1.EllipseNode{}
	arc := asMap(raw["arcData"])
	if arc == nil {
		return e
	}
	start, end := num(arc, "startingAngle", 0), num(arc, "endingAngle", 2*math.Pi)
	sweep := end - start
	if sweep < 0 {
		sweep += 2 * math.Pi
	}
	if sweep < 2*math.Pi-1e-3 {
		e.ArcStart = round2(start * 180 / math.Pi)
		e.ArcSweep = round2(sweep * 180 / math.Pi)
	}
	if r := num(arc, "innerRadius", 0); r > 0 && r < 1 {
		e.InnerRatio = math.Min(0.99, r)
	}
	return e
}

// polygonOrStar: a REGULAR_POLYGON or STAR with a readable count (3..60); nil otherwise.
func polygonOrStar(raw map[string]any, typ string) any {
	count := int(num(raw, "count", 0))
	if count < 3 || count > 60 {
		return nil
	}
	if typ == "REGULAR_POLYGON" {
		return &opendesignerv1.Node_Polygon{Polygon: &opendesignerv1.PolygonNode{Sides: uint32(count)}}
	}
	ratio := num(raw, "starInnerScale", 0.382)
	return &opendesignerv1.Node_Star{Star: &opendesignerv1.StarNode{Points: uint32(count), InnerRatio: math.Min(0.95, math.Max(0.05, ratio))}}
}

// convertNode converts one Figma node (and its children) under `parent`.
func (c *converter) convertNode(f *fnode, parent string) {
	if len(c.nodes) > maxNodes {
		return
	}
	typ := asStr(f.raw["type"])
	name := asStr(f.raw["name"])
	size := asMap(f.raw["size"])
	w, h := num(size, "x", 0), num(size, "y", 0)

	var shape any
	var ends *connEnds
	switch typ {
	case "FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "SYMBOL", "INSTANCE":
		if typ == "INSTANCE" {
			c.instances++
			c.warn("instances were imported as plain frames (%d so far): their component link is not kept", c.instances)
		}
		shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: !boolOf(f.raw, "frameMaskDisabled", false), AutoLayout: autoLayout(f.raw)}}
	case "GROUP":
		shape = &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}}
	case "RECTANGLE", "ROUNDED_RECTANGLE":
		shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: cornerRadius(f.raw)}}
	case "ELLIPSE":
		shape = &opendesignerv1.Node_Ellipse{Ellipse: ellipseNode(f.raw)}
	case "STAR", "REGULAR_POLYGON":
		// Figma keeps the point / side count and the star's inner scale: the shape stays editable instead of
		// becoming a path. A node without a readable count falls through to its geometry below.
		if sh := polygonOrStar(f.raw, typ); sh != nil {
			shape = sh
			break
		}
		fallthrough
	case "TEXT":
		shape = &opendesignerv1.Node_Text{Text: c.text(f.raw, w)}
	case "VECTOR", "LINE", "BOOLEAN_OPERATION":
		if v := c.vector(f.raw, typ, w, h); v != nil {
			shape = &opendesignerv1.Node_Vector{Vector: v}
		} else {
			c.warn("%q (%s) has no readable path and was imported as a rectangle", name, strings.ToLower(typ))
			shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}
		}
	case "CONNECTOR":
		ends = c.connectorEnds(f)
		if ends != nil && len(c.geometry(c.savedPaths(f.raw))) == 0 {
			// The ends decide the line, so they decide the box: the saved size and place of a connector
			// are not trusted over them (FigCraft's reader does the same).
			w, h = ends.w, ends.h
		} else {
			ends = nil
		}
		shape = c.connector(f.raw, w, h, ends)
	case "TABLE", "TABLE_CELL", "SLIDE", "SLIDE_ROW", "SLIDE_GRID", "STICKY", "SHAPE_WITH_TEXT", "CODE_BLOCK":
		// Layers with no counterpart come in as the closest frame; the text they carry becomes a text layer.
		c.warn("%s layers were imported as frames (their special behaviour is not kept)", strings.ToLower(strings.ReplaceAll(typ, "_", " ")))
		shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: typ == "SLIDE", AutoLayout: autoLayout(f.raw)}}
	default:
		c.skipped[typ]++
		return
	}
	c.imported[typ]++
	n := c.newNode(parent, name, shape)
	if n.Name == "" {
		n.Name = strings.ToLower(typ)
	}
	n.Visible = boolOf(f.raw, "visible", true)
	n.Opacity = clamp01(num(f.raw, "opacity", 1))
	n.Width, n.Height = w, h
	tr := asMap(f.raw["transform"])
	m00, m01, m02 := num(tr, "m00", 1), num(tr, "m01", 0), num(tr, "m02", 0)
	m10, m11, m12 := num(tr, "m10", 0), num(tr, "m11", 1), num(tr, "m12", 0)
	// Our box turns around its own center: the center of the transformed box is the anchor.
	cx, cy := m00*w/2+m01*h/2+m02, m10*w/2+m11*h/2+m12
	n.X, n.Y = round2(cx-w/2), round2(cy-h/2)
	n.Rotation = round2(math.Atan2(m10, m00) * 180 / math.Pi)
	if math.Abs(n.Rotation) < 0.005 {
		n.Rotation = 0
	}
	if ends != nil {
		n.X, n.Y, n.Rotation = round2(ends.x), round2(ends.y), 0
	}
	n.IsMask = boolOf(f.raw, "mask", false)
	n.ConstraintX = constraint(asStr(f.raw["horizontalConstraint"]))
	n.ConstraintY = constraint(asStr(f.raw["verticalConstraint"]))
	n.BlendMode = blend(asStr(f.raw["blendMode"]))
	var fillSrc, strokeSrc []int
	n.Fills, fillSrc = c.paintsWithSrc(f.raw["fillPaints"], typ == "LINE")
	n.Strokes, strokeSrc = c.strokesWithSrc(f.raw)
	n.Effects = effects(f.raw["effects"])
	if typ == "CONNECTOR" {
		fillSrc = c.connectorPaint(n, f.raw)
	}
	c.bindLayer(n, f.raw, fillSrc, strokeSrc)
	if isLabelled(typ) {
		c.label(n, f)
	}
	if typ == "FRAME" || typ == "GROUP" || typ == "SECTION" || isLabelled(typ) || typ == "COMPONENT" || typ == "COMPONENT_SET" || typ == "SYMBOL" || typ == "INSTANCE" || typ == "BOOLEAN_OPERATION" {
		for _, ch := range f.children {
			if typ == "BOOLEAN_OPERATION" {
				break // the result is already in its own geometry
			}
			c.convertNode(ch, n.Id)
		}
	}
	// A frame with auto layout has the layout decide positions; keep Figma's stored ones as they are.
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func clamp01(v float64) float64 { return math.Min(1, math.Max(0, v)) }

func cornerRadius(m map[string]any) float64 {
	if r := num(m, "cornerRadius", 0); r > 0 {
		return r
	}
	return math.Max(num(m, "rectangleTopLeftCornerRadius", 0), 0)
}

func constraint(s string) opendesignerv1.Constraint {
	switch s {
	case "MIN":
		return opendesignerv1.Constraint_CONSTRAINT_MIN
	case "MAX":
		return opendesignerv1.Constraint_CONSTRAINT_MAX
	case "STRETCH":
		return opendesignerv1.Constraint_CONSTRAINT_STRETCH
	case "CENTER":
		return opendesignerv1.Constraint_CONSTRAINT_CENTER
	case "SCALE":
		return opendesignerv1.Constraint_CONSTRAINT_SCALE
	}
	return opendesignerv1.Constraint_CONSTRAINT_UNSPECIFIED
}

func blend(s string) opendesignerv1.BlendMode {
	if v, ok := opendesignerv1.BlendMode_value["BLEND_MODE_"+strings.ReplaceAll(s, "-", "_")]; ok && s != "" && s != "PASS_THROUGH" {
		return opendesignerv1.BlendMode(v)
	}
	return opendesignerv1.BlendMode_BLEND_MODE_UNSPECIFIED
}

func autoLayout(m map[string]any) *opendesignerv1.AutoLayout {
	mode := asStr(m["stackMode"])
	if mode != "HORIZONTAL" && mode != "VERTICAL" {
		return nil
	}
	al := &opendesignerv1.AutoLayout{
		Direction:     opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL,
		Spacing:       math.Max(0, num(m, "stackSpacing", 0)),
		PaddingLeft:   math.Max(0, num(m, "stackPaddingLeft", num(m, "stackHorizontalPadding", 0))),
		PaddingRight:  math.Max(0, num(m, "stackPaddingRight", num(m, "stackHorizontalPadding", 0))),
		PaddingTop:    math.Max(0, num(m, "stackPaddingTop", num(m, "stackVerticalPadding", 0))),
		PaddingBottom: math.Max(0, num(m, "stackPaddingBottom", num(m, "stackVerticalPadding", 0))),
		MainAlign:     align(asStr(m["stackPrimaryAlignItems"]), true),
		CrossAlign:    align(asStr(m["stackCounterAlignItems"]), false),
		Wrap:          asStr(m["stackWrap"]) == "WRAP",
	}
	if mode == "VERTICAL" {
		al.Direction = opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL
	}
	hugMain := asStr(m["stackPrimarySizing"]) == "RESIZE_TO_FIT" || asStr(m["stackPrimarySizing"]) == "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE"
	hugCross := asStr(m["stackCounterSizing"]) == "RESIZE_TO_FIT" || asStr(m["stackCounterSizing"]) == "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE"
	if mode == "HORIZONTAL" {
		al.HugWidth, al.HugHeight = hugMain, hugCross
	} else {
		al.HugWidth, al.HugHeight = hugCross, hugMain
	}
	return al
}

func align(s string, main bool) opendesignerv1.LayoutAlign {
	switch s {
	case "CENTER":
		return opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER
	case "MAX":
		return opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END
	case "SPACE_BETWEEN":
		if main {
			return opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN
		}
	}
	return opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START
}

// ---- text ----

func (c *converter) text(m map[string]any, width float64) *opendesignerv1.TextNode {
	td := asMap(m["textData"])
	content := asStr(td["characters"])
	if content == "" {
		content = asStr(m["characters"])
	}
	if r := []rune(content); len(r) > maxTextRunes {
		content = string(r[:maxTextRunes])
	}
	fn := asMap(m["fontName"])
	style := strings.ToLower(asStr(fn["style"]))
	weight := "400"
	for k, v := range map[string]string{"thin": "100", "extralight": "200", "extra light": "200", "light": "300", "medium": "500", "semibold": "600", "semi bold": "600", "extrabold": "800", "extra bold": "800", "bold": "700", "black": "900", "heavy": "900"} {
		if strings.Contains(style, k) {
			weight = v
			if k != "bold" || !strings.Contains(style, "semi") {
				break
			}
		}
	}
	size := num(m, "fontSize", 16)
	ts := &opendesignerv1.TextStyle{FontFamily: asStr(fn["family"]), FontSize: size, FontWeight: weight, Italic: strings.Contains(style, "italic")}
	if lh := asMap(m["lineHeight"]); lh != nil {
		v := num(lh, "value", 0)
		switch asStr(lh["units"]) {
		case "PERCENT":
			ts.LineHeight = v / 100
		case "PIXELS":
			if size > 0 {
				ts.LineHeight = v / size
			}
		case "RAW":
			ts.LineHeight = v
		}
	}
	switch asStr(m["textAlignHorizontal"]) {
	case "CENTER":
		ts.Align = opendesignerv1.TextAlign_TEXT_ALIGN_CENTER
	case "RIGHT":
		ts.Align = opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT
	default:
		ts.Align = opendesignerv1.TextAlign_TEXT_ALIGN_LEFT
	}
	return &opendesignerv1.TextNode{Content: content, Style: ts}
}

// ---- paints ----

func color(m map[string]any, opacity float64) *opendesignerv1.Color {
	return &opendesignerv1.Color{R: float32(clamp01(num(m, "r", 0))), G: float32(clamp01(num(m, "g", 0))), B: float32(clamp01(num(m, "b", 0))), A: float32(clamp01(num(m, "a", 1) * opacity))}
}

func (c *converter) paints(v any, isLine bool) []*opendesignerv1.Paint {
	out, _ := c.paintsWithSrc(v, isLine)
	return out
}

// paintsWithSrc is paints plus, for each paint kept, the index it had in the file's list. Hidden and
// unsupported paints drop out, so the two indexes differ and a variable binding has to translate.
func (c *converter) paintsWithSrc(v any, isLine bool) ([]*opendesignerv1.Paint, []int) {
	var out []*opendesignerv1.Paint
	var src []int
	for i, p := range asList(v) {
		pm := asMap(p)
		if pm == nil || !boolOf(pm, "visible", true) {
			continue
		}
		kept := len(out)
		op := clamp01(num(pm, "opacity", 1))
		switch t := asStr(pm["type"]); t {
		case "SOLID":
			out = append(out, &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: color(asMap(pm["color"]), op)}}})
		case "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND":
			if g := gradient(pm, op, t); g != nil {
				if t == "GRADIENT_LINEAR" {
					out = append(out, &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Linear{Linear: g}})
				} else if t == "GRADIENT_ANGULAR" {
					out = append(out, &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Angular{Angular: g}})
				} else if t == "GRADIENT_DIAMOND" {
					out = append(out, &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Diamond{Diamond: g}})
				} else {
					out = append(out, &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Radial{Radial: g}})
				}
			}
		case "IMAGE":
			if p := c.imagePaint(pm); p != nil {
				out = append(out, p)
			}
		default:
			c.warn("a %s fill was left out (not supported)", strings.ToLower(t))
		}
		if len(out) > kept {
			src = append(src, i)
		}
	}
	return out, src
}

func gradient(pm map[string]any, opacity float64, typ string) *opendesignerv1.GradientPaint {
	var stops []*opendesignerv1.GradientStop
	for _, s := range asList(pm["stops"]) {
		sm := asMap(s)
		stops = append(stops, &opendesignerv1.GradientStop{Color: color(asMap(sm["color"]), opacity), Position: clamp01(num(sm, "position", 0))})
	}
	if len(stops) < 2 {
		return nil
	}
	// The paint's transform maps the node's unit square to gradient space, where a linear gradient runs
	// from (0, .5) to (1, .5) and a radial one is centered at (.5, .5) with its radius point at (1, .5).
	t := asMap(pm["transform"])
	a, b, tx := num(t, "m00", 1), num(t, "m01", 0), num(t, "m02", 0)
	cc, d, ty := num(t, "m10", 0), num(t, "m11", 1), num(t, "m12", 0)
	det := a*d - b*cc
	inv := func(x, y float64) (float64, float64) {
		if det == 0 {
			return x, y
		}
		x, y = x-tx, y-ty
		return (d*x - b*y) / det, (-cc*x + a*y) / det
	}
	g := &opendesignerv1.GradientPaint{Stops: stops}
	if typ == "GRADIENT_LINEAR" {
		g.X1, g.Y1 = inv(0, 0.5)
		g.X2, g.Y2 = inv(1, 0.5)
	} else {
		g.X1, g.Y1 = inv(0.5, 0.5)
		g.X2, g.Y2 = inv(1, 0.5)
	}
	return g
}

func (c *converter) imagePaint(pm map[string]any) *opendesignerv1.Paint {
	grey := &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 0.8, G: 0.8, B: 0.8, A: 1}}}}
	img := asMap(pm["image"])
	hb, _ := img["hash"].([]byte)
	if len(hb) == 0 || c.opt.PutAsset == nil {
		c.warn("an image fill could not be imported and is a grey fill")
		return grey
	}
	hexName := hex.EncodeToString(hb)
	hash, ok := c.seenAssets[hexName]
	if !ok {
		data := c.images[hexName]
		if data == nil {
			c.warn("an image file is missing from the .fig and its fill is grey")
			return grey
		}
		var err error
		hash, err = c.opt.PutAsset(data)
		if err != nil {
			c.warn("an image could not be stored (%v) and its fill is grey", err)
			return grey
		}
		c.seenAssets[hexName] = hash
	}
	mode := opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_UNSPECIFIED
	switch asStr(pm["imageScaleMode"]) {
	case "FIT":
		mode = opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_FIT
	case "TILE":
		mode = opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_TILE
	}
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Image{Image: &opendesignerv1.ImagePaint{AssetHash: hash, Mode: mode}}}
}

func (c *converter) strokes(m map[string]any) []*opendesignerv1.Stroke {
	out, _ := c.strokesWithSrc(m)
	return out
}

// strokesWithSrc is strokes plus the index each stroke's paint had in strokePaints.
func (c *converter) strokesWithSrc(m map[string]any) ([]*opendesignerv1.Stroke, []int) {
	weight := num(m, "strokeWeight", 0)
	if weight <= 0 {
		return nil, nil
	}
	al := opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER
	switch asStr(m["strokeAlign"]) {
	case "INSIDE":
		al = opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE
	case "OUTSIDE":
		al = opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE
	}
	var out []*opendesignerv1.Stroke
	ps, src := c.paintsWithSrc(m["strokePaints"], false)
	for _, p := range ps {
		out = append(out, &opendesignerv1.Stroke{Paint: p, Weight: weight, Align: al})
	}
	return out, src
}

func effects(v any) []*opendesignerv1.Effect {
	var out []*opendesignerv1.Effect
	for _, e := range asList(v) {
		em := asMap(e)
		if em == nil || !boolOf(em, "visible", true) {
			continue
		}
		off := asMap(em["offset"])
		col := color(asMap(em["color"]), 1)
		switch asStr(em["type"]) {
		case "DROP_SHADOW":
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_DropShadow{DropShadow: &opendesignerv1.DropShadow{Color: col, OffsetX: num(off, "x", 0), OffsetY: num(off, "y", 0), Blur: math.Max(0, num(em, "radius", 0))}}})
		case "INNER_SHADOW":
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_InnerShadow{InnerShadow: &opendesignerv1.InnerShadow{Color: col, OffsetX: num(off, "x", 0), OffsetY: num(off, "y", 0), Blur: math.Max(0, num(em, "radius", 0))}}})
		case "FOREGROUND_BLUR":
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: math.Max(0, num(em, "radius", 0))}}})
		case "BACKGROUND_BLUR":
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_BackgroundBlur{BackgroundBlur: &opendesignerv1.BackgroundBlur{Radius: math.Max(0, num(em, "radius", 0))}}})
		}
	}
	return out
}

// ---- vector paths ----

// vector reads the node's fill geometry (path commands stored as blobs). nil when there is none or
// it does not make sense: the caller then falls back to a rectangle and says so.
func (c *converter) vector(m map[string]any, typ string, w, h float64) *opendesignerv1.VectorNode {
	if typ == "LINE" {
		return &opendesignerv1.VectorNode{Subpaths: []*opendesignerv1.SubPath{{Anchors: []*opendesignerv1.Anchor{{X: 0, Y: 0}, {X: w, Y: 0}}}}}
	}
	var subs []*opendesignerv1.SubPath
	for _, g := range asList(m["fillGeometry"]) {
		gm := asMap(g)
		idx := int(num(gm, "commandsBlob", -1))
		if idx < 0 || idx >= len(c.blobs) || c.blobs[idx] == nil {
			continue
		}
		s, ok := pathCommands(c.blobs[idx])
		if !ok {
			return nil
		}
		subs = append(subs, s...)
	}
	if len(subs) == 0 {
		return nil
	}
	// A path that strays far outside its own box is a sign the commands were misread.
	for _, sp := range subs {
		for _, a := range sp.Anchors {
			if math.Abs(a.X) > 1e6 || math.Abs(a.Y) > 1e6 || math.IsNaN(a.X) || math.IsNaN(a.Y) {
				return nil
			}
		}
	}
	return &opendesignerv1.VectorNode{Subpaths: subs}
}

// pathCommands decodes a commands blob: 0 closes, 1 moves, 2 draws a line, 3 a quadratic and 4 a
// cubic curve; coordinates are little-endian float32 in the node's own space.
func pathCommands(b []byte) ([]*opendesignerv1.SubPath, bool) {
	var subs []*opendesignerv1.SubPath
	var cur *opendesignerv1.SubPath
	f := func(i int) float64 { return float64(math.Float32frombits(binary.LittleEndian.Uint32(b[i:]))) }
	i := 0
	need := func(n int) bool { return i+n*4 <= len(b) }
	last := func() *opendesignerv1.Anchor {
		if cur == nil || len(cur.Anchors) == 0 {
			return nil
		}
		return cur.Anchors[len(cur.Anchors)-1]
	}
	for i < len(b) {
		cmd := b[i]
		i++
		switch cmd {
		case 0:
			if cur != nil {
				cur.Closed = true
				// A closing line back to the start duplicates the first anchor: drop it.
				if n := len(cur.Anchors); n > 1 && cur.Anchors[n-1].X == cur.Anchors[0].X && cur.Anchors[n-1].Y == cur.Anchors[0].Y {
					first := cur.Anchors[0]
					first.InX, first.InY = cur.Anchors[n-1].InX, cur.Anchors[n-1].InY
					cur.Anchors = cur.Anchors[:n-1]
				}
				subs = append(subs, cur)
				cur = nil
			}
		case 1:
			if !need(2) {
				return nil, false
			}
			if cur != nil {
				subs = append(subs, cur)
			}
			cur = &opendesignerv1.SubPath{Anchors: []*opendesignerv1.Anchor{{X: f(i), Y: f(i + 4)}}}
			i += 8
		case 2:
			if !need(2) || cur == nil {
				return nil, false
			}
			cur.Anchors = append(cur.Anchors, &opendesignerv1.Anchor{X: f(i), Y: f(i + 4)})
			i += 8
		case 3: // quadratic -> cubic
			if !need(4) || last() == nil {
				return nil, false
			}
			p0 := last()
			qx, qy, x, y := f(i), f(i+4), f(i+8), f(i+12)
			i += 16
			p0.OutX, p0.OutY = (2.0/3)*(qx-p0.X), (2.0/3)*(qy-p0.Y)
			cur.Anchors = append(cur.Anchors, &opendesignerv1.Anchor{X: x, Y: y, InX: (2.0 / 3) * (qx - x), InY: (2.0 / 3) * (qy - y)})
		case 4: // cubic
			if !need(6) || last() == nil {
				return nil, false
			}
			p0 := last()
			c1x, c1y, c2x, c2y, x, y := f(i), f(i+4), f(i+8), f(i+12), f(i+16), f(i+20)
			i += 24
			p0.OutX, p0.OutY = c1x-p0.X, c1y-p0.Y
			cur.Anchors = append(cur.Anchors, &opendesignerv1.Anchor{X: x, Y: y, InX: c2x - x, InY: c2y - y})
		default:
			return nil, false
		}
	}
	if cur != nil {
		subs = append(subs, cur)
	}
	return subs, len(subs) > 0
}

// ---- the import tail: connectors, tables and other layers with no counterpart ----

// isLabelled: the kinds that come in as frames and may carry their own text.
func isLabelled(typ string) bool {
	switch typ {
	case "TABLE", "TABLE_CELL", "SLIDE", "SLIDE_ROW", "SLIDE_GRID", "STICKY", "SHAPE_WITH_TEXT", "CODE_BLOCK":
		return true
	}
	return false
}

// label puts the text a frame-like layer carries (a table cell's content, a sticky note) in a text layer
// that fills it. Cells and notes that have real child layers keep those and get no extra text.
func (c *converter) label(n *opendesignerv1.Node, f *fnode) {
	td := asMap(f.raw["textData"])
	if len(f.children) > 0 || (asStr(td["characters"]) == "" && asStr(f.raw["characters"]) == "") {
		return
	}
	t := c.newNode(n.Id, "Text", &opendesignerv1.Node_Text{Text: c.text(f.raw, n.Width)})
	t.Width, t.Height = n.Width, n.Height
	// The frame's own fills and strokes stay on the frame; the text is plain black on top.
	t.Fills = []*opendesignerv1.Paint{solidPaint(0, 0, 0)}
}

// connector draws a connector between its ends. A saved path (an outline) is kept as the vector it is.
// Without one the line is rebuilt from the style between the two ends (a to b, in the layer's own
// coordinates): a straight line, an elbow (across, along, across, with the bend half way) or a curve (a
// cubic with horizontal tangents). When the file does not give both ends they are taken to be the opposite
// corners of the layer's box, (0,0) and (w,h).
func (c *converter) connector(raw map[string]any, w, h float64, ends *connEnds) any {
	if sub := c.geometry(c.savedPaths(raw)); len(sub) > 0 {
		return &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: sub}}
	}
	style := asStr(raw["connectorLineStyle"])
	ax, ay, bx, by := 0.0, 0.0, w, h
	if ends != nil {
		ax, ay, bx, by = ends.ax-ends.x, ends.ay-ends.y, ends.bx-ends.x, ends.by-ends.y
	}
	a := func(x, y float64) *opendesignerv1.Anchor { return &opendesignerv1.Anchor{X: x, Y: y} }
	var anchors []*opendesignerv1.Anchor
	switch {
	case style == "ELBOWED" && ax != bx && ay != by:
		anchors = []*opendesignerv1.Anchor{a(ax, ay), a((ax+bx)/2, ay), a((ax+bx)/2, by), a(bx, by)}
	case style == "CURVED" && ax != bx && ay != by:
		anchors = []*opendesignerv1.Anchor{{X: ax, Y: ay, OutX: (bx - ax) / 2}, {X: bx, Y: by, InX: -(bx - ax) / 2}}
	default:
		anchors = []*opendesignerv1.Anchor{a(ax, ay), a(bx, by)}
	}
	if style == "ELBOWED" || style == "CURVED" {
		if ends != nil {
			c.warn("elbowed and curved connectors without a saved path were redrawn between their ends, not along the route Figma saved")
		} else {
			c.warn("elbowed and curved connectors without a saved path were redrawn between the corners of their box")
		}
	}
	return &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: []*opendesignerv1.SubPath{{Anchors: anchors}}}}
}

// connEnds are a connector's two ends in its parent's coordinates (a: connectorStart, b: connectorEnd) and
// the box they span (x, y, w, h).
type connEnds struct{ ax, ay, bx, by, x, y, w, h float64 }

// connectorEnds places both ends, as FigCraft's reader does: an end attached to a sibling layer
// (endpointNodeID) is that layer's transform applied to its relativePosition in the layer's size (the
// middle by default); a free end is its position. Nil when either end cannot be placed.
func (c *converter) connectorEnds(f *fnode) *connEnds {
	parent := guidKey(asMap(f.raw["parentIndex"])["guid"])
	end := func(key string) (x, y float64, ok bool) {
		e := asMap(f.raw[key])
		if e == nil {
			return 0, 0, false
		}
		if id := guidKey(e["endpointNodeID"]); id != "" && id != noStyle {
			n := c.byKey[id]
			// Only siblings share the connector's coordinates.
			if n == nil || guidKey(asMap(n.raw["parentIndex"])["guid"]) != parent {
				return 0, 0, false
			}
			size, tr, rel := asMap(n.raw["size"]), asMap(n.raw["transform"]), asMap(e["relativePosition"])
			px, py := num(size, "x", 0)*num(rel, "x", 0.5), num(size, "y", 0)*num(rel, "y", 0.5)
			x = num(tr, "m00", 1)*px + num(tr, "m01", 0)*py + num(tr, "m02", 0)
			y = num(tr, "m10", 0)*px + num(tr, "m11", 1)*py + num(tr, "m12", 0)
			return x, y, !math.IsNaN(x+y) && !math.IsInf(x+y, 0)
		}
		pos := asMap(e["position"])
		x, okx := pos["x"].(float64)
		y, oky := pos["y"].(float64)
		return x, y, okx && oky && !math.IsNaN(x+y) && !math.IsInf(x+y, 0)
	}
	ax, ay, oka := end("connectorStart")
	bx, by, okb := end("connectorEnd")
	if !oka || !okb {
		return nil
	}
	x, y := math.Min(ax, bx), math.Min(ay, by)
	return &connEnds{ax: ax, ay: ay, bx: bx, by: by, x: x, y: y, w: math.Abs(ax - bx), h: math.Abs(ay - by)}
}

// savedPaths is the list of {commandsBlob} entries holding a connector's saved path: its own strokeGeometry,
// else the stroke or fill outline of the generated line Figma keeps in derivedImmutableFrameData (the row
// whose guidPath is the single template guid 40000000:0, as FigCraft's reader finds it).
func (c *converter) savedPaths(raw map[string]any) any {
	if len(c.geometry(raw["strokeGeometry"])) > 0 {
		return raw["strokeGeometry"]
	}
	for _, r := range asList(asMap(raw["derivedImmutableFrameData"])["overrides"]) {
		row := asMap(r)
		guids := asList(asMap(row["guidPath"])["guids"])
		if len(guids) != 1 || guidKey(guids[0]) != "40000000:0" {
			continue
		}
		for _, k := range []string{"strokeGeometry", "fillGeometry"} {
			if len(c.geometry(row[k])) > 0 {
				return row[k]
			}
		}
	}
	return nil
}

// connectorPaint: a drawn connector is a stroke; a saved path is the stroke's outline, so it is filled
// with the stroke's colour instead.
// It returns the strokePaints index of each fill it ends up with (variable bindings translate by it).
func (c *converter) connectorPaint(n *opendesignerv1.Node, raw map[string]any) (fillSrc []int) {
	if len(c.geometry(c.savedPaths(raw))) > 0 {
		n.Fills, fillSrc = c.paintsWithSrc(raw["strokePaints"], false)
		n.Strokes = nil
	} else {
		n.Fills = nil
	}
	if t := asMap(raw["textData"]); asStr(t["characters"]) != "" {
		c.warn("the labels of connectors were left out")
	}
	// The end points (which layers a connector joins) are not live links here.
	if raw["connectorStart"] != nil || raw["connectorEnd"] != nil {
		c.warn("connectors are not attached to the layers they joined: they are plain lines")
	}
	return fillSrc
}

func solidPaint(r, g, b float64) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: float32(r), G: float32(g), B: float32(b), A: 1}}}}
}

// geometry reads a list of {commandsBlob} entries into subpaths (nil when there is none or it is unreadable).
func (c *converter) geometry(v any) []*opendesignerv1.SubPath {
	var subs []*opendesignerv1.SubPath
	for _, g := range asList(v) {
		idx := int(num(asMap(g), "commandsBlob", -1))
		if idx < 0 || idx >= len(c.blobs) || c.blobs[idx] == nil {
			continue
		}
		s, ok := pathCommands(c.blobs[idx])
		if !ok {
			return nil
		}
		subs = append(subs, s...)
	}
	return subs
}
