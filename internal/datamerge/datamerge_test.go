package datamerge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type cases struct {
	Tables []struct {
		In      string     `json:"in"`
		Headers []string   `json:"headers"`
		Rows    [][]string `json:"rows"`
	} `json:"tables"`
	Substitutions []struct {
		Content string            `json:"content"`
		Record  map[string]string `json:"record"`
		Text    string            `json:"text"`
		Maps    [][2]int          `json:"maps"`
	} `json:"substitutions"`
}

func load(t *testing.T) cases {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "merge", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c cases
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestParseTable(t *testing.T) {
	for _, c := range load(t).Tables {
		got := ParseTable(c.In)
		if len(got.Headers) != len(c.Headers) || (len(c.Headers) > 0 && !reflect.DeepEqual(got.Headers, c.Headers)) || (len(c.Rows) > 0 && !reflect.DeepEqual(got.Rows, c.Rows)) || len(got.Rows) != len(c.Rows) {
			t.Errorf("%q -> %+v, want headers %v rows %v", c.In, got, c.Headers, c.Rows)
		}
	}
}

func TestSubstitute(t *testing.T) {
	for _, c := range load(t).Substitutions {
		got := Substitute(c.Content, c.Record)
		if got.Text != c.Text {
			t.Errorf("%q -> %q, want %q", c.Content, got.Text, c.Text)
		}
		for _, m := range c.Maps {
			if g := got.Map(m[0]); g != m[1] {
				t.Errorf("%q: offset %d -> %d, want %d", c.Content, m[0], g, m[1])
			}
		}
	}
}

func TestFieldsAndRecord(t *testing.T) {
	if got := FieldsIn("{{ First }} {{Last}} {{}}"); !reflect.DeepEqual(got, []string{"First", "Last"}) {
		t.Fatalf("fields = %v", got)
	}
	tb := Table{Headers: []string{"a", "", "c"}}
	if r := tb.Record([]string{"1", "2"}); !reflect.DeepEqual(r, map[string]string{"a": "1", "c": ""}) {
		t.Fatalf("record = %v", r)
	}
}
