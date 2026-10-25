package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// PLUGINS and LANGUAGE are editor-only, and these tools are honest about it. A plugin is a script (or a
// WebAssembly module) that runs in a sandboxed iframe / Worker in the PERSON'S BROWSER and edits the open
// document through a narrow bridge, as one undo step; plugins are kept in that browser (localStorage), not
// in the document. The interface language is also a per-person browser setting. There is nothing for the
// server to run or switch, so MCP cannot "run a plugin" or "change the language" and does not pretend to.
//
// What an agent CAN do is write a plugin file for a person to install (Document menu -> Plugins...), so
// these tools return the API surface and the manifest rules, and check a plugin file the way the editor
// will. The catalogue below mirrors web/src/plugins (api.ts, manifest.ts, run.ts, wasm.ts) and
// web/src/i18n/index.ts; pluginapi_test.go reads those files and fails when they drift apart.

const pluginsEditorOnly = "Plugins run only in the editor, in the person's browser sandbox: install the file through Document menu > Plugins... Nothing in MCP runs a plugin."

// Plugin limits (web/src/plugins/manifest.ts, run.ts, wasm.ts).
const (
	pluginMaxCodeBytes  = 200_000
	pluginTimeoutMillis = 15_000
	pluginWasmMaxBytes  = 1 << 20
	pluginWasmMaxPages  = 64
	pluginWasmIOMax     = 16 * 1024
	pluginWasmMaxCmds   = 1000
	pluginWasmTimeoutMs = 5_000
)

// PluginMethod is one function of the `od` object a plugin script receives.
type PluginMethod struct {
	Name       string `json:"name"`
	Permission string `json:"permission" jsonschema:"read | write | none (always allowed)"`
	Signature  string `json:"signature"`
	Returns    string `json:"returns"`
	Notes      string `json:"notes,omitempty"`
}

// PluginAPIOutput is the plugin surface.
type PluginAPIOutput struct {
	EditorOnly  string            `json:"editorOnly"`
	Manifest    PluginManifestDoc `json:"manifest"`
	Methods     []PluginMethod    `json:"methods"`
	Sandbox     []string          `json:"sandbox" jsonschema:"what a plugin run can and cannot do"`
	Wasm        PluginWasmDoc     `json:"wasm"`
	NodeView    map[string]string `json:"nodeView" jsonschema:"the fields of the node object getNode / listNodes / create* / setProps return"`
	SetProps    []string          `json:"setPropsKeys" jsonschema:"the only keys od.setProps accepts"`
	Example     map[string]any    `json:"example" jsonschema:"a complete plugin file"`
	MethodNames []string          `json:"methodNames"`
}

// PluginManifestDoc describes the plugin JSON file.
type PluginManifestDoc struct {
	Fields      map[string]string `json:"fields"`
	Permissions []string          `json:"permissions" jsonschema:"the only permissions: read (inspect the document) and write (edit it); the default is [read]"`
	MaxCodeSize int               `json:"maxCodeBytes"`
	TimeoutMs   int               `json:"timeoutMs" jsonschema:"a run that takes longer is stopped and nothing is kept"`
}

// PluginWasmDoc summarises the WebAssembly plugin ABI.
type PluginWasmDoc struct {
	Summary     string   `json:"summary"`
	Exports     []string `json:"exports"`
	Limits      []string `json:"limits"`
	CommandForm string   `json:"commandForm"`
}

var pluginMethods = []PluginMethod{
	{"selection", "read", "od.selection()", "array of node ids", "the editor's current selection"},
	{"page", "read", "od.page()", "{id, pages}", "the current page's id and the list of pages"},
	{"getNode", "read", "od.getNode(id)", "node object", "throws when there is no such layer"},
	{"listNodes", "read", "od.listNodes(parentId?)", "array of node objects, bottom to top", "children of parentId (a page or a node); the current page by default"},
	{"createRect", "write", "od.createRect({x, y, width, height, fill, name, parentId, cornerRadius})", "node object", "defaults: 0,0, 100x100, a grey fill, the current page; fill is {r,g,b,a} with values 0..1"},
	{"createEllipse", "write", "od.createEllipse({x, y, width, height, fill, name, parentId})", "node object", ""},
	{"createFrame", "write", "od.createFrame({x, y, width, height, fill, name, parentId})", "node object", "no fill unless given"},
	{"createText", "write", "od.createText({text, fontSize, x, y, width, height, fill, name, parentId})", "node object", "text up to 2000 characters; defaults 200x24, fontSize 16, black"},
	{"setProps", "write", "od.setProps(id, {x, y, width, height, rotation, opacity, name, visible, fill})", "node object (after the change)", "any other key is refused"},
	{"deleteNode", "write", "od.deleteNode(id)", "null", "deletes the node and its subtree"},
	{"select", "write", "od.select(ids)", "null", "ids that do not exist are ignored"},
	{"notify", "none", "od.notify(message)", "null", "shows a message to the person (up to 300 characters)"},
}

