package diagram

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

const flowSrc = `flowchart TD
  A[Start] --> B{Registered user?}
  B -->|yes| C[Log in]
  B -->|no| D[Sign up]
  D --> C
  C --> E([End])`

const classSrc = `classDiagram
  direction TB
  class Animal {
    <<abstract>>
    +String name
    +int age
    +eat() void
  }
  class Duck~T~ {
    +swim()
  }
  Animal <|-- Duck
  Animal <|-- Fish
  Animal : +isMammal() bool
  Owner "1" --> "*" Animal : owns
  Duck ..> Pond : uses
  Pond *-- Water
  Pond o-- Fish`

const seqSrc = `sequenceDiagram
  autonumber
  participant A as Alice
  actor B as Bob
  A->>+B: Hello Bob
  B-->>-A: Hello Alice
  Note over A,B: a note
  loop Every minute
    A-)B: ping
    alt ok
      B->>B: process
    else error
      B--xA: failed
    end
  end
  Note right of B: done`

const stateSrc = `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Idle : stop
  Running --> Choice
  state Choice <<choice>>
  Choice --> Done
  Done --> [*]
  state "A long name" as Long
  Long : description`

func TestDetect(t *testing.T) {
	for src, want := range map[string]string{
		"flowchart LR\nA-->B": KindFlowchart, "graph TD\nA-->B": KindFlowchart, "A-->B": KindFlowchart,
		"%% c\nclassDiagram\nclass A": KindClass, "sequenceDiagram\nA->>B: x": KindSequence, "stateDiagram\n[*] --> A": KindState,
	} {
		got, err := Detect(src)
		if err != nil || got != want {
			t.Errorf("Detect(%q) = %q, %v; want %q", src, got, err, want)
		}
	}
	for _, src := range []string{"", "  \n%% comment only", "erDiagram\nA ||--o{ B : x", "gantt\ntitle x"} {
		if _, err := Detect(src); err == nil {
			t.Errorf("Detect(%q) should have failed", src)
		}
	}
}

func TestFlowchartParse(t *testing.T) {
	fc, err := parseFlowchart("flowchart LR\nA[Start] --> B{Ok?}\nB -->|yes| C([End])\nB -- no --> D((Err))\nA & B --- E <--> F\nB -.-> C ==> D\nB[Done]")
	if err != nil {
		t.Fatal(err)
	}
	if fc.Dir != DirLR {
		t.Errorf("dir = %v", fc.Dir)
	}
	shapes := map[string]fShape{}
	labels := map[string]string{}
	for _, n := range fc.Nodes {
		shapes[n.ID], labels[n.ID] = n.Shape, n.Label
	}
	if shapes["B"] != fDiamond && labels["B"] != "Done" {
		t.Errorf("B = %v %q", shapes["B"], labels["B"])
	}
	if shapes["C"] != fStadium || shapes["D"] != fCircle {
		t.Errorf("shapes: %v", shapes)
	}
	var lab []string
	for _, e := range fc.Edges {
		lab = append(lab, e.From+">"+e.To+":"+e.Label)
	}
	got := strings.Join(lab, " ")
	for _, want := range []string{"B>C:yes", "B>D:no", "A>E:", "B>E:", "E>F:", "B>C:", "C>D:"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing edge %s in %s", want, got)
		}
	}
	for _, e := range fc.Edges {
		if e.From == "E" && e.To == "F" && !(e.ArrowStart && e.ArrowEnd) {
			t.Error("E<-->F should have two arrowheads")
		}
	}
	if _, err := parseFlowchart("graph TD\nA --> "); err == nil {
		t.Error("an edge without a destination should fail")
	}
	if fc, err := parseFlowchart(`graph TD
my-x["line1<br/>line2"] --> b`); err != nil || fc.Nodes[0].ID != "my-x" || fc.Nodes[0].Label != "line1\nline2" {
		t.Errorf("id with a hyphen: %+v %v", fc, err)
	}
}

