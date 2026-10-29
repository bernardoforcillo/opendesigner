package diagram

import (
	"strings"
	"testing"
)

const erSrc = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE-ITEM : contains
  CUSTOMER }o..o| REGION : "lives in"
  CUSTOMER {
    string name
    string email PK, UK "the login"
    int age
  }
  ORDER["Purchase order"] {
    int id PK
    int customer_id FK
  }`

func TestParseER(t *testing.T) {
	cd, err := parseER(erSrc)
	if err != nil {
		t.Fatal(err)
	}
	if len(cd.Classes) != 4 || len(cd.Rels) != 3 {
		t.Fatalf("entities=%d relationships=%d", len(cd.Classes), len(cd.Rels))
	}
	var customer, order classDef
	for _, c := range cd.Classes {
		switch c.ID {
		case "CUSTOMER":
			customer = c
		case "ORDER":
			order = c
		}
	}
	if len(customer.Attrs) != 3 || customer.Attrs[1] != `string email  PK,UK  "the login"` {
		t.Errorf("customer attributes = %q", customer.Attrs)
	}
	if order.Label != "Purchase order" || len(order.Attrs) != 2 {
		t.Errorf("order = %+v", order)
	}
	r := cd.Rels[0]
	if r.A != "CUSTOMER" || r.B != "ORDER" || r.CardA != "1" || r.CardB != "0..*" || r.Dashed || r.Label != "places" {
		t.Errorf("first relationship = %+v", r)
	}
	if r := cd.Rels[1]; r.CardA != "1" || r.CardB != "1..*" || r.B != "LINE-ITEM" {
		t.Errorf("second = %+v", r)
	}
	if r := cd.Rels[2]; !r.Dashed || r.CardA != "0..*" || r.CardB != "0..1" || r.Label != "lives in" {
		t.Errorf("a non-identifying relationship is dashed: %+v", r)
	}
}

func TestERErrors(t *testing.T) {
	for _, c := range []struct{ name, src, want string }{
		{"no entity", "erDiagram", "no entities"},
		{"bad line", "erDiagram\n  A -> B", "unrecognized"},
		{"open block", "erDiagram\n  A {\n    int id", "not closed"},
		{"bad attribute", "erDiagram\n  A {\n    justone\n  }", "attribute"},
	} {
		if _, err := parseER(c.src); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want one containing %q", c.name, err, c.want)
		}
	}
}

func TestERDetectedAndRendered(t *testing.T) {
	if k, err := Detect(erSrc); err != nil || k != KindER {
		t.Fatalf("Detect = %q, %v", k, err)
	}
	res, err := Render(erSrc)
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != KindER {
		t.Errorf("kind = %q", res.Kind)
	}
	for _, want := range []string{"Purchase order", "LINE-ITEM", "email", "0..*", "places"} {
		found := false
		for _, n := range res.Nodes {
			if strings.Contains(n.GetName(), want) || strings.Contains(n.GetText().GetContent(), want) {
				found = true
			}
		}
		if !found {
			t.Errorf("the drawing must show %q", want)
		}
	}
}
