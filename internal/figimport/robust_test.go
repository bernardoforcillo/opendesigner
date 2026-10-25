package figimport

import (
	"encoding/binary"
	"fmt"
	"math/rand"
	"testing"
	"time"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// ROBUSTNESS on generated files. There is no file saved by Figma anywhere in this repository (nor in
// FigCraft's), so none of this says the reader copes with the real thing; it says the reader
// does not panic, hang or hand the document something it would refuse when the bytes are cut, flipped,
// junk or claim absurd sizes. The shapes follow FigCraft's own reader tests (truncation at every
// length, hostile counts and budgets).

// encodeParts returns the schema and the message of `msg`, not yet compressed or framed.
func encodeParts(msg map[string]any) (schemaBytes, data []byte) {
	defs := testDefs()
	en := &encoder{defs: map[string]td{}}
	for _, d := range defs {
		en.defs[d.name] = d
	}
	e := &enc{}
	en.value(e, "Message", msg)
	return encodeSchema(defs), e.b
}

// frame wraps schema and data in the container: magic, version, two length-prefixed chunks.
func frame(schemaBytes, data []byte, compress func([]byte) []byte) []byte {
	out := binary.LittleEndian.AppendUint32([]byte("fig-kiwi"), 15)
	for _, chunk := range [][]byte{compress(schemaBytes), compress(data)} {
		out = binary.LittleEndian.AppendUint32(out, uint32(len(chunk)))
		out = append(out, chunk...)
	}
	return out
}

// within runs fn and fails the test when it panics or takes longer than the budget.
func within(t *testing.T, what string, fn func()) {
	t.Helper()
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		fn()
	}()
	select {
	case p := <-done:
		if p != nil {
			t.Fatalf("%s: panic: %v", what, p)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("%s: did not finish in 30s", what)
	}
}

// checkResult holds a successful import to what the editor would accept: unique ids, parents before
// children, and collections / variables / bindings / modes that core.Apply takes without complaint.
func checkResult(t *testing.T, what string, res *Result) {
	t.Helper()
	seen := map[string]bool{"": true}
	for i, n := range res.Nodes {
		if n.Id == "" || (seen[n.Id] && i >= 0) {
			t.Fatalf("%s: node %d has an empty or repeated id", what, i)
		}
		if i > 0 && !seen[n.ParentId] {
			t.Fatalf("%s: node %q comes before its parent", what, n.Name)
		}
		seen[n.Id] = true
	}
	doc := core.NewDocument("d", "d")
	for _, c := range res.Collections {
		if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: c}}}); err != nil {
			t.Fatalf("%s: collection %q: %v", what, c.Name, err)
		}
	}
	for _, v := range res.Variables {
		if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}); err != nil {
			t.Fatalf("%s: variable %q: %v", what, v.Name, err)
		}
	}
	for _, n := range res.Nodes {
		if err := core.ValidateBindings(doc, n.Bindings); err != nil {
			t.Fatalf("%s: node %q: %v", what, n.Name, err)
		}
		if err := core.ValidateModes(doc, n.Modes); err != nil {
			t.Fatalf("%s: node %q: %v", what, n.Name, err)
		}
	}
}

// importChecked imports and, on success, checks the result; it returns the error.
func importChecked(t *testing.T, what string, data []byte) (err error) {
	t.Helper()
	within(t, what, func() {
		var res *Result
		res, err = Import(data, Options{})
		if err == nil {
			checkResult(t, what, res)
		}
	})
	return err
}

func TestTruncationAtEveryLengthIsAnError(t *testing.T) {
	schemaBytes, data := encodeParts(variablesFixture())
	for name, compress := range map[string]func([]byte) []byte{"deflate": deflateRaw, "zstd": zstdCompress} {
		whole := frame(schemaBytes, data, compress)
		if err := importChecked(t, name+" whole", whole); err != nil {
			t.Fatalf("the whole file must import: %v", err)
		}
		// The container cut anywhere, bare and inside a zip.
		for n := 0; n < len(whole); n++ {
			if err := importChecked(t, fmt.Sprintf("%s bare %d/%d", name, n, len(whole)), whole[:n]); err == nil {
				t.Fatalf("%s: %d of %d bytes imported without error", name, n, len(whole))
			}
		}
		zipped := zipOf(map[string][]byte{"canvas.fig": whole})
		for n := 0; n < len(zipped); n += 7 {
			importChecked(t, fmt.Sprintf("%s zip %d/%d", name, n, len(zipped)), zipped[:n]) // an error or not, but no panic
		}
	}
	// The message cut at every length inside a valid container (and the schema too): every prefix is
	// short of the terminator of the root message, so none may succeed.
	for n := 0; n < len(data); n++ {
		if err := importChecked(t, fmt.Sprintf("message %d/%d", n, len(data)), frame(schemaBytes, data[:n], deflateRaw)); err == nil {
			t.Fatalf("a message cut to %d of %d bytes imported without error", n, len(data))
		}
	}
	for n := 0; n < len(schemaBytes); n++ {
		importChecked(t, fmt.Sprintf("schema %d/%d", n, len(schemaBytes)), frame(schemaBytes[:n], data, deflateRaw))
	}
}

