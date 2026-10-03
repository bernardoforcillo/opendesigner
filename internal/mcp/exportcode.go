package mcp

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// export_code: il design come codice. La generazione la fa il server (RPC
// ExportCode, la stessa di `opendesigner export`: stesso snapshot, stessi
// asset); qui si scrivono i file nella cartella dell'agente.

type ExportCodeInput struct {
	OutDir string `json:"outDir" jsonschema:"cartella di destinazione (creata se manca); deve essere vuota a meno di force"`
	Target string `json:"target,omitempty" jsonschema:"react (default: Vite + React + TypeScript + Tailwind v4 + test Playwright dei flussi) oppure html (un file per schermata)"`
	FlowId string `json:"flowId,omitempty" jsonschema:"cabla e testa un solo flusso (vedi list_flows); vuoto = tutti"`
	Force  bool   `json:"force,omitempty" jsonschema:"ammette una cartella non vuota, sovrascrivendo i file generati"`
}

type ExportCodeOutput struct {
	OutDir   string   `json:"outDir"`
	Target   string   `json:"target"`
	Files    []string `json:"files" jsonschema:"percorsi scritti, relativi a outDir"`
	Warnings []string `json:"warnings,omitempty" jsonschema:"approssimazioni e omissioni (asset mancanti, transizioni verso nodi non esportati)"`
}

// ExportCode chiede al server il progetto e lo scrive in OutDir.
func (s *Session) ExportCode(ctx context.Context, in ExportCodeInput) (ExportCodeOutput, error) {
	if in.OutDir == "" {
		return ExportCodeOutput{}, fmt.Errorf("export_code: outDir è obbligatorio")
	}
	target := in.Target
	if target == "" {
		target = string(codegen.TargetReact)
	}
	resp, err := s.client.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: s.docID, Target: target, FlowId: in.FlowId}))
	if err != nil {
		return ExportCodeOutput{}, fmt.Errorf("export_code: %w", err)
	}
	out := &codegen.Output{Warnings: resp.Msg.GetWarnings()}
	for _, f := range resp.Msg.GetFiles() {
		out.Files = append(out.Files, codegen.File{Path: f.GetPath(), Content: f.GetContent()})
	}
	written, err := codegen.WriteFiles(out, in.OutDir, in.Force)
	if err != nil {
		return ExportCodeOutput{}, fmt.Errorf("export_code: %w", err)
	}
	return ExportCodeOutput{OutDir: in.OutDir, Target: target, Files: written, Warnings: out.Warnings}, nil
}

// codeConventions è il manuale che l'agente deve avere sotto mano per usare
// export_code e per scrivere un design che si esporti bene.
const codeConventions = " How the design maps to code: every top-level FRAME of a page is a screen (component masters are not); the screen's name becomes the component/file (PascalCase; meta code.component overrides it) and its route is meta code.route (else '/' + slug of the name; the flow's start screen is also mounted at '/'). " +
	"Auto-layout frames become flexbox (direction, spacing -> gap, padding, main/cross align -> justify-content/align-items, hug -> fit-content); every other container positions children absolutely at their x/y. " +
	"Rendering follows what the editor canvas draws: only the FIRST fill (default grey for shapes, a frame without fill is transparent), strokes inside/center/outside, the first drop shadow and first layer blur, opacity per node (not inherited by children), rotation about the node centre, clipsContent -> overflow hidden, text with Inter/16/400/line-height 1.2 defaults, images copied to assets, vectors as inline SVG, component instances inlined with their overrides, hidden nodes skipped. " +
	"Flows: for every transition the element (elementId) inside fromId becomes clickable (onClick -> navigate to the destination route, role=button, aria-label = the transition label, data-testid from meta test.id); transitions without an element become a visually hidden button named by the label. " +
	"Set meta test.id / test.text on trigger elements and code.route on screens (set_node_meta) before exporting so the generated Playwright tests (tests/flows.spec.ts) find them. Screens have a fixed size (no responsive layout). " +
	"Animation clips (list_clips, animate_node) are exported too: react uses Motion (motion/react variants: enter -> animate on mount, hover -> whileHover, tap -> whileTap, loop -> repeat Infinity, manual -> a named variant), html uses CSS @keyframes; x/y/rotation become deltas from the node position, draw animates a vector path (pathLength)."

func registerCodegenTools(srv *mcp.Server, s *Session) {
	addTool(srv, "export_code", "Export the design as a working project and write it to outDir. target react (default) = Vite + React + TypeScript + Tailwind v4 + react-router-dom, with Playwright tests generated from the flows; target html = one self-contained HTML file per screen. Returns the files written and any warnings. Then: cd outDir && npm install && npm run dev, and npx playwright test."+codeConventions, s.ExportCode)
}
