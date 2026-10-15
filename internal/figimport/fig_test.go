package figimport

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"math"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// ---- a tiny Kiwi ENCODER, only for building test files in the layout the reader expects ----

type tf struct {
	name  string
	typ   string
	array bool
	id    uint32
}
type td struct {
	name   string
	kind   kind
	fields []tf
}

type enc struct{ b []byte }

func (e *enc) varuint(v uint64) {
	for v >= 0x80 {
		e.b = append(e.b, byte(v)|0x80)
		v >>= 7
	}
	e.b = append(e.b, byte(v))
}
func (e *enc) varint(v int64) {
	if v < 0 {
		e.varuint(uint64(^v)<<1 | 1)
	} else {
		e.varuint(uint64(v) << 1)
	}
}
func (e *enc) cstring(s string) { e.b = append(append(e.b, s...), 0) }
func (e *enc) varfloat(f float64) {
	if f == 0 {
		e.b = append(e.b, 0)
		return
	}
	bits := math.Float32bits(float32(f))
	bits = (bits >> 23) | (bits << 9)
	e.b = append(e.b, byte(bits), byte(bits>>8), byte(bits>>16), byte(bits>>24))
}

func encodeSchema(defs []td) []byte {
	idx := map[string]int{}
	for i, d := range defs {
		idx[d.name] = i
	}
	e := &enc{}
	e.varuint(uint64(len(defs)))
	for _, d := range defs {
		e.cstring(d.name)
		e.b = append(e.b, byte(d.kind))
		e.varuint(uint64(len(d.fields)))
		for _, f := range d.fields {
			e.cstring(f.name)
			if d.kind == kindEnum {
				e.varint(0)
			} else {
				t := -1
				for i, b := range builtins {
					if b == f.typ {
						t = ^i
					}
				}
				if t == -1 {
					t = idx[f.typ]
				}
				e.varint(int64(t))
			}
			if f.array {
				e.b = append(e.b, 1)
			} else {
				e.b = append(e.b, 0)
			}
			e.varuint(uint64(f.id))
		}
	}
	return e.b
}

type encoder struct {
	defs map[string]td
}

func (en *encoder) value(e *enc, typ string, v any) {
	switch typ {
	case "bool":
		if v.(bool) {
			e.b = append(e.b, 1)
		} else {
			e.b = append(e.b, 0)
		}
	case "byte":
		e.b = append(e.b, byte(v.(int)))
	case "int":
		e.varint(int64(v.(int)))
	case "uint":
		e.varuint(uint64(v.(int)))
	case "float":
		e.varfloat(toF(v))
	case "string":
		e.cstring(v.(string))
	default:
		d := en.defs[typ]
		switch d.kind {
		case kindEnum:
			for _, f := range d.fields {
				if f.name == v.(string) {
					e.varuint(uint64(f.id))
				}
			}
		case kindStruct:
			m := v.(map[string]any)
			for _, f := range d.fields {
				en.field(e, f, m[f.name])
			}
		default:
			m := v.(map[string]any)
			for _, f := range d.fields {
				if x, ok := m[f.name]; ok {
					e.varuint(uint64(f.id))
					en.field(e, f, x)
				}
			}
			e.varuint(0)
		}
	}
}

func (en *encoder) field(e *enc, f tf, v any) {
	if !f.array {
		en.value(e, f.typ, v)
		return
	}
	if f.typ == "byte" {
		b := v.([]byte)
		e.varuint(uint64(len(b)))
		e.b = append(e.b, b...)
		return
	}
	l := v.([]any)
	e.varuint(uint64(len(l)))
	for _, x := range l {
		en.value(e, f.typ, x)
	}
}

func toF(v any) float64 {
	switch x := v.(type) {
	case int:
		return float64(x)
	case float64:
		return x
	}
	panic("not a number")
}