func TestBitFlipsNeverBreakTheReader(t *testing.T) {
	schemaBytes, data := encodeParts(variablesFixture())
	ok, failed := 0, 0
	count := func(err error) {
		if err == nil {
			ok++
		} else {
			failed++
		}
	}
	// One flipped bit per byte of the message, then of the schema, then of the compressed container.
	step := 1
	if testing.Short() {
		step = 7
	}
	for i := 0; i < len(data); i += step {
		d := append([]byte(nil), data...)
		d[i] ^= 1 << (i % 8)
		count(importChecked(t, fmt.Sprintf("message bit %d", i), frame(schemaBytes, d, deflateRaw)))
	}
	for i := 0; i < len(schemaBytes); i += step {
		s := append([]byte(nil), schemaBytes...)
		s[i] ^= 1 << (i % 8)
		count(importChecked(t, fmt.Sprintf("schema bit %d", i), frame(s, data, deflateRaw)))
	}
	whole := frame(schemaBytes, data, zstdCompress)
	for i := 0; i < len(whole); i += step {
		w := append([]byte(nil), whole...)
		w[i] ^= 1 << (i % 8)
		count(importChecked(t, fmt.Sprintf("container bit %d", i), w))
	}
	// Both outcomes happen: flipping a float's bit still imports, flipping a length does not.
	if ok == 0 || failed == 0 {
		t.Fatalf("expected a mix of outcomes, got %d imported and %d refused", ok, failed)
	}
}

func TestJunkIsRefusedWithoutPanic(t *testing.T) {
	rnd := rand.New(rand.NewSource(7))
	header := binary.LittleEndian.AppendUint32([]byte("fig-kiwi"), 15)
	for i := 0; i < 400; i++ {
		junk := make([]byte, rnd.Intn(3000))
		rnd.Read(junk)
		importChecked(t, fmt.Sprintf("junk %d", i), junk)
		importChecked(t, fmt.Sprintf("junk with header %d", i), append(append([]byte(nil), header...), junk...))
		importChecked(t, fmt.Sprintf("junk zip %d", i), append([]byte("PK"), junk...))
		importChecked(t, fmt.Sprintf("junk canvas in zip %d", i), zipOf(map[string][]byte{"canvas.fig": junk, "images/ab": junk}))
		// Junk in valid chunks: well-framed, deflated noise.
		importChecked(t, fmt.Sprintf("junk chunks %d", i), frame(junk, junk, deflateRaw))
		importChecked(t, fmt.Sprintf("junk zstd chunks %d", i), frame(junk, junk, zstdCompress))
	}
	// A real schema with a junk message.
	schemaBytes, _ := encodeParts(variablesFixture())
	for i := 0; i < 400; i++ {
		junk := make([]byte, rnd.Intn(600))
		rnd.Read(junk)
		importChecked(t, fmt.Sprintf("junk message %d", i), frame(schemaBytes, junk, deflateRaw))
	}
}

func TestHugeCountsAndBudgets(t *testing.T) {
	schemaBytes, data := encodeParts(variablesFixture())
	varuint := func(v uint64) []byte { e := &enc{}; e.varuint(v); return e.b }

	// A chunk longer than the file, and the biggest length there is.
	big := frame(schemaBytes, data, deflateRaw)
	binary.LittleEndian.PutUint32(big[12:], 0xFFFFFFFF)
	if err := importChecked(t, "chunk length", big); err == nil {
		t.Fatal("a chunk running past the file must be refused")
	}
	// A schema that announces 2^60 definitions, one whose varuint never ends.
	for name, s := range map[string][]byte{
		"definitions": varuint(1 << 60),
		"endless":     append(make([]byte, 0, 40), []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}...),
		"fields":      append(varuint(1), append([]byte("Message\x00\x02"), varuint(1<<60)...)...),
	} {
		if err := importChecked(t, "schema "+name, frame(s, data, deflateRaw)); err == nil {
			t.Fatalf("schema %s must be refused", name)
		}
	}
	// A message whose arrays claim more elements than there are bytes.
	for _, n := range []uint64{1 << 20, 1 << 40, 1<<63 + 5} {
		msg := append(varuint(1), varuint(n)...) // field 1 (nodeChanges), n elements
		if err := importChecked(t, fmt.Sprintf("array of %d", n), frame(schemaBytes, msg, deflateRaw)); err == nil {
			t.Fatalf("an array of %d elements in a few bytes must be refused", n)
		}
	}
	// Past the node budget.
	if !testing.Short() {
		nodes := []any{map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"}, change(1, 0, "a", "CANVAS", "P", nil)}
		for i := 0; i <= maxNodes; i++ {
			nodes = append(nodes, change(10+i, 1, "a", "RECTANGLE", "r", nil))
		}
		if err := importChecked(t, "too many nodes", buildCanvas(t, map[string]any{"nodeChanges": nodes}, deflateRaw)); err == nil {
			t.Fatal("more nodes than the budget must be refused")
		}
	}
}