// pluginSurface builds the document of describe_plugin_api.
func pluginSurface() PluginAPIOutput {
	var names []string
	for _, m := range pluginMethods {
		names = append(names, m.Name)
	}
	return PluginAPIOutput{
		EditorOnly: pluginsEditorOnly,
		Manifest: PluginManifestDoc{
			Fields: map[string]string{
				"name":        "required, 1..80 characters",
				"version":     "optional text (kept to 20 characters), default 0.0.0",
				"description": "optional text (kept to 300 characters)",
				"permissions": "optional array of \"read\" and/or \"write\"; default [\"read\"]",
				"code":        "the BODY of an async function that receives `od` (so `await` works at the top level and `return` ends the run); required unless `wasm` is given",
				"wasm":        "instead of code: a WebAssembly module in base64",
			},
			Permissions: []string{"read", "write"},
			MaxCodeSize: pluginMaxCodeBytes,
			TimeoutMs:   pluginTimeoutMillis,
		},
		Methods:     pluginMethods,
		MethodNames: names,
		Sandbox: []string{
			"Runs in an iframe with sandbox=\"allow-scripts\" only: an opaque origin, no access to the editor, its storage or cookies.",
			"A content-security policy forbids every network request; the only way out is the od bridge.",
			"Every od call is validated and checked against the plugin's declared permissions.",
			"Everything a run writes goes in as ordinary ops inside ONE undo step; if the script throws or takes longer than the timeout, nothing is kept.",
			"Plugins are stored in the person's browser (localStorage), never in the document, and are not shared between people or devices.",
		},
		Wasm: PluginWasmDoc{
			Summary: "A WebAssembly plugin is a pure function from a JSON snapshot {selection, page} (given only with the read permission) to a JSON list of commands. It may import nothing.",
			Exports: []string{"memory", "od_input() -> i32", "od_output() -> i32", "od_run(n: i32) -> i32 (the answer's length in bytes, or a negative error code)"},
			Limits: []string{
				fmt.Sprintf("module at most %d bytes; memory must declare a maximum of at most %d pages (4 MiB)", pluginWasmMaxBytes, pluginWasmMaxPages),
				fmt.Sprintf("input and output regions at most %d bytes each", pluginWasmIOMax),
				fmt.Sprintf("at most %d commands per run; the Worker is terminated after %d ms", pluginWasmMaxCmds, pluginWasmTimeoutMs),
			},
			CommandForm: `[{"method": "createRect", "args": [{"x": 0, "y": 0}]}, ...] -- each command goes through the same bridge, permissions and validation as a script's od.* call`,
		},
		NodeView: map[string]string{
			"id": "string", "name": "string", "type": "rect | ellipse | polygon | star | text | image | vector | group | frame | instance | unknown",
			"parentId": "string", "x": "number", "y": "number", "width": "number", "height": "number", "rotation": "degrees", "opacity": "0..1", "visible": "boolean",
			"fill": "{r,g,b,a} of the first solid fill, or null", "text": "content, text nodes only",
		},
		SetProps: []string{"x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fill"},
		Example: map[string]any{
			"name": "Number the selection", "version": "1.0.0",
			"description": "Renames the selected layers 1, 2, 3 in the order they sit in the layers panel.",
			"permissions": []string{"read", "write"},
			"code":        "const ids = await od.selection();\nif (ids.length === 0) { od.notify('Select some layers first.'); return; }\nlet i = 1;\nfor (const id of ids) await od.setProps(id, { name: String(i++) });\nod.notify('Numbered ' + ids.length + ' layers.');",
		},
	}
}

// DescribePluginAPI returns the plugin surface (read-only, static).
func (s *Session) DescribePluginAPI(ctx context.Context, _ struct{}) (PluginAPIOutput, error) {
	return pluginSurface(), nil
}

// UILanguage is one language of the editor's interface.
type UILanguage struct {
	Code  string `json:"code"`
	Name  string `json:"name" jsonschema:"the language's own name"`
	Draft bool   `json:"draft" jsonschema:"a machine draft that no native speaker has reviewed"`
}

// UILanguagesOutput lists the interface languages.
type UILanguagesOutput struct {
	Languages []UILanguage `json:"languages"`
	Note      string       `json:"note"`
}

// uiLanguages mirrors web/src/i18n/index.ts::LANGUAGES.
var uiLanguages = []UILanguage{
	{"en", "English", false},
	{"es", "Español", true},
	{"fr", "Français", true},
	{"de", "Deutsch", true},
	{"it", "Italiano", true},
	{"pt-BR", "Português (Brasil)", true},
	{"ja", "日本語", true},
	{"zh-Hans", "简体中文", true},
}

// ListUILanguages lists the languages the editor's interface can show.
func (s *Session) ListUILanguages(ctx context.Context, _ struct{}) (UILanguagesOutput, error) {
	return UILanguagesOutput{
		Languages: uiLanguages,
		Note:      "The interface language is a per-person setting kept in the browser (Document menu > Language, or the language box on the Home; `system` follows the browser). It is not part of the document and MCP cannot switch it. Document content (names, text) is never translated.",
	}, nil
}