func testDefs() []td {
	return []td{
		{"NodeType", kindEnum, []tf{{"DOCUMENT", "", false, 1}, {"CANVAS", "", false, 2}, {"FRAME", "", false, 3}, {"RECTANGLE", "", false, 4}, {"TEXT", "", false, 5}, {"ELLIPSE", "", false, 6}, {"VECTOR", "", false, 7}, {"GROUP", "", false, 8}, {"INSTANCE", "", false, 9}, {"SLICE", "", false, 10}}},
		{"PaintType", kindEnum, []tf{{"SOLID", "", false, 1}, {"GRADIENT_LINEAR", "", false, 2}, {"IMAGE", "", false, 3}}},
		{"GUID", kindStruct, []tf{{"sessionID", "uint", false, 1}, {"localID", "uint", false, 2}}},
		{"Vector", kindStruct, []tf{{"x", "float", false, 1}, {"y", "float", false, 2}}},
		{"Matrix", kindStruct, []tf{{"m00", "float", false, 1}, {"m01", "float", false, 2}, {"m02", "float", false, 3}, {"m10", "float", false, 4}, {"m11", "float", false, 5}, {"m12", "float", false, 6}}},
		{"Color", kindStruct, []tf{{"r", "float", false, 1}, {"g", "float", false, 2}, {"b", "float", false, 3}, {"a", "float", false, 4}}},
		{"ColorStop", kindStruct, []tf{{"color", "Color", false, 1}, {"position", "float", false, 2}}},
		{"ParentIndex", kindMessage, []tf{{"guid", "GUID", false, 1}, {"position", "string", false, 2}}},
		{"Image", kindMessage, []tf{{"hash", "byte", true, 1}}},
		{"Paint", kindMessage, []tf{{"type", "PaintType", false, 1}, {"color", "Color", false, 2}, {"opacity", "float", false, 3}, {"visible", "bool", false, 4}, {"stops", "ColorStop", true, 5}, {"transform", "Matrix", false, 6}, {"image", "Image", false, 7}, {"imageScaleMode", "string", false, 8}}},
		{"TextData", kindMessage, []tf{{"characters", "string", false, 1}}},
		{"FontName", kindMessage, []tf{{"family", "string", false, 1}, {"style", "string", false, 2}}},
		{"Geometry", kindMessage, []tf{{"commandsBlob", "uint", false, 1}}},
		{"NodeChange", kindMessage, []tf{
			{"guid", "GUID", false, 1}, {"parentIndex", "ParentIndex", false, 2}, {"type", "NodeType", false, 3}, {"name", "string", false, 4},
			{"visible", "bool", false, 5}, {"opacity", "float", false, 6}, {"size", "Vector", false, 7}, {"transform", "Matrix", false, 8},
			{"fillPaints", "Paint", true, 9}, {"strokePaints", "Paint", true, 10}, {"strokeWeight", "float", false, 11}, {"cornerRadius", "float", false, 12},
			{"textData", "TextData", false, 13}, {"fontSize", "float", false, 14}, {"fontName", "FontName", false, 15}, {"stackMode", "string", false, 16},
			{"stackSpacing", "float", false, 17}, {"stackPaddingLeft", "float", false, 18}, {"fillGeometry", "Geometry", true, 19}, {"mask", "bool", false, 20},
			{"horizontalConstraint", "string", false, 21},
		}},
		{"Blob", kindMessage, []tf{{"bytes", "byte", true, 1}}},
		{"Message", kindMessage, []tf{{"nodeChanges", "NodeChange", true, 1}, {"blobs", "Blob", true, 2}}},
	}
}

func buildCanvas(t *testing.T, msg map[string]any, compress func([]byte) []byte) []byte {
	t.Helper()
	defs := testDefs()
	en := &encoder{defs: map[string]td{}}
	for _, d := range defs {
		en.defs[d.name] = d
	}
	data := &enc{}
	en.value(data, "Message", msg)
	out := []byte("fig-kiwi")
	out = binary.LittleEndian.AppendUint32(out, 15)
	for _, chunk := range [][]byte{compress(encodeSchema(defs)), compress(data.b)} {
		out = binary.LittleEndian.AppendUint32(out, uint32(len(chunk)))
		out = append(out, chunk...)
	}
	return out
}

func deflateRaw(b []byte) []byte {
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, flate.DefaultCompression)
	w.Write(b)
	w.Close()
	return buf.Bytes()
}

func zstdCompress(b []byte) []byte {
	w, _ := zstd.NewWriter(nil)
	return w.EncodeAll(b, nil)
}