// A very deep tree, a parent cycle and unreachable nodes: the importer ends, and the result is sound.
func TestDeepAndCyclicTrees(t *testing.T) {
	nodes := []any{map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"}, change(1, 0, "a", "CANVAS", "P", nil)}
	const depth = 20000
	parent := 1
	for i := 0; i < depth; i++ {
		id := 100 + i
		nodes = append(nodes, change(id, parent, "a", "FRAME", "f", map[string]any{"size": map[string]any{"x": 10, "y": 10}}))
		parent = id
	}
	// Two nodes that name each other as parents, and one with a parent that is not in the file.
	nodes = append(nodes, change(50, 51, "a", "FRAME", "loop-a", nil), change(51, 50, "a", "FRAME", "loop-b", nil), change(52, 9999, "a", "FRAME", "orphan", nil))
	if err := importChecked(t, "deep", buildCanvas(t, map[string]any{"nodeChanges": nodes}, deflateRaw)); err != nil {
		t.Fatal(err)
	}
}

// Variable shapes made to cost: a long chain of aliases, a cycle, a collection with thousands of modes.
func TestHostileVariables(t *testing.T) {
	nodes := []any{
		map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"},
		change(1, 0, "a", "CANVAS", "P", nil),
		change(2, 0, "~", "CANVAS", "Internal", map[string]any{"internalOnly": true}),
	}
	var modes []any
	for i := 0; i < 3000; i++ {
		modes = append(modes, setModes(5000+i, "m", "a")...)
	}
	nodes = append(nodes, change(10, 2, "a", "VARIABLE_SET", "Wide", map[string]any{"variableSetModes": modes}))
	const chain = 5000
	nodes = append(nodes, variable(1000, "a", "base", 10, "FLOAT", modeValues(5000, floatData(1))))
	for i := 1; i < chain; i++ {
		nodes = append(nodes, variable(1000+i, fmt.Sprintf("%06d", i), fmt.Sprintf("v%d", i), 10, "FLOAT", modeValues(5000, aliasData(1000+i-1))))
	}
	// A ring of 300, and a variable that aliases itself.
	for i := 0; i < 300; i++ {
		nodes = append(nodes, variable(20000+i, fmt.Sprintf("r%06d", i), fmt.Sprintf("ring%d", i), 10, "FLOAT", modeValues(5000, aliasData(20000+(i+1)%300))))
	}
	nodes = append(nodes, variable(30000, "z", "self", 10, "FLOAT", modeValues(5000, aliasData(30000))))
	nodes = append(nodes, change(40, 1, "a", "RECTANGLE", "R", map[string]any{
		"size": map[string]any{"x": 5, "y": 5}, "transform": mat(0, 0),
		"variableConsumptionMap": consumption(bound("OPACITY", 1000+chain-1), bound("CORNER_RADIUS", 30000)),
	}))
	var res *Result
	within(t, "hostile variables", func() {
		var err error
		res, err = Import(buildCanvas(t, map[string]any{"nodeChanges": nodes}, deflateRaw), Options{})
		if err != nil {
			t.Error(err)
			return
		}
		checkResult(t, "hostile variables", res)
	})
	if res == nil {
		return
	}
	if len(res.Collections) != 1 || len(res.Collections[0].Modes) != maxModes {
		t.Fatalf("modes = %d, want the cap of %d", len(res.Collections[0].Modes), maxModes)
	}
	for _, v := range res.Variables {
		if v.AliasOf != "" && len(v.Values) != 0 {
			t.Fatalf("%s is an alias with values", v.Name)
		}
	}
}
