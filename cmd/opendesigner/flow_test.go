package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

// seedDoc scrive nel workspace un documento con un flusso Home -> Login ->
// Fine (e, se broken, una schermata orfana), come farebbe `serve`.
func seedDoc(t *testing.T, ws, id, name string, broken bool) {
	t.Helper()
	b, err := store.Open(ws, id, name)
	if err != nil {
		t.Fatal(err)
	}
	var seq uint64
	add := func(op *opendesignerv1.Op) {
		seq++
		op.OpId = "op" + string(rune('a'+seq))
		if err := b.Append(&opendesignerv1.OpRecord{Seq: seq, Op: op}); err != nil {
			t.Fatal(err)
		}
	}
	node := func(nid, nname string, meta map[string]string) {
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
			Id: nid, ParentId: "page1", OrderKey: "a" + nid, Name: nname, Visible: true, Opacity: 1, Meta: meta,
		}}}})
	}
	node("home", "Home", map[string]string{"code.route": "/", "code.component": "HomePage"})
	node("login", "Login", map[string]string{"code.route": "/login"})
	node("fine", "Fine", map[string]string{"flow.kind": "end", "status": "implemented"})
	if broken {
		node("orfana", "Orfana", nil)
	}
	add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: &opendesignerv1.Flow{Id: "f1", Name: "Accesso", StartId: "home"}}}})
	tr := func(tid, from, to, label string) {
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: &opendesignerv1.Transition{
			Id: tid, FlowId: "f1", FromId: from, ToId: to, Label: label, Trigger: "click",
		}}}})
	}
	tr("t1", "home", "login", "Accedi")
	tr("t2", "login", "fine", "Entra")
	if broken {
		tr("t3", "orfana", "fine", "Boh")
	}
}

func runCLI(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var o, e bytes.Buffer
	code = runFlow(args, &o, &e)
	return code, o.String(), e.String()
}

func TestFlowCLICheck(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "doc-ok", "Sano", false)

	code, out, errOut := runCLI(t, "check", "-workspace", ws)
	if code != 0 || !strings.Contains(out, "OK: 1 flussi senza problemi") {
		t.Fatalf("code=%d out=%q err=%q", code, out, errOut)
	}

	seedDoc(t, ws, "doc-rotto", "Rotto", true)
	// Due documenti: -doc diventa obbligatorio.
	if code, _, errOut = runCLI(t, "check", "-workspace", ws); code != 2 || !strings.Contains(errOut, "indica -doc") {
		t.Fatalf("senza -doc: code=%d err=%q", code, errOut)
	}
	code, out, _ = runCLI(t, "check", "-workspace", ws, "-doc", "Rotto")
	if code != 1 || !strings.Contains(out, "[unreachable] Accesso") || !strings.Contains(out, `"Orfana"`) {
		t.Fatalf("check rotto: code=%d out=%q", code, out)
	}
	// Per id, in JSON.
	code, out, _ = runCLI(t, "check", "-workspace", ws, "-doc", "doc-rotto", "-format", "json")
	if code != 1 {
		t.Fatalf("code = %d", code)
	}
	var parsed struct {
		Reports []struct {
			Issues []struct{ Kind string }
		}
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil || len(parsed.Reports) != 1 || len(parsed.Reports[0].Issues) == 0 {
		t.Fatalf("json = %q err=%v", out, err)
	}
	// Flusso e documento sconosciuti.
	if code, _, errOut = runCLI(t, "check", "-workspace", ws, "-doc", "doc-ok", "-flow", "nope"); code != 2 || !strings.Contains(errOut, "non esiste") {
		t.Errorf("flusso sconosciuto: code=%d err=%q", code, errOut)
	}
	if code, _, errOut = runCLI(t, "check", "-workspace", ws, "-doc", "boh"); code != 2 || !strings.Contains(errOut, "non trovato") {
		t.Errorf("doc sconosciuto: code=%d err=%q", code, errOut)
	}
}

func TestFlowCLISpecTestsOut(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "d1", "Unico", false)

	code, out, _ := runCLI(t, "spec", "-workspace", ws)
	if code != 0 || !strings.Contains(out, "## Flusso: Accesso") {
		t.Fatalf("spec: code=%d out=%q", code, out)
	}
	file := filepath.Join(t.TempDir(), "flows.spec.ts")
	code, out, errOut := runCLI(t, "tests", "-workspace", ws, "-out", file)
	if code != 0 || out != "" || !strings.Contains(errOut, "scritto") {
		t.Fatalf("tests: code=%d out=%q err=%q", code, out, errOut)
	}
	data, err := os.ReadFile(file)
	if err != nil || !strings.Contains(string(data), "from '@playwright/test'") || !strings.Contains(string(data), "// flow:t1") {
		t.Fatalf("file = %q err=%v", data, err)
	}
	// La lettura offline non ha modificato il workspace: nessuna cartella nuova.
	entries, _ := os.ReadDir(ws)
	if len(entries) != 1 {
		t.Errorf("workspace modificato: %v", entries)
	}
}

func TestFlowCLICoverageAndTasks(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "d1", "Unico", false)
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, "App.tsx"), []byte(`<Route path="/login" />`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "a.spec.ts"), []byte("// flow:t1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Implementate: login (codice) + fine (meta) = 2/3; testate 1/2 -> 3/5 = 60%.
	code, out, errOut := runCLI(t, "coverage", "-workspace", ws, "-repo", repo, "-format", "json")
	if code != 0 {
		t.Fatalf("code=%d err=%q", code, errOut)
	}
	var cov struct {
		Totals struct{ Percent float64 }
	}
	if err := json.Unmarshal([]byte(out), &cov); err != nil || cov.Totals.Percent != 60 {
		t.Fatalf("coverage json = %q err=%v", out, err)
	}
	if code, _, _ = runCLI(t, "coverage", "-workspace", ws, "-repo", repo, "-min", "60"); code != 0 {
		t.Errorf("-min 60 con 60%%: code=%d", code)
	}
	code, out, errOut = runCLI(t, "coverage", "-workspace", ws, "-repo", repo, "-min", "80")
	if code != 1 || !strings.Contains(errOut, "sotto la soglia") || !strings.Contains(out, "# Coverage dei flussi") {
		t.Errorf("-min 80: code=%d out=%q err=%q", code, out, errOut)
	}
	code, out, _ = runCLI(t, "tasks", "-workspace", ws, "-repo", repo)
	if code != 0 || !strings.Contains(out, "Implementare la schermata **Home**") || !strings.Contains(out, "flow:t2") {
		t.Errorf("tasks: code=%d out=%q", code, out)
	}
	if code, _, errOut = runCLI(t, "coverage", "-workspace", ws, "-repo", filepath.Join(repo, "nope")); code != 2 {
		t.Errorf("repo inesistente: code=%d err=%q", code, errOut)
	}
}

func TestFlowCLIUsage(t *testing.T) {
	if code, _, errOut := runCLI(t); code != 2 || !strings.Contains(errOut, "uso:") {
		t.Errorf("senza argomenti: %d %q", code, errOut)
	}
	if code, _, errOut := runCLI(t, "boh"); code != 2 || !strings.Contains(errOut, "sconosciuto") {
		t.Errorf("sottocomando: %d %q", code, errOut)
	}
	if code, _, _ := runCLI(t, "check", "-format", "xml"); code != 2 {
		t.Errorf("formato: %d", code)
	}
	if code, _, errOut := runCLI(t, "check", "-workspace", t.TempDir()); code != 2 || !strings.Contains(errOut, "nessun documento") {
		t.Errorf("workspace vuoto: %d %q", code, errOut)
	}
}