func zipOf(files map[string][]byte) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		f, _ := zw.Create(name)
		f.Write(data)
	}
	zw.Close()
	return buf.Bytes()
}

// ---- fixtures ----

func guid(s, l int) map[string]any { return map[string]any{"sessionID": s, "localID": l} }
func mat(x, y float64) map[string]any {
	return map[string]any{"m00": 1, "m01": 0, "m02": x, "m10": 0, "m11": 1, "m12": y}
}
func solid(r, g, b float64) map[string]any {
	return map[string]any{"type": "SOLID", "color": map[string]any{"r": r, "g": g, "b": b, "a": 1}, "opacity": 1, "visible": true}
}
func change(id int, parent int, pos, typ, name string, over map[string]any) any {
	m := map[string]any{
		"guid": guid(1, id), "parentIndex": map[string]any{"guid": guid(1, parent), "position": pos},
		"type": typ, "name": name, "visible": true, "opacity": 1,
	}
	for k, v := range over {
		m[k] = v
	}
	return m
}

func cmd(parts ...any) []byte {
	var b []byte
	for _, p := range parts {
		switch v := p.(type) {
		case int:
			b = append(b, byte(v))
		case float64:
			b = binary.LittleEndian.AppendUint32(b, math.Float32bits(float32(v)))
		}
	}
	return b
}

func fixture() map[string]any {
	return map[string]any{
		"nodeChanges": []any{
			map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"},
			change(1, 0, "a", "CANVAS", "Page 1", nil),
			change(2, 1, "a", "FRAME", "Card", map[string]any{
				"size": map[string]any{"x": 300, "y": 200}, "transform": mat(100, 50), "fillPaints": []any{solid(1, 1, 1)},
				"cornerRadius": 12, "stackMode": "VERTICAL", "stackSpacing": 8, "stackPaddingLeft": 16,
			}),
			change(3, 2, "a", "RECTANGLE", "Bar", map[string]any{
				"size": map[string]any{"x": 100, "y": 20}, "transform": mat(10, 20), "fillPaints": []any{solid(1, 0, 0)},
				"strokePaints": []any{solid(0, 0, 1)}, "strokeWeight": 2, "cornerRadius": 4, "horizontalConstraint": "STRETCH",
			}),
			change(4, 2, "b", "TEXT", "Title", map[string]any{
				"size": map[string]any{"x": 120, "y": 24}, "transform": mat(10, 60), "fillPaints": []any{solid(0, 0, 0)},
				"textData": map[string]any{"characters": "Hello Figma"}, "fontSize": 18, "fontName": map[string]any{"family": "Inter", "style": "Bold Italic"},
			}),
			change(5, 2, "c", "VECTOR", "Tri", map[string]any{
				"size": map[string]any{"x": 40, "y": 40}, "transform": mat(200, 100), "fillPaints": []any{solid(0, 1, 0)},
				"fillGeometry": []any{map[string]any{"commandsBlob": 0}},
			}),
			change(6, 1, "b", "ELLIPSE", "Dot", map[string]any{
				"size": map[string]any{"x": 50, "y": 50}, "transform": map[string]any{"m00": 0, "m01": -1, "m02": 500, "m10": 1, "m11": 0, "m12": 400},
				"fillPaints": []any{map[string]any{"type": "GRADIENT_LINEAR", "opacity": 1, "visible": true, "transform": mat(0, 0),
					"stops": []any{
						map[string]any{"color": map[string]any{"r": 1, "g": 0, "b": 0, "a": 1}, "position": 0},
						map[string]any{"color": map[string]any{"r": 0, "g": 0, "b": 1, "a": 1}, "position": 1},
					}}},
			}),
			change(7, 1, "c", "SLICE", "Slice", nil),
			change(8, 1, "d", "INSTANCE", "Inst", map[string]any{"size": map[string]any{"x": 10, "y": 10}, "transform": mat(700, 700)}),
		},
		"blobs": []any{
			// A triangle: move, two lines, close.
			map[string]any{"bytes": cmd(1, 0.0, 40.0, 2, 20.0, 0.0, 2, 40.0, 40.0, 0)},
		},
	}
}

func find(res *Result, name string) *opendesignerv1.Node {
	for _, n := range res.Nodes {
		if n.Name == name {
			return n
		}
	}
	return nil
}