// ValidatePluginInput is a plugin file's text.
type ValidatePluginInput struct {
	Plugin string `json:"plugin" jsonschema:"the plugin file's JSON text"`
}

// ValidatePluginOutput is the verdict.
type ValidatePluginOutput struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty" jsonschema:"why the editor would refuse the file"`
	Warnings []string `json:"warnings,omitempty"`
	Uses     []string `json:"uses,omitempty" jsonschema:"the od methods the code calls (found by scanning for od.name)"`
}

var odCall = regexp.MustCompile(`\bod\.([A-Za-z_]\w*)`)

// ValidatePlugin checks a plugin file against the same rules as the editor's installer
// (manifest.ts::parsePlugin) and, for a script, that the od methods it calls exist and are covered by
// its permissions. It cannot run the plugin; the WebAssembly module itself is only checked for being
// base64 and not too big -- the editor validates its binary at install time.
func (s *Session) ValidatePlugin(ctx context.Context, in ValidatePluginInput) (ValidatePluginOutput, error) {
	out := ValidatePluginOutput{}
	fail := func(msg string) (ValidatePluginOutput, error) {
		out.Errors = append(out.Errors, msg)
		return out, nil
	}
	var raw any
	if err := json.Unmarshal([]byte(in.Plugin), &raw); err != nil {
		return fail("That is not valid JSON.")
	}
	o, ok := raw.(map[string]any)
	if !ok {
		return fail("A plugin is a JSON object.")
	}
	name, _ := o["name"].(string)
	if n := utf8.RuneCountInString(strings.TrimSpace(name)); n == 0 || n > 80 {
		out.Errors = append(out.Errors, "A plugin needs a name (up to 80 characters).")
	}
	perms := []string{"read"}
	if p, present := o["permissions"]; present {
		arr, isArr := p.([]any)
		perms = nil
		okPerms := isArr
		for _, v := range arr {
			str, isStr := v.(string)
			if !isStr || (str != "read" && str != "write") {
				okPerms = false
				break
			}
			perms = append(perms, str)
		}
		if !okPerms {
			out.Errors = append(out.Errors, "`permissions` can only contain \"read\" and \"write\".")
			perms = nil
		}
	}
	has := map[string]bool{}
	for _, p := range perms {
		has[p] = true
	}
	if w, isWasm := o["wasm"]; isWasm {
		text, _ := w.(string)
		bytes, err := base64.StdEncoding.DecodeString(text)
		switch {
		case err != nil:
			out.Errors = append(out.Errors, "`wasm` must be the module in base64.")
		case len(bytes) == 0:
			out.Errors = append(out.Errors, "The WebAssembly module was refused: it is empty.")
		case len(bytes) > pluginWasmMaxBytes:
			out.Errors = append(out.Errors, fmt.Sprintf("The WebAssembly module was refused: it is over %d bytes.", pluginWasmMaxBytes))
		default:
			out.Warnings = append(out.Warnings, "The module's contents (exports, imports, memory maximum) are checked by the editor when the plugin is installed, not here.")
		}
	} else {
		code, isStr := o["code"].(string)
		switch {
		case !isStr || strings.TrimSpace(code) == "":
			out.Errors = append(out.Errors, "A plugin needs `code`.")
		case len(code) > pluginMaxCodeBytes:
			out.Errors = append(out.Errors, "The plugin's code is too long.")
		default:
			known := map[string]string{}
			for _, m := range pluginMethods {
				known[m.Name] = m.Permission
			}
			seen := map[string]bool{}
			for _, m := range odCall.FindAllStringSubmatch(code, -1) {
				if seen[m[1]] {
					continue
				}
				seen[m[1]] = true
				out.Uses = append(out.Uses, m[1])
				need, exists := known[m[1]]
				switch {
				case !exists:
					out.Errors = append(out.Errors, fmt.Sprintf("od.%s is not a method (describe_plugin_api lists them).", m[1]))
				case need != "none" && !has[need]:
					out.Errors = append(out.Errors, fmt.Sprintf("od.%s needs the \"%s\" permission, which the plugin does not declare.", m[1], need))
				}
			}
			sort.Strings(out.Uses)
		}
	}
	out.Valid = len(out.Errors) == 0
	return out, nil
}

func registerPluginTools(srv *mcp.Server, s *Session) {
	addTool(srv, "describe_plugin_api", "Describe the plugin API so you can WRITE a plugin file: the manifest fields and permissions (read, write), every od.* method with its arguments, the sandbox rules, the WebAssembly ABI and a full example. Read-only. "+pluginsEditorOnly, s.DescribePluginAPI)
	addTool(srv, "validate_plugin", "Check a plugin file (its JSON text) the way the editor's installer will, and that a script only calls od methods that exist and that its permissions cover. It does not run the plugin. "+pluginsEditorOnly, s.ValidatePlugin)
	addTool(srv, "list_ui_languages", "List the languages the editor's interface can be shown in (code, own name, whether the catalog is a machine draft). The language is a per-person browser setting, not part of the document: MCP can list it but cannot switch it.", s.ListUILanguages)
}
