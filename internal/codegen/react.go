package codegen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
)

// Target react: a Vite + React + TypeScript + Tailwind v4 +
// react-router-dom project. Each screen is a `src/screens/<Name>.tsx` component
// with Tailwind classes; `src/App.tsx` mounts the routes; `tests/flows.spec.ts`
// holds the Playwright tests from internal/flow, which find elements by
// data-testid / text / role EXACTLY as this renderer writes them (see writeJSX).

// Package versions: the current majors at the time of writing. They are
// carets, so `npm install` picks up the latest compatible minor.
const (
	verReact       = "^19.0.0"
	verRouter      = "^7.0.0"
	verVite        = "^8.0.0"
	verPluginReact = "^6.0.0"
	verTailwind    = "^4.0.0"
	verTypeScript  = "^7.0.0"
	verPlaywright  = "^1.60.0"
	verTypesReact  = "^19.0.0"
	verTypesNode   = "^22.0.0"
	verMotion      = "^14.0.0"
)

// tsString quotes a string as a TypeScript literal (JSON escaping, without the
// HTML escaping that json.Marshal applies by default).
func tsString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(buf.String(), "\n")
}

func tsHeader(d *opendesignerv1.Document, what string) string {
	return "// " + strings.ReplaceAll(generatedHeader(d, what), "\n", "\n// ") + "\n"
}