func TestRenderAllKinds(t *testing.T) {
	for kind, src := range map[string]string{KindFlowchart: flowSrc, KindClass: classSrc, KindSequence: seqSrc, KindState: stateSrc} {
		res, err := Render(src)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if res.Kind != kind || res.Width <= 0 || res.Height <= 0 {
			t.Errorf("%s: kind=%q %vx%v", kind, res.Kind, res.Width, res.Height)
		}
		root := res.Nodes[0]
		if root.GetGroup() == nil || root.Meta[MetaKind] != kind || root.Meta[MetaSource] != src {
			t.Errorf("%s: wrong root: %+v", kind, root.Meta)
		}
		if len(res.Nodes) < 5 {
			t.Errorf("%s: only %d nodes", kind, len(res.Nodes))
		}
		// the nodes must fit into a real document, in order, under a page
		doc := core.NewDocument("d", "d")
		page := doc.Pages[0].Id
		for i, n := range res.Nodes {
			if i == 0 {
				n.ParentId, n.OrderKey = page, "a"
			}
			if err := core.Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); err != nil {
				t.Fatalf("%s: node %d (%s): %v", kind, i, n.Name, err)
			}
		}
		for _, n := range res.Nodes[1:] {
			if n.ParentId != root.Id {
				t.Errorf("%s: %s is not a child of the root", kind, n.Name)
			}
			for _, v := range []float64{n.X, n.Y, n.Width, n.Height} {
				if math.IsNaN(v) || math.IsInf(v, 0) {
					t.Fatalf("%s: %s has non-finite coordinates", kind, n.Name)
				}
			}
			if n.X < -0.01 || n.Y < -0.01 || n.X+n.Width > res.Width+0.01 || n.Y+n.Height > res.Height+0.01 {
				t.Errorf("%s: %q falls outside the diagram (%.1f,%.1f %.1fx%.1f) in %.1fx%.1f", kind, n.Name, n.X, n.Y, n.Width, n.Height, res.Width, res.Height)
			}
		}
	}
}

func TestDeterministic(t *testing.T) {
	strip := func(src string) string {
		res, err := Render(src)
		if err != nil {
			t.Fatal(err)
		}
		var sb strings.Builder
		for _, n := range res.Nodes {
			sb.WriteString(n.Name)
			sb.WriteString(strings.Repeat(" ", 1))
			sb.WriteString(strings.TrimSpace(strings.Join([]string{ff(n.X), ff(n.Y), ff(n.Width), ff(n.Height)}, ",")))
			sb.WriteString("\n")
		}
		return sb.String()
	}
	for _, src := range []string{flowSrc, classSrc, seqSrc, stateSrc} {
		if strip(src) != strip(src) {
			t.Errorf("non-deterministic: %.30q", src)
		}
	}
}

func ff(v float64) string { return fmt.Sprintf("%.2f", v) }

func TestFlowLayoutOrder(t *testing.T) {
	fc, _ := parseFlowchart("graph TD\nA-->B\nA-->C\nB-->D\nC-->D\nA-->D\nD-->A")
	var lnodes []lnode
	for _, n := range fc.Nodes {
		w, h := flowSize(n)
		lnodes = append(lnodes, lnode{w, h})
	}
	idx := map[string]int{}
	for i, n := range fc.Nodes {
		idx[n.ID] = i
	}
	var le []ledge
	for _, e := range fc.Edges {
		le = append(le, ledge{idx[e.From], idx[e.To]})
	}
	lay := layered(lnodes, le, DirTD, nodeGap, rankGap)
	y := func(id string) float64 { return lay.Pos[idx[id]].Y }
	if !(y("A") < y("B") && y("B") < y("D") && y("B") == y("C")) {
		t.Errorf("levels: A=%v B=%v C=%v D=%v", y("A"), y("B"), y("C"), y("D"))
	}
	for i := range lnodes {
		for j := i + 1; j < len(lnodes); j++ {
			a, b := lay.Pos[i], lay.Pos[j]
			if a.X < b.X+lnodes[j].W && b.X < a.X+lnodes[i].W && a.Y < b.Y+lnodes[j].H && b.Y < a.Y+lnodes[i].H {
				t.Errorf("%s and %s overlap", fc.Nodes[i].ID, fc.Nodes[j].ID)
			}
		}
	}
}

