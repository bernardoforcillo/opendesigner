package mcp_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// webFile reads a file of the editor's source (the tests run in internal/mcp).
func webFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "web", "src", rel))
	if err != nil {
		t.Fatalf("reading web/src/%s: %v", rel, err)
	}
	return string(b)
}

func quoted(list string) []string {
	var out []string
	for _, m := range regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(list, -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

func sameStrings(t *testing.T, what string, got, want []string) {
	t.Helper()
	g, w := append([]string{}, got...), append([]string{}, want...)
	sort.Strings(g)
	sort.Strings(w)
	if strings.Join(g, ",") != strings.Join(w, ",") {
		t.Errorf("%s drifted from the editor: MCP says %v, the editor has %v", what, g, w)
	}
}

func constOf(t *testing.T, src, name string) int {
	t.Helper()
	m := regexp.MustCompile(`export const ` + name + ` = ([0-9_]+|1 << 20|16 \* 1024);`).FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("constant %s not found", name)
	}
	switch m[1] {
	case "1 << 20":
		return 1 << 20
	case "16 * 1024":
		return 16 * 1024
	}
	n, err := strconv.Atoi(strings.ReplaceAll(m[1], "_", ""))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestPluginAPIDescriptionMatchesTheEditor is the drift guard: the catalogue the tool returns is read
// against the editor's own source, so a new od method, permission, limit or language fails here.
func TestPluginAPIDescriptionMatchesTheEditor(t *testing.T) {
	s := &odmcp.Session{}
	api, err := s.DescribePluginAPI(context.Background(), struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	src := webFile(t, "plugins/api.ts")
	sets := regexp.MustCompile(`const (READ|WRITE) = new Set\(\[([^\]]*)\]\)`).FindAllStringSubmatch(src, -1)
	if len(sets) != 2 {
		t.Fatalf("found %d method sets in api.ts, want READ and WRITE", len(sets))
	}
	perm := map[string]string{"notify": "none"}
	var editor []string
	for _, m := range sets {
		for _, name := range quoted(m[2]) {
			perm[name] = strings.ToLower(m[1])
			editor = append(editor, name)
		}
	}
	editor = append(editor, "notify")
	sameStrings(t, "the od method list", api.MethodNames, editor)
	for _, m := range api.Methods {
		if perm[m.Name] != m.Permission {
			t.Errorf("od.%s: MCP says permission %q, the editor %q", m.Name, m.Permission, perm[m.Name])
		}
	}
	settable := regexp.MustCompile(`const SETTABLE[^{]*\{([\s\S]*?)\n\};`).FindStringSubmatch(src)
	if settable == nil {
		t.Fatal("SETTABLE not found in api.ts")
	}
	var keys []string
	for _, m := range regexp.MustCompile(`(?m)^  (\w+): \(v\)`).FindAllStringSubmatch(settable[1], -1) {
		keys = append(keys, m[1])
	}
	sameStrings(t, "the setProps keys", api.SetProps, keys)

	manifest := webFile(t, "plugins/manifest.ts")
	perms := regexp.MustCompile(`const PERMISSIONS: readonly Permission\[\] = \[([^\]]*)\]`).FindStringSubmatch(manifest)
	if perms == nil {
		t.Fatal("PERMISSIONS not found in manifest.ts")
	}
	sameStrings(t, "the permissions", api.Manifest.Permissions, quoted(perms[1]))
	if got := constOf(t, manifest, "MAX_CODE_BYTES"); got != api.Manifest.MaxCodeSize {
		t.Errorf("max code size: MCP %d, editor %d", api.Manifest.MaxCodeSize, got)
	}
	if got := constOf(t, webFile(t, "plugins/run.ts"), "PLUGIN_TIMEOUT_MS"); got != api.Manifest.TimeoutMs {
		t.Errorf("plugin timeout: MCP %d, editor %d", api.Manifest.TimeoutMs, got)
	}
	wasm := webFile(t, "plugins/wasm.ts")
	joined := strings.Join(api.Wasm.Limits, " ")
	for name, want := range map[string]int{"WASM_MAX_BYTES": 1 << 20, "WASM_MAX_PAGES": 64, "IO_MAX": 16 * 1024, "MAX_COMMANDS": 1000} {
		if got := constOf(t, wasm, name); got != want {
			t.Errorf("%s is %d in the editor, the description assumes %d", name, got, want)
		}
		if !strings.Contains(joined, strconv.Itoa(want)) {
			t.Errorf("the wasm limits do not mention %s = %d: %s", name, want, joined)
		}
	}
	if !strings.Contains(api.EditorOnly, "editor") {
		t.Error("the description does not say plugins are editor-only")
	}
	if !strings.Contains(webFile(t, "plugins/manifest.ts"), "EXAMPLE_PLUGIN") {
		t.Error("manifest.ts lost EXAMPLE_PLUGIN")
	}
	if code, _ := api.Example["code"].(string); !strings.Contains(webFile(t, "plugins/manifest.ts"), "od.setProps(id, { name: String(i++) })") || !strings.Contains(code, "od.setProps(id, { name: String(i++) })") {
		t.Error("the example plugin drifted from EXAMPLE_PLUGIN")
	}
}

func TestUILanguagesMatchTheEditor(t *testing.T) {
	s := &odmcp.Session{}
	out, err := s.ListUILanguages(context.Background(), struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	rows := regexp.MustCompile(`\{ code: "([^"]+)", name: "([^"]+)", draft: (true|false) \}`).FindAllStringSubmatch(webFile(t, "i18n/index.ts"), -1)
	if len(rows) == 0 || len(rows) != len(out.Languages) {
		t.Fatalf("the editor lists %d languages, MCP %d", len(rows), len(out.Languages))
	}
	for i, r := range rows {
		l := out.Languages[i]
		if l.Code != r[1] || l.Name != r[2] || l.Draft != (r[3] == "true") {
			t.Errorf("language %d: MCP %+v, editor %v", i, l, r[1:])
		}
	}
	if !strings.Contains(out.Note, "cannot switch") {
		t.Error("the note does not say MCP cannot switch the language")
	}
}

func TestValidatePlugin(t *testing.T) {
	s := &odmcp.Session{}
	check := func(plugin map[string]any) odmcp.ValidatePluginOutput {
		t.Helper()
		b, _ := json.Marshal(plugin)
		out, err := s.ValidatePlugin(context.Background(), odmcp.ValidatePluginInput{Plugin: string(b)})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	api, _ := s.DescribePluginAPI(context.Background(), struct{}{})
	if out := check(api.Example); !out.Valid || strings.Join(out.Uses, ",") != "notify,selection,setProps" {
		t.Errorf("the example plugin = %+v", out)
	}
	bad := map[string]map[string]any{
		"no name":            {"code": "od.selection()"},
		"no code":            {"name": "x"},
		"unknown permission": {"name": "x", "code": "1", "permissions": []string{"admin"}},
		"unknown method":     {"name": "x", "code": "od.explode()", "permissions": []string{"read"}},
		"write without perm": {"name": "x", "code": "od.deleteNode('a')"},
		"bad wasm":           {"name": "x", "wasm": "!!!"},
		"empty wasm":         {"name": "x", "wasm": ""},
	}
	for name, p := range bad {
		if out := check(p); out.Valid || len(out.Errors) == 0 {
			t.Errorf("%s was accepted: %+v", name, out)
		}
	}
	if out, _ := s.ValidatePlugin(context.Background(), odmcp.ValidatePluginInput{Plugin: "{"}); out.Valid {
		t.Error("broken JSON was accepted")
	}
	if out := check(map[string]any{"name": "w", "wasm": "AGFzbQEAAAA="}); !out.Valid || len(out.Warnings) == 0 {
		t.Errorf("a base64 module should pass with a warning that the editor checks the binary: %+v", out)
	}
	if out := check(map[string]any{"name": "reader", "code": "const a = await od.page(); od.notify('x')"}); !out.Valid {
		t.Errorf("a read-only plugin with the default permissions was refused: %+v", out)
	}
}