func renderReact(d *opendesignerv1.Document, screens []*Screen, opts Options, files map[string][]byte, warnings *[]string) error {
	put := func(path, content string) { files[path] = []byte(content) }

	pkgName := slug(d.GetName())
	// Motion only if the document has animations to export: an export without
	// clips stays identical to before (and without one more dependency).
	hasAnim := false
	for _, s := range screens {
		if len(collectAnimated(s.Root)) > 0 {
			hasAnim = true
		}
	}
	motionDep := ""
	if hasAnim {
		motionDep = fmt.Sprintf("\n    \"motion\": %q,", verMotion)
	}
	put("package.json", fmt.Sprintf(`{
  "name": %s,
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "playwright test"
  },
  "dependencies": {%s
    "react": %q,
    "react-dom": %q,
    "react-router-dom": %q
  },
  "devDependencies": {
    "@playwright/test": %q,
    "@tailwindcss/vite": %q,
    "@types/node": %q,
    "@types/react": %q,
    "@types/react-dom": %q,
    "@vitejs/plugin-react": %q,
    "tailwindcss": %q,
    "typescript": %q,
    "vite": %q
  }
}
`, tsString(pkgName), motionDep, verReact, verReact, verRouter, verPlaywright, verTailwind, verTypesNode, verTypesReact, verTypesReact, verPluginReact, verTailwind, verTypeScript, verVite))

	put("index.html", fmt.Sprintf(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>%s</title>
    <!-- %s -->
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`, escapeHTML(d.GetName()), generatedHeader(d, "app skeleton")))

	put("vite.config.ts", tsHeader(d, "Vite configuration")+`import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`)

	put("tsconfig.json", `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "tests", "vite.config.ts", "playwright.config.ts"]
}
`)

	put("playwright.config.ts", tsHeader(d, "Playwright configuration")+`import { defineConfig, devices } from "@playwright/test";

// The Vite dev server starts on its own; PW_CHROMIUM_PATH (optional) points to a
// Chromium that is already installed instead of the one downloaded by Playwright.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
`)

	put(".gitignore", "node_modules\ndist\ntest-results\nplaywright-report\n")
	put("src/vite-env.d.ts", "/// <reference types=\"vite/client\" />\n")
	put("src/index.css", `/* `+strings.ReplaceAll(generatedHeader(d, "global styles"), "\n", "\n   ")+` */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
@import "tailwindcss";
`)
	put("src/main.tsx", tsHeader(d, "entry point")+`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`)

	// App.tsx: one route per screen; "/" leads to the start screen of the
	// first flow that has one (otherwise to the first screen).
	home := screens[0]
	for _, f := range selectedFlows(d, opts.FlowID) {
		if s := d.GetFlows()[f].GetStartId(); s != "" {
			for _, sc := range screens {
				if sc.NodeID == s {
					home = sc
				}
			}
			break
		}
	}
	var app strings.Builder
	app.WriteString(tsHeader(d, "app routes"))
	app.WriteString("import { BrowserRouter, Route, Routes } from \"react-router-dom\";\n")
	for _, s := range screens {
		fmt.Fprintf(&app, "import { %s } from \"./screens/%s\";\n", s.Name, s.Name)
	}
	app.WriteString("\nexport default function App() {\n  return (\n    <BrowserRouter>\n      <Routes>\n")
	if home.Route != "/" {
		fmt.Fprintf(&app, "        {/* start screen: also mounted on \"/\" */}\n        <Route path=\"/\" element={<%s />} />\n", home.Name)
	}
	for _, s := range screens {
		fmt.Fprintf(&app, "        <Route path=%s element={<%s />} />\n", tsString(s.Route), s.Name)
	}
	app.WriteString("      </Routes>\n    </BrowserRouter>\n  );\n}\n")
	put("src/App.tsx", app.String())

	for _, s := range screens {
		code, w := reactScreen(d, s)
		*warnings = append(*warnings, w...)
		put("src/screens/"+s.Name+".tsx", code)
	}

	// Playwright tests of the flows (internal/flow): `code.route` has already been
	// completed on the document copy by assignNames.
	hasFlows := len(selectedFlows(d, opts.FlowID)) > 0
	if hasFlows {
		spec, err := flow.PlaywrightTests(d, opts.FlowID, flow.PlaywrightOptions{})
		if err != nil {
			return err
		}
		put("tests/flows.spec.ts", spec)
	}

	put("README.md", reactReadme(d, screens, opts, hasFlows, home, hasAnim))
	return nil
}

func escapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;").Replace(s)
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

type jsxWriter struct {
	sb strings.Builder
}

func reactScreen(d *opendesignerv1.Document, s *Screen) (string, []string) {
	animCode, warns := reactAnimations(s.Root)
	// What the component needs: navigate (at least one wiring with a destination)
	// and effect (keys).
	needNavigate, needEffect := false, false
	s.Root.walk(func(e *Element) {
		for _, t := range e.Triggers {
			if t.Dest != nil || t.Kind == "back" {
				needNavigate = true
			}
		}
	})
	for _, t := range s.Root.NavTriggers {
		if t.Kind != "auto" && (t.Dest != nil || t.Kind == "back") {
			needNavigate = true
		}
	}
	for _, t := range s.Root.KeyTriggers {
		if t.Dest != nil {
			needNavigate, needEffect = true, true
		}
	}

	var b strings.Builder
	b.WriteString(tsHeader(d, "screen \""+oneLine(d.GetNodes()[s.NodeID].GetName())+"\" (route "+s.Route+")"))
	if needEffect {
		b.WriteString("import { useEffect } from \"react\";\n")
	}
	if len(collectAnimated(s.Root)) > 0 {
		if animCode != "" {
			b.WriteString("import { motion, type Variants } from \"motion/react\";\n")
		} else {
			b.WriteString("import { motion } from \"motion/react\";\n")
		}
	}
	if needNavigate {
		b.WriteString("import { useNavigate } from \"react-router-dom\";\n")
	}
	if needNavigate || needEffect || len(collectAnimated(s.Root)) > 0 {
		b.WriteString("\n")
	}
	b.WriteString(animCode)
	fmt.Fprintf(&b, "export function %s() {\n", s.Name)
	if needNavigate {
		b.WriteString("  const navigate = useNavigate();\n")
	}
	for _, t := range s.Root.KeyTriggers {
		if t.Dest == nil {
			fmt.Fprintf(&b, "  // %s (key %s: destination not exported)\n", flowComment(t), oneLine(t.Label))
		}
	}
	if needEffect {
		b.WriteString("  useEffect(() => {\n    const onKey = (e: KeyboardEvent) => {\n")
		for _, t := range s.Root.KeyTriggers {
			if t.Dest == nil {
				continue
			}
			for _, l := range flowComments(t) {
				fmt.Fprintf(&b, "      // %s\n", l)
			}
			fmt.Fprintf(&b, "      if (e.key === %s) navigate(%s);\n", tsString(t.Label), tsString(t.Dest.Route))
		}
		b.WriteString("    };\n    window.addEventListener(\"keydown\", onKey);\n    return () => window.removeEventListener(\"keydown\", onKey);\n  }, [navigate]);\n")
	}
	for _, t := range s.Root.NavTriggers {
		if t.Kind == "auto" {
			fmt.Fprintf(&b, "  // %s (auto trigger: to be wired, e.g. with a timer)\n", flowComment(t))
		}
	}
	b.WriteString("  return (\n")
	w := &jsxWriter{}
	w.element(s.Root, 2, true, d)
	b.WriteString(w.sb.String())
	b.WriteString("  );\n}\n")
	return b.String(), dedupeStrings(warns)
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// attrName: from HTML/SVG name (kebab) to JSX prop (camelCase); data-* and aria-*
// stay as they were.
func attrName(n string) string {
	if strings.HasPrefix(n, "data-") || strings.HasPrefix(n, "aria-") {
		return n
	}
	switch n {
	case "class":
		return "className"
	}
	if !strings.Contains(n, "-") {
		return n
	}
	parts := strings.Split(n, "-")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

// attrValue: `"value"` if it is safe as a JSX attribute literal (HTML
// entities are interpreted in it, and quotes are not escaped),
// otherwise `{"value"}`.
func attrValue(v string) string {
	if strings.ContainsAny(v, "\"&\\\n\r<>{}") {
		return "{" + tsString(v) + "}"
	}
	return "\"" + v + "\""
}

func (w *jsxWriter) line(depth int, s string) {
	w.sb.WriteString(strings.Repeat("  ", depth) + s + "\n")
}

func navigateExpr(t Trigger) string {
	if t.Kind == "back" {
		return "navigate(-1)"
	}
	return "navigate(" + tsString(t.Dest.Route) + ")"
}

// element writes a JSX element. Flow wiring:
//
//	trigger element -> onClick, role="button", tabIndex, aria-label = the
//	                   transition's label, cursor-pointer class (plus
//	                   data-testid from the meta, already among the attributes);
//	no element      -> visually hidden <nav> with one <button> per
//	                   transition, at the bottom of the root.
//
// These are the three ways the generated tests (getByTestId / getByText /
// getByRole('button', { name })) find the element in the real DOM.
func (w *jsxWriter) element(e *Element, depth int, root bool, d *opendesignerv1.Document) {
	type kv struct{ k, v string }
	var attrs []kv
	var comments []string
	style := e.Style

	var trig *Trigger
	for i := range e.Triggers {
		t := e.Triggers[i]
		comments = append(comments, flowComments(t)...)
		if trig == nil && (t.Dest != nil || t.Kind == "back") {
			trig = &e.Triggers[i]
		}
	}
	if trig != nil {
		style = append(append([]Prop(nil), style...), Prop{"cursor", "pointer"})
	}

	for _, a := range e.Attrs {
		attrs = append(attrs, kv{attrName(a.Name), attrValue(a.Value)})
	}
	if cn := className(style); cn != "" {
		attrs = append(attrs, kv{"className", attrValue(cn)})
	}
	// Animations (Motion): the element becomes `motion.<tag>`, receives the
	// variants of its tracks and, if it is the target of a clip, the labels that
	// trigger them on descendants (initial/animate = mount, whileHover, whileTap).
	motion := e.Anim != nil
	if motion {
		if e.Anim.VarName != "" {
			attrs = append(attrs, kv{"variants", "{" + e.Anim.VarName + "}"})
		}
		labels, cm := hostLabels(e.Anim)
		if len(e.Anim.RestStyle) > 0 {
			attrs = append(attrs, kv{"style", "{{ " + strings.Join(e.Anim.RestStyle, ", ") + " }}"})
		}
		for _, l := range labels {
			i := strings.Index(l, "=")
			attrs = append(attrs, kv{l[:i], l[i+1:]})
		}
		comments = append(comments, cm...)
	}
	if trig != nil {
		attrs = append(attrs, kv{"role", "\"button\""}, kv{"tabIndex", "{0}"})
		if trig.Label != "" {
			attrs = append(attrs, kv{"aria-label", attrValue(trig.Label)})
		}
		nav := navigateExpr(*trig)
		attrs = append(attrs,
			kv{"onClick", "{() => " + nav + "}"},
			kv{"onKeyDown", "{(e) => { if (e.key === \"Enter\") " + nav + "; }}"})
	}

	ind := strings.Repeat("  ", depth)
	tag := e.Tag
	if motion {
		tag = "motion." + tag
	}
	var open strings.Builder
	open.WriteString("<" + tag)
	multi := len(comments) > 0
	var one strings.Builder
	for _, a := range attrs {
		fmt.Fprintf(&one, " %s=%s", a.k, a.v)
	}
	if len(ind)+len(tag)+one.Len() > 110 {
		multi = true
	}
	kids := len(e.Children) > 0 || e.HasText || (root && (hasNav(e) || false))

	if multi {
		w.line(depth, "<"+tag)
		for _, c := range comments {
			w.line(depth+1, "// "+c)
		}
		for _, a := range attrs {
			w.line(depth+1, a.k+"="+a.v)
		}
		if kids {
			w.line(depth, ">")
		} else {
			w.line(depth, "/>")
			return
		}
	} else {
		if kids {
			w.line(depth, "<"+tag+one.String()+">")
		} else {
			w.line(depth, "<"+tag+one.String()+" />")
			return
		}
	}

	if e.HasText {
		w.line(depth+1, "{"+tsString(e.Text)+"}")
	}
	for _, c := range e.Children {
		w.element(c, depth+1, false, d)
	}
	if root {
		w.nav(e, depth+1, d)
	}
	w.line(depth, "</"+tag+">")
}

func hasNav(root *Element) bool {
	for _, t := range root.NavTriggers {
		if t.Kind != "auto" && (t.Dest != nil || t.Kind == "back") {
			return true
		}
	}
	return false
}

// nav: the buttons of transitions without an element, visually hidden but
// present in the DOM and in the accessibility tree.
//
// They do NOT use Tailwind's `sr-only`: that utility clips the element
// (clip: rect(0,0,0,0)) and Playwright, which checks who receives the pointer
// before clicking, gives it to the screen's root ("intercepts pointer
// events"). Here each button is a transparent pixel (opacity-0) in the
// top-left corner and above everything else: invisible, in the accessibility
// tree with its name, and clickable by a test.
func (w *jsxWriter) nav(root *Element, depth int, d *opendesignerv1.Document) {
	if !hasNav(root) {
		return
	}
	w.line(depth, "<nav className=\"absolute left-0 top-0 z-50 flex flex-col opacity-0\" aria-label=\"Flow navigation\">")
	for _, t := range root.NavTriggers {
		if t.Kind == "auto" || (t.Dest == nil && t.Kind != "back") {
			continue
		}
		label := t.Label
		if label == "" {
			if t.Dest != nil {
				label = "Go to " + d.GetNodes()[t.Dest.NodeID].GetName()
			} else {
				label = "Back"
			}
		}
		for _, l := range flowComments(t) {
			w.line(depth+1, "{/* "+l+" */}")
		}
		w.line(depth+1, "<button type=\"button\" className=\"block h-px w-px overflow-hidden\" onClick={() => "+navigateExpr(t)+"}>"+jsxText(label)+"</button>")
	}
	w.line(depth, "</nav>")
}

// jsxText: safe static text inside JSX.
func jsxText(s string) string {
	if strings.ContainsAny(s, "{}<>&\n\r") || strings.TrimSpace(s) != s {
		return "{" + tsString(s) + "}"
	}
	return s
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

func reactReadme(d *opendesignerv1.Document, screens []*Screen, opts Options, hasFlows bool, home *Screen, hasAnim bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", d.GetName())
	fmt.Fprintf(&b, "<!-- %s -->\n\n", generatedHeader(d, "README"))
	b.WriteString("React + TypeScript + Tailwind v4 project generated from the design with `opendesigner export`.\n\n")
	b.WriteString("## Getting started\n\n```sh\nnpm install\nnpm run dev      # http://localhost:5173\nnpm run build    # type check + production build\n")
	if hasFlows {
		b.WriteString("npx playwright install chromium   # first time only\nnpm test         # the e2e tests generated from the flows (playwright test)\n")
	}
	b.WriteString("```\n\n")
	b.WriteString("## How the design becomes code\n\n")
	b.WriteString("- Each **screen** (top-level frame) is a component in `src/screens/<Name>.tsx`; `src/App.tsx` mounts its routes (the frame's `meta[\"code.route\"]`, otherwise the name's slug). The flow's start screen is also mounted on `/`.\n")
	b.WriteString("- **Auto layout** -> flexbox (`flex`, `gap`, `padding`, `justify-*`, `items-*`); everything else is positioned absolutely (`absolute left-[..] top-[..]`) inside the container, using the design's coordinates. `hug` -> `fit-content`.\n")
	b.WriteString("- Fills, strokes (inside/center/outside -> `box-shadow` rings), shadows, blurs, rotation, clipping, text and vectors follow **what the editor's canvas draws** (first fill, first shadow, first blur).\n")
	b.WriteString("- **Images** are copied to `public/assets/<hash>.<ext>`; if missing, the canvas placeholder appears.\n")
	b.WriteString("- Every element carries `data-node-id=\"<node id>\"`: it is the link between the design and the code.\n")
	b.WriteString("- Component **instances** are expanded inline (there is no extraction into React components yet).\n")
	b.WriteString("- Screens have a fixed size (no responsiveness).\n\n")
	if hasFlows {
		b.WriteString("## Flows and tests\n\n")
		b.WriteString("For each transition, the element that fires it (`elementId`) is clickable (`onClick` -> `navigate(...)`, `role=\"button\"`, `aria-label` = label, `data-testid` from the `test.id` meta). Transitions without an element are visually hidden buttons in a transparent `<nav>` (1px, top-left). ")
		b.WriteString("The `// flow: <id>`, `// guard:` and `// effect:` lines indicate the design's transition.\n\n")
		b.WriteString("`tests/flows.spec.ts` is produced by `opendesigner flow tests` and walks all the flows' paths with Playwright.\n\n")
	}
	if hasAnim {
		b.WriteString(animationReadme(d, screens))
	}
	b.WriteString("## Screens\n\n| Component | Route | Design node |\n|---|---|---|\n")
	for _, s := range screens {
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` (%s) |\n", s.Name, s.Route, s.NodeID, strings.ReplaceAll(d.GetNodes()[s.NodeID].GetName(), "|", "\\|"))
	}
	b.WriteString("\n## Regenerating\n\n")
	flag := ""
	if opts.FlowID != "" {
		flag = " -flow " + opts.FlowID
	}
	fmt.Fprintf(&b, "```sh\nopendesigner export -doc %s -target react%s -out . -force\n```\n\n", d.GetId(), flag)
	b.WriteString("The generated files must not be edited by hand: the next export overwrites them. To evolve the project by hand, export once and work on the code from then on (regeneration does not merge).\n")
	return b.String()
}