func TestClassParse(t *testing.T) {
	cd, err := parseClass(classSrc)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]classDef{}
	for _, c := range cd.Classes {
		by[c.ID] = c
	}
	a := by["Animal"]
	if a.Annot != "abstract" || len(a.Attrs) != 2 || len(a.Methods) != 2 {
		t.Errorf("Animal = %+v", a)
	}
	if by["Duck"].Label != "Duck<T>" {
		t.Errorf("generic: %q", by["Duck"].Label)
	}
	var kinds []string
	for _, r := range cd.Rels {
		kinds = append(kinds, r.A+">"+r.B)
	}
	if len(cd.Rels) != 6 {
		t.Errorf("relations: %v", kinds)
	}
	r := cd.Rels[2]
	if r.CardA != "1" || r.CardB != "*" || r.Label != "owns" || r.Right != mArrow {
		t.Errorf("Owner→Animal = %+v", r)
	}
	if !cd.Rels[3].Dashed {
		t.Error("uses should be dashed")
	}
}

func TestClassInheritanceOnTop(t *testing.T) {
	res, err := Render("classDiagram\nAnimal <|-- Duck\nDuck --|> Bird")
	if err != nil {
		t.Fatal(err)
	}
	y := map[string]float64{}
	for _, n := range res.Nodes {
		if strings.HasPrefix(n.Name, "Class ") {
			y[strings.TrimPrefix(n.Name, "Class ")] = n.Y
		}
	}
	if !(y["Animal"] < y["Duck"] && y["Bird"] < y["Duck"]) {
		t.Errorf("the parent must be above: %v", y)
	}
}

func TestSequenceParse(t *testing.T) {
	sd, err := parseSequence(seqSrc)
	if err != nil {
		t.Fatal(err)
	}
	if len(sd.Parts) != 2 || sd.Parts[0].Label != "Alice" || !sd.Parts[1].Actor || !sd.Auto {
		t.Errorf("participants: %+v", sd.Parts)
	}
	var msgs []seqEv
	for _, e := range sd.Evs {
		if e.Kind == "msg" {
			msgs = append(msgs, e)
		}
	}
	if len(msgs) != 5 || !msgs[0].Act || !msgs[1].Deact || !msgs[1].Dashed || msgs[2].Head != HeadOpen || msgs[4].Head != HeadCross {
		t.Errorf("messages: %+v", msgs)
	}
	for _, bad := range []string{"sequenceDiagram\nA->>B: x\nend", "sequenceDiagram\nloop x\nA->>B: y", "sequenceDiagram\nblah"} {
		if _, err := parseSequence(bad); err == nil {
			t.Errorf("%q should have failed", bad)
		}
	}
}

func TestSequenceOrderAndWidth(t *testing.T) {
	res, err := Render("sequenceDiagram\nA->>B: one\nB->>C: a very very long message here\nC->>A: three")
	if err != nil {
		t.Fatal(err)
	}
	ys := map[string]float64{}
	for _, n := range res.Nodes {
		if strings.HasPrefix(n.Name, "Message ") {
			ys[n.Name] = n.Y
		}
	}
	if !(ys["Message one"] < ys["Message a very very long message here"] && ys["Message a very very long message here"] < ys["Message three"]) {
		t.Errorf("the messages must go down: %v", ys)
	}
}

func TestStateParse(t *testing.T) {
	fc, err := parseState(stateSrc)
	if err != nil {
		t.Fatal(err)
	}
	shapes := map[fShape]int{}
	for _, n := range fc.Nodes {
		shapes[n.Shape]++
	}
	if shapes[fStart] != 1 || shapes[fEnd] != 1 || shapes[fDiamond] != 1 {
		t.Errorf("shapes: %v", shapes)
	}
	var long flowNode
	for _, n := range fc.Nodes {
		if n.ID == "Long" {
			long = n
		}
	}
	if long.Label != "A long name\ndescription" {
		t.Errorf("Long = %q", long.Label)
	}
}

func TestLimitsAndErrors(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("graph TD\n")
	for i := 0; i < MaxNodes+1; i++ {
		sb.WriteString("N")
		sb.WriteString(strings.Repeat("a", 1))
		sb.WriteString(itoa(i))
		sb.WriteString("\n")
	}
	if _, err := Render(sb.String()); err == nil {
		t.Error("too many nodes should fail")
	}
	if _, err := Render(strings.Repeat("A-->B\n", 20000)); err == nil {
		t.Error("text that is too long should fail")
	}
	_, err := Render("erDiagram\nA ||--o{ B : has")
	var de *Error
	if err == nil || !asErr(err, &de) {
		t.Errorf("expected an error of type *Error, found %v", err)
	}
}

func itoa(i int) string               { return fmt.Sprint(i) }
func asErr(err error, t **Error) bool { return errors.As(err, t) }