func TestImportsAFigFile(t *testing.T) {
	for name, compress := range map[string]func([]byte) []byte{"deflate": deflateRaw, "zstd": zstdCompress} {
		t.Run(name, func(t *testing.T) {
			res, err := Import(zipOf(map[string][]byte{"canvas.fig": buildCanvas(t, fixture(), compress), "meta.json": []byte("{}")}), Options{Name: "Design.fig"})
			if err != nil {
				t.Fatal(err)
			}
			root := res.Nodes[0]
			if root.Name != "Design.fig" || root.GetGroup() == nil || root.ParentId != "" {
				t.Fatalf("root = %v", root)
			}
			page := find(res, "Page 1")
			if page == nil || page.ParentId != root.Id {
				t.Fatal("the page is missing or misplaced")
			}

			card := find(res, "Card")
			if card.GetFrame() == nil || !card.GetFrame().GetClipsContent() || card.ParentId != page.Id {
				t.Fatalf("card = %v", card)
			}
			al := card.GetFrame().GetAutoLayout()
			if al == nil || al.GetDirection() != opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL || al.GetSpacing() != 8 || al.GetPaddingLeft() != 16 {
				t.Fatalf("auto layout = %v", al)
			}
			// The card is the page's top-left item, so it starts at the page's origin; the ellipse sits right and below it.
			if card.X != 0 || card.Y != 0 || card.Width != 300 || card.Height != 200 {
				t.Fatalf("card box = %v %v %v %v", card.X, card.Y, card.Width, card.Height)
			}

			bar := find(res, "Bar")
			if bar.ParentId != card.Id || bar.X != 10 || bar.Y != 20 || bar.GetRect().GetCornerRadius() != 4 || bar.ConstraintX != opendesignerv1.Constraint_CONSTRAINT_STRETCH {
				t.Fatalf("bar = %v", bar)
			}
			if c := bar.Fills[0].GetSolid().GetColor(); c.R != 1 || c.G != 0 {
				t.Fatalf("bar fill = %v", c)
			}
			if len(bar.Strokes) != 1 || bar.Strokes[0].Weight != 2 || bar.Strokes[0].GetPaint().GetSolid().GetColor().B != 1 {
				t.Fatalf("bar stroke = %v", bar.Strokes)
			}

			title := find(res, "Title")
			ts := title.GetText().GetStyle()
			if title.GetText().GetContent() != "Hello Figma" || ts.FontFamily != "Inter" || ts.FontSize != 18 || ts.FontWeight != "700" || !ts.Italic {
				t.Fatalf("title = %v", title)
			}

			tri := find(res, "Tri")
			v := tri.GetVector()
			if v == nil || len(v.Subpaths) != 1 || !v.Subpaths[0].Closed || len(v.Subpaths[0].Anchors) != 3 || v.Subpaths[0].Anchors[1].X != 20 {
				t.Fatalf("triangle = %v", tri)
			}

			dot := find(res, "Dot")
			// Turned 90 degrees: the center stays where the matrix puts it, and the rotation is read back.
			if dot.Rotation != 90 {
				t.Fatalf("dot rotation = %v", dot.Rotation)
			}
			if g := dot.Fills[0].GetLinear(); g == nil || len(g.Stops) != 2 || g.X1 != 0 || g.Y1 != 0.5 || g.X2 != 1 || g.Y2 != 0.5 {
				t.Fatalf("dot gradient = %v", dot.Fills)
			}

			if find(res, "Slice") != nil {
				t.Fatal("a slice has no equivalent and must not be imported")
			}
			joined := strings.Join(res.Warnings, "\n")
			if !strings.Contains(joined, "slice layers were not imported") || !strings.Contains(joined, "instances were imported as plain frames") {
				t.Fatalf("warnings = %v", res.Warnings)
			}
			// Every node comes after its parent, and the ids are unique.
			seen := map[string]bool{}
			for i, n := range res.Nodes {
				if seen[n.Id] {
					t.Fatalf("duplicate id %s", n.Id)
				}
				if i > 0 && !seen[n.ParentId] {
					t.Fatalf("%s comes before its parent", n.Name)
				}
				seen[n.Id] = true
			}
			if res.Width <= 0 || res.Height <= 0 {
				t.Fatalf("size = %v x %v", res.Width, res.Height)
			}
		})
	}
}

