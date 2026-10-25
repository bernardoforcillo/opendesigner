// Package datamerge is the server-side twin of web/src/tools/dataMerge.ts: parse a CSV/TSV table and put its
// records into a page laid out with {{Field}} placeholders. The two share the cases in testdata/merge.
package datamerge

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

// Table is a header row and the records.
type Table struct {
	Headers []string
	Rows    [][]string
}

// ParseTable reads RFC-4180 CSV; the delimiter (, ; or tab) is the one that occurs most in the first line.
func ParseTable(input string) Table {
	text := strings.TrimPrefix(input, "\xef\xbb\xbf")
	first, _, _ := strings.Cut(text, "\n")
	first = strings.TrimSuffix(first, "\r")
	delim := ','
	best := strings.Count(first, ",") + 1
	for _, d := range []rune{';', '\t'} {
		if n := strings.Count(first, string(d)) + 1; n > best {
			delim, best = d, n
		}
	}
	var rows [][]string
	var row []string
	var cell strings.Builder
	quoted := false
	endRow := func() {
		row = append(row, cell.String())
		cell.Reset()
		for _, v := range row {
			if v != "" {
				rows = append(rows, row)
				break
			}
		}
		row = nil
	}
	rs := []rune(text)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case quoted:
			if c == '"' && i+1 < len(rs) && rs[i+1] == '"' {
				cell.WriteRune('"')
				i++
			} else if c == '"' {
				quoted = false
			} else {
				cell.WriteRune(c)
			}
		case c == '"' && cell.Len() == 0:
			quoted = true
		case c == delim:
			row = append(row, cell.String())
			cell.Reset()
		case c == '\n' || c == '\r':
			if c == '\r' && i+1 < len(rs) && rs[i+1] == '\n' {
				i++
			}
			endRow()
		default:
			cell.WriteRune(c)
		}
	}
	row = append(row, cell.String())
	for _, v := range row {
		if v != "" {
			rows = append(rows, row)
			break
		}
	}
	var headers []string
	if len(rows) > 0 {
		for _, h := range rows[0] {
			headers = append(headers, strings.TrimSpace(h))
		}
		rows = rows[1:]
	}
	return Table{Headers: headers, Rows: rows}
}

var placeholder = regexp.MustCompile(`\{\{\s*([^{}\n]+?)\s*\}\}`)

// FieldsIn lists the field names a piece of text refers to.
func FieldsIn(s string) []string {
	var out []string
	for _, m := range placeholder.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

// Substitution is a text with its placeholders replaced, and the map from an offset in the old text to the new one.
// Offsets are UTF-16 code units, the unit of the editor's text runs.
type Substitution struct {
	Text string
	cuts []cut
}

type cut struct{ at, end, to int }

// Map moves an offset (UTF-16 units) of the old text to the new text.
func (s Substitution) Map(o int) int {
	delta := 0
	for _, c := range s.cuts {
		switch {
		case o >= c.end:
			delta = c.to - c.end
		case o > c.at:
			return c.to // inside a placeholder: the end of its value
		default:
			return o + delta
		}
	}
	return o + delta
}

func u16(s string) int { return len(utf16.Encode([]rune(s))) }

// Substitute replaces the placeholders that have a value in record; the others are left as written.
func Substitute(content string, record map[string]string) Substitution {
	var out strings.Builder
	var cuts []cut
	last := 0
	for _, m := range placeholder.FindAllStringSubmatchIndex(content, -1) {
		value, ok := record[content[m[2]:m[3]]]
		if !ok {
			continue
		}
		out.WriteString(content[last:m[0]])
		v := strings.NewReplacer("\r\n", " ", "\n", " ").Replace(value)
		cuts = append(cuts, cut{at: u16(content[:m[0]]), end: u16(content[:m[1]]), to: u16(out.String()) + u16(v)})
		out.WriteString(v)
		last = m[1]
	}
	out.WriteString(content[last:])
	return Substitution{Text: out.String(), cuts: cuts}
}

// Record maps a row to its field names; short rows give empty values.
func (t Table) Record(row []string) map[string]string {
	rec := map[string]string{}
	for i, h := range t.Headers {
		if h == "" {
			continue
		}
		if i < len(row) {
			rec[h] = row[i]
		} else {
			rec[h] = ""
		}
	}
	return rec
}
