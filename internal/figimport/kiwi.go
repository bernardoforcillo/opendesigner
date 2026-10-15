package figimport

import (
	"errors"
	"fmt"
	"math"
)

// A decoder for Kiwi (https://github.com/evanw/kiwi), the binary schema format a .fig file's
// canvas is written in. The file carries its own schema, so decoding is generic: schema bytes ->
// definitions, then a message of the root type -> maps, slices and scalars. Only what a reader
// needs; there is no encoder here (the tests have their own).

type kind byte

const (
	kindEnum kind = iota
	kindStruct
	kindMessage
)

type field struct {
	name    string
	typ     string // a built-in name or a definition name
	isArray bool
	value   uint32 // the field id of a message, the value of an enum
}

type definition struct {
	name   string
	kind   kind
	fields []field
	byID   map[uint32]*field // messages and enums
}

type schema struct {
	defs map[string]*definition
}

var builtins = [...]string{"bool", "byte", "int", "uint", "float", "string", "int64", "uint64"}

var errShort = errors.New("figimport: the data ends early")

// reader reads Kiwi's primitives.
type reader struct {
	data []byte
	pos  int
}

func (r *reader) byte() (byte, error) {
	if r.pos >= len(r.data) {
		return 0, errShort
	}
	b := r.data[r.pos]
	r.pos++
	return b, nil
}

func (r *reader) varuint() (uint64, error) {
	var v uint64
	for shift := uint(0); shift < 70; shift += 7 {
		b, err := r.byte()
		if err != nil {
			return 0, err
		}
		v |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return v, nil
		}
	}
	return 0, errors.New("figimport: a variable-length integer is too long")
}

func (r *reader) varint() (int64, error) {
	u, err := r.varuint()
	if err != nil {
		return 0, err
	}
	// Zigzag.
	if u&1 != 0 {
		return ^int64(u >> 1), nil
	}
	return int64(u >> 1), nil
}

// varfloat is Kiwi's compact float32: zero is one byte, anything else is four bytes with the
// exponent rotated to the front.
func (r *reader) varfloat() (float64, error) {
	first, err := r.byte()
	if err != nil {
		return 0, err
	}
	if first == 0 {
		return 0, nil
	}
	if r.pos+3 > len(r.data) {
		return 0, errShort
	}
	bits := uint32(first) | uint32(r.data[r.pos])<<8 | uint32(r.data[r.pos+1])<<16 | uint32(r.data[r.pos+2])<<24
	r.pos += 3
	bits = (bits << 23) | (bits >> 9)
	return float64(math.Float32frombits(bits)), nil
}

func (r *reader) cstring() (string, error) {
	start := r.pos
	for r.pos < len(r.data) {
		if r.data[r.pos] == 0 {
			s := string(r.data[start:r.pos])
			r.pos++
			return s, nil
		}
		r.pos++
	}
	return "", errShort
}