func TestImportsABareCanvasAndImages(t *testing.T) {
	hash := bytes.Repeat([]byte{0xab}, 20)
	msg := fixture()
	nc := msg["nodeChanges"].([]any)
	nc = append(nc, change(9, 1, "e", "RECTANGLE", "Photo", map[string]any{
		"size": map[string]any{"x": 80, "y": 60}, "transform": mat(0, 300),
		"fillPaints": []any{map[string]any{"type": "IMAGE", "opacity": 1, "visible": true, "image": map[string]any{"hash": hash}, "imageScaleMode": "FIT"}},
	}))
	msg["nodeChanges"] = nc
	canvas := buildCanvas(t, msg, deflateRaw)

	var put [][]byte
	res, err := Import(canvas, Options{PutAsset: func(b []byte) (string, error) { put = append(put, b); return strings.Repeat("c", 64), nil }})
	if err != nil {
		t.Fatal(err)
	}
	// A bare canvas has no images folder: the fill falls back to grey and says so.
	if p := find(res, "Photo").Fills[0]; p.GetSolid() == nil || !strings.Contains(strings.Join(res.Warnings, "|"), "image file is missing") {
		t.Fatalf("photo = %v / %v", p, res.Warnings)
	}

	zipped := zipOf(map[string][]byte{"canvas.fig": canvas, "images/" + strings.Repeat("ab", 20): []byte("\x89PNG\r\n\x1a\nxx")})
	res, err = Import(zipped, Options{PutAsset: func(b []byte) (string, error) { put = append(put, b); return strings.Repeat("c", 64), nil }})
	if err != nil {
		t.Fatal(err)
	}
	im := find(res, "Photo").Fills[0].GetImage()
	if im == nil || im.AssetHash != strings.Repeat("c", 64) || im.Mode != opendesignerv1.ImageScaleMode_IMAGE_SCALE_MODE_FIT || len(put) != 1 {
		t.Fatalf("photo fill = %v (stored %d)", find(res, "Photo").Fills, len(put))
	}
}

func TestRefusesWhatIsNotAFigFile(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":          nil,
		"text":           []byte("hello, this is not a figma file at all"),
		"zip without it": zipOf(map[string][]byte{"readme.txt": []byte("x")}),
		"truncated":      append([]byte("fig-kiwi\x0f\x00\x00\x00"), 0xff, 0xff, 0x00, 0x00, 1),
		"bad chunks":     append([]byte("fig-kiwi\x0f\x00\x00\x00"), 2, 0, 0, 0, 9, 9, 2, 0, 0, 0, 9, 9),
	} {
		if _, err := Import(data, Options{}); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	// A file with no pages.
	empty := map[string]any{"nodeChanges": []any{map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"}}}
	if _, err := Import(buildCanvas(t, empty, deflateRaw), Options{}); err == nil {
		t.Error("a file with no pages must fail")
	}
}

func TestVarfloatRoundTrips(t *testing.T) {
	for _, f := range []float64{0, 1, -1, 0.5, 123.456, -9999.25, 1e-3, 3.4e10} {
		e := &enc{}
		e.varfloat(f)
		got, err := (&reader{data: e.b}).varfloat()
		if err != nil || math.Abs(got-float64(float32(f))) > 1e-9*math.Max(1, math.Abs(f)) {
			t.Errorf("%v -> %v (%v)", f, got, err)
		}
	}
}

func TestBadPathCommandsFallBack(t *testing.T) {
	msg := fixture()
	msg["blobs"] = []any{map[string]any{"bytes": []byte{1, 0, 0}}} // a move with no coordinates
	res, err := Import(buildCanvas(t, msg, deflateRaw), Options{})
	if err != nil {
		t.Fatal(err)
	}
	tri := find(res, "Tri")
	if tri.GetRect() == nil || !strings.Contains(strings.Join(res.Warnings, "|"), "imported as a rectangle") {
		t.Fatalf("a misread path must become a rectangle with a warning: %v / %v", tri, res.Warnings)
	}
}
