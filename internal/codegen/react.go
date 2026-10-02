package codegen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
)

// Target react: un progetto Vite + React + TypeScript + Tailwind v4 +
// react-router-dom. Ogni schermata è un componente `src/screens/<Nome>.tsx` con
// classi Tailwind; `src/App.tsx` monta le rotte; `tests/flows.spec.ts` sono i
// test Playwright di internal/flow, che trovano gli elementi per data-testid /
// testo / ruolo ESATTAMENTE come li scrive questo renderer (vedi writeJSX).

// Versioni dei pacchetti: le major correnti al momento della scrittura. Sono
// caret, quindi `npm install` prende l'ultima minor compatibile.
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
)

// tsString cita una stringa come literal TypeScript (escape JSON, senza
// l'escaping HTML che json.Marshal applica di default).
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

func renderReact(d *opendesignerv1.Document, screens []*Screen, opts Options, files map[string][]byte) error {
	put := func(path, content string) { files[path] = []byte(content) }

	pkgName := slug(d.GetName())
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
  "dependencies": {
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
`, tsString(pkgName), verReact, verReact, verRouter, verPlaywright, verTailwind, verTypesNode, verTypesReact, verTypesReact, verPluginReact, verTailwind, verTypeScript, verVite))

	put("index.html", fmt.Sprintf(`<!doctype html>
<html lang="it">
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
`, escapeHTML(d.GetName()), generatedHeader(d, "scheletro dell'app")))

	put("vite.config.ts", tsHeader(d, "configurazione di Vite")+`import { defineConfig } from "vite";
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

	put("playwright.config.ts", tsHeader(d, "configurazione di Playwright")+`import { defineConfig, devices } from "@playwright/test";

// Il dev server di Vite parte da solo; PW_CHROMIUM_PATH (opzionale) punta a un
// Chromium già installato al posto di quello scaricato da Playwright.
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
	put("src/index.css", `/* `+strings.ReplaceAll(generatedHeader(d, "stili globali"), "\n", "\n   ")+` */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
@import "tailwindcss";
`)
	put("src/main.tsx", tsHeader(d, "punto d'ingresso")+`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`)

	// App.tsx: una rotta per schermata; "/" porta alla schermata iniziale del
	// primo flusso che ne ha una (altrimenti alla prima schermata).
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
	app.WriteString(tsHeader(d, "rotte dell'app"))
	app.WriteString("import { BrowserRouter, Route, Routes } from \"react-router-dom\";\n")
	for _, s := range screens {
		fmt.Fprintf(&app, "import { %s } from \"./screens/%s\";\n", s.Name, s.Name)
	}
	app.WriteString("\nexport default function App() {\n  return (\n    <BrowserRouter>\n      <Routes>\n")
	if home.Route != "/" {
		fmt.Fprintf(&app, "        {/* schermata iniziale: montata anche su \"/\" */}\n        <Route path=\"/\" element={<%s />} />\n", home.Name)
	}
	for _, s := range screens {
		fmt.Fprintf(&app, "        <Route path=%s element={<%s />} />\n", tsString(s.Route), s.Name)
	}
	app.WriteString("      </Routes>\n    </BrowserRouter>\n  );\n}\n")
	put("src/App.tsx", app.String())

	for _, s := range screens {
		put("src/screens/"+s.Name+".tsx", reactScreen(d, s))
	}

	// Test Playwright dei flussi (internal/flow): `code.route` è già stato
	// completato sulla copia del documento da assignNames.
	hasFlows := len(selectedFlows(d, opts.FlowID)) > 0
	if hasFlows {
		spec, err := flow.PlaywrightTests(d, opts.FlowID, flow.PlaywrightOptions{})
		if err != nil {
			return err
		}
		put("tests/flows.spec.ts", spec)
	}

	put("README.md", reactReadme(d, screens, opts, hasFlows, home))
	return nil
}

func escapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;").Replace(s)
}

// ---------------------------------------------------------------------------
// componenti
// ---------------------------------------------------------------------------

type jsxWriter struct {
	sb strings.Builder
}

func reactScreen(d *opendesignerv1.Document, s *Screen) string {
	// Cosa serve al componente: navigate (almeno un cablaggio con destinazione)
	// ed effect (tasti).
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
	b.WriteString(tsHeader(d, "schermata \""+oneLine(d.GetNodes()[s.NodeID].GetName())+"\" (rotta "+s.Route+")"))
	if needEffect {
		b.WriteString("import { useEffect } from \"react\";\n")
	}
	if needNavigate {
		b.WriteString("import { useNavigate } from \"react-router-dom\";\n")
	}
	if needNavigate || needEffect {
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "export function %s() {\n", s.Name)
	if needNavigate {
		b.WriteString("  const navigate = useNavigate();\n")
	}
	for _, t := range s.Root.KeyTriggers {
		if t.Dest == nil {
			fmt.Fprintf(&b, "  // %s (tasto %s: destinazione non esportata)\n", flowComment(t), oneLine(t.Label))
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
			fmt.Fprintf(&b, "  // %s (trigger auto: da cablare, p.es. con un timer)\n", flowComment(t))
		}
	}
	b.WriteString("  return (\n")
	w := &jsxWriter{}
	w.element(s.Root, 2, true, d)
	b.WriteString(w.sb.String())
	b.WriteString("  );\n}\n")
	return b.String()
}

// attrName: da nome HTML/SVG (kebab) a prop JSX (camelCase); data-* e aria-*
// restano com'erano.
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

// attrValue: `"valore"` se è sicuro come literal di attributo JSX (le
// entità HTML vi si interpretano, e le virgolette non si escapano),
// altrimenti `{"valore"}`.
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

// element scrive un elemento JSX. Cablaggio dei flussi:
//
//	elemento trigger -> onClick, role="button", tabIndex, aria-label = etichetta
//	                    della transizione, classe cursor-pointer (più
//	                    data-testid dai meta, già fra gli attributi);
//	senza elemento   -> <nav> visivamente nascosto con un <button> per
//	                    transizione, in fondo alla radice.
//
// Sono i tre modi in cui i test generati (getByTestId / getByText /
// getByRole('button', { name })) trovano l'elemento nel DOM vero.
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

// nav: i pulsanti delle transizioni senza elemento, visivamente nascosti ma
// presenti nel DOM e nell'albero di accessibilità.
//
// NON usano `sr-only` di Tailwind: quella utility ritaglia l'elemento
// (clip: rect(0,0,0,0)) e Playwright, che prima di cliccare verifica chi
// riceve il puntatore, lo dà alla radice della schermata ("intercepts pointer
// events"). Qui ogni pulsante è un pixel trasparente (opacity-0) nell'angolo in
// alto a sinistra e sopra al resto: invisibile, nell'albero di accessibilità
// col suo nome, e cliccabile da un test.
func (w *jsxWriter) nav(root *Element, depth int, d *opendesignerv1.Document) {
	if !hasNav(root) {
		return
	}
	w.line(depth, "<nav className=\"absolute left-0 top-0 z-50 flex flex-col opacity-0\" aria-label=\"Navigazione del flusso\">")
	for _, t := range root.NavTriggers {
		if t.Kind == "auto" || (t.Dest == nil && t.Kind != "back") {
			continue
		}
		label := t.Label
		if label == "" {
			if t.Dest != nil {
				label = "Vai a " + d.GetNodes()[t.Dest.NodeID].GetName()
			} else {
				label = "Indietro"
			}
		}
		for _, l := range flowComments(t) {
			w.line(depth+1, "{/* "+l+" */}")
		}
		w.line(depth+1, "<button type=\"button\" className=\"block h-px w-px overflow-hidden\" onClick={() => "+navigateExpr(t)+"}>"+jsxText(label)+"</button>")
	}
	w.line(depth, "</nav>")
}

// jsxText: testo statico sicuro dentro JSX.
func jsxText(s string) string {
	if strings.ContainsAny(s, "{}<>&\n\r") || strings.TrimSpace(s) != s {
		return "{" + tsString(s) + "}"
	}
	return s
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

func reactReadme(d *opendesignerv1.Document, screens []*Screen, opts Options, hasFlows bool, home *Screen) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", d.GetName())
	fmt.Fprintf(&b, "<!-- %s -->\n\n", generatedHeader(d, "README"))
	b.WriteString("Progetto React + TypeScript + Tailwind v4 generato dal design con `opendesigner export`.\n\n")
	b.WriteString("## Come si avvia\n\n```sh\nnpm install\nnpm run dev      # http://localhost:5173\nnpm run build    # controllo dei tipi + build di produzione\n")
	if hasFlows {
		b.WriteString("npx playwright install chromium   # solo la prima volta\nnpm test         # i test e2e generati dai flussi (playwright test)\n")
	}
	b.WriteString("```\n\n")
	b.WriteString("## Come il design diventa codice\n\n")
	b.WriteString("- Ogni **schermata** (frame di primo livello) è un componente in `src/screens/<Nome>.tsx`; `src/App.tsx` ne monta le rotte (`meta[\"code.route\"]` del frame, altrimenti lo slug del nome). La schermata iniziale del flusso è montata anche su `/`.\n")
	b.WriteString("- **Auto layout** -> flexbox (`flex`, `gap`, `padding`, `justify-*`, `items-*`); tutto il resto è posizionato in modo assoluto (`absolute left-[..] top-[..]`) dentro il contenitore, con le coordinate del design. `hug` -> `fit-content`.\n")
	b.WriteString("- Riempimenti, tratti (interno/centro/esterno -> anelli di `box-shadow`), ombre, sfocature, rotazione, ritaglio, testo e vettori seguono **ciò che disegna il canvas dell'editor** (primo riempimento, prima ombra, prima sfocatura).\n")
	b.WriteString("- Le **immagini** sono copiate in `public/assets/<hash>.<ext>`; se mancano compare il segnaposto del canvas.\n")
	b.WriteString("- Ogni elemento porta `data-node-id=\"<id del nodo>\"`: è il legame fra il design e il codice.\n")
	b.WriteString("- Le **istanze** dei componenti sono espanse inline (non c'è ancora l'estrazione in componenti React).\n")
	b.WriteString("- Le schermate hanno dimensione fissa (niente responsive).\n\n")
	if hasFlows {
		b.WriteString("## Flussi e test\n\n")
		b.WriteString("Per ogni transizione l'elemento che la innesca (`elementId`) è cliccabile (`onClick` -> `navigate(...)`, `role=\"button\"`, `aria-label` = etichetta, `data-testid` dal meta `test.id`). Le transizioni senza elemento sono pulsanti visivamente nascosti in un `<nav>` trasparente (1px, in alto a sinistra). ")
		b.WriteString("Le righe `// flow: <id>`, `// guard:` e `// effect:` indicano la transizione del design.\n\n")
		b.WriteString("`tests/flows.spec.ts` è prodotto da `opendesigner flow tests` e percorre tutti i percorsi dei flussi con Playwright.\n\n")
	}
	b.WriteString("## Schermate\n\n| Componente | Rotta | Nodo del design |\n|---|---|---|\n")
	for _, s := range screens {
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` (%s) |\n", s.Name, s.Route, s.NodeID, strings.ReplaceAll(d.GetNodes()[s.NodeID].GetName(), "|", "\\|"))
	}
	b.WriteString("\n## Rigenerare\n\n")
	flag := ""
	if opts.FlowID != "" {
		flag = " -flow " + opts.FlowID
	}
	fmt.Fprintf(&b, "```sh\nopendesigner export -doc %s -target react%s -out . -force\n```\n\n", d.GetId(), flag)
	b.WriteString("I file generati non vanno modificati a mano: la prossima esportazione li sovrascrive. Per far evolvere il progetto a mano, esporta una volta e da lì in poi lavora sul codice (la rigenerazione non fa merge).\n")
	return b.String()
}