func (r *reader) bytes(n int) ([]byte, error) {
	if n < 0 || r.pos+n > len(r.data) {
		return nil, errShort
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	return b, nil
}

// decodeSchema reads a binary schema.
func decodeSchema(data []byte) (*schema, error) {
	r := &reader{data: data}
	n, err := r.varuint()
	if err != nil {
		return nil, err
	}
	if n > 10000 {
		return nil, errors.New("figimport: the schema is implausibly large")
	}
	type rawField struct {
		name    string
		typ     int64
		isArray bool
		value   uint32
	}
	type rawDef struct {
		name   string
		kind   kind
		fields []rawField
	}
	raws := make([]rawDef, 0, n)
	for i := uint64(0); i < n; i++ {
		name, err := r.cstring()
		if err != nil {
			return nil, err
		}
		k, err := r.byte()
		if err != nil || k > byte(kindMessage) {
			return nil, fmt.Errorf("figimport: bad definition kind in %q", name)
		}
		fc, err := r.varuint()
		if err != nil || fc > 100000 {
			return nil, fmt.Errorf("figimport: bad field count in %q", name)
		}
		d := rawDef{name: name, kind: kind(k)}
		for j := uint64(0); j < fc; j++ {
			fname, err := r.cstring()
			if err != nil {
				return nil, err
			}
			typ, err := r.varint()
			if err != nil {
				return nil, err
			}
			arr, err := r.byte()
			if err != nil {
				return nil, err
			}
			val, err := r.varuint()
			if err != nil {
				return nil, err
			}
			d.fields = append(d.fields, rawField{fname, typ, arr&1 != 0, uint32(val)})
		}
		raws = append(raws, d)
	}
	s := &schema{defs: map[string]*definition{}}
	for _, d := range raws {
		def := &definition{name: d.name, kind: d.kind, byID: map[uint32]*field{}}
		for _, f := range d.fields {
			fld := field{name: f.name, isArray: f.isArray, value: f.value}
			if d.kind != kindEnum {
				switch {
				case f.typ < 0 && int(^f.typ) < len(builtins):
					fld.typ = builtins[^f.typ]
				case f.typ >= 0 && int(f.typ) < len(raws):
					fld.typ = raws[f.typ].name
				default:
					return nil, fmt.Errorf("figimport: %q.%s has an unknown type", d.name, f.name)
				}
			}
			def.fields = append(def.fields, fld)
		}
		for i := range def.fields {
			def.byID[def.fields[i].value] = &def.fields[i]
		}
		s.defs[d.name] = def
	}
	return s, nil
}

const maxDepth = 64

// decode reads a value of type `typ`.
func (s *schema) decode(r *reader, typ string, depth int) (any, error) {
	if depth > maxDepth {
		return nil, errors.New("figimport: the data is nested too deeply")
	}
	switch typ {
	case "bool":
		b, err := r.byte()
		return b != 0, err
	case "byte":
		b, err := r.byte()
		return float64(b), err
	case "int":
		v, err := r.varint()
		return float64(v), err
	case "uint":
		v, err := r.varuint()
		return float64(v), err
	case "int64":
		v, err := r.varint()
		return float64(v), err
	case "uint64":
		v, err := r.varuint()
		return float64(v), err
	case "float":
		return r.varfloat()
	case "string":
		return r.cstring()
	}
	def, ok := s.defs[typ]
	if !ok {
		return nil, fmt.Errorf("figimport: unknown type %q", typ)
	}
	switch def.kind {
	case kindEnum:
		v, err := r.varuint()
		if err != nil {
			return nil, err
		}
		if f, ok := def.byID[uint32(v)]; ok {
			return f.name, nil
		}
		return float64(v), nil
	case kindStruct:
		out := map[string]any{}
		for i := range def.fields {
			v, err := s.decodeField(r, &def.fields[i], depth)
			if err != nil {
				return nil, err
			}
			out[def.fields[i].name] = v
		}
		return out, nil
	default: // message
		out := map[string]any{}
		for {
			id, err := r.varuint()
			if err != nil {
				return nil, err
			}
			if id == 0 {
				return out, nil
			}
			f, ok := def.byID[uint32(id)]
			if !ok {
				return nil, fmt.Errorf("figimport: %q has no field %d", typ, id)
			}
			v, err := s.decodeField(r, f, depth)
			if err != nil {
				return nil, err
			}
			out[f.name] = v
		}
	}
}

// decodeField reads one field, which may be an array.
func (s *schema) decodeField(r *reader, f *field, depth int) (any, error) {
	if !f.isArray {
		return s.decode(r, f.typ, depth+1)
	}
	n, err := r.varuint()
	if err != nil {
		return nil, err
	}
	if f.typ == "byte" {
		b, err := r.bytes(int(n))
		if err != nil {
			return nil, err
		}
		return append([]byte(nil), b...), nil
	}
	// Every element takes at least a byte: a count beyond what is left is corrupt.
	if n > uint64(len(r.data)-r.pos) {
		return nil, errors.New("figimport: an array is longer than the data")
	}
	out := make([]any, 0, n)
	for i := uint64(0); i < n; i++ {
		v, err := s.decode(r, f.typ, depth+1)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}
