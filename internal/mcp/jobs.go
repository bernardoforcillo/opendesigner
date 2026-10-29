package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// OUTPUTS MADE BY THE EDITOR. A PDF, an EPUB, a PNG, the print package and the full preflight need the text
// layout and the fonts that only the editor (the browser) has, so these tools ask the server to run the job in an
// editor that has the document open (RunJob; see internal/server/jobs.go) and write what comes back to outPath.
// With no editor open they fail, saying so: open the document in the editor and call again.

// JobOutput is what an editor-made output reports.
type JobOutput struct {
	Path         string `json:"path,omitempty" jsonschema:"where the file was written"`
	Filename     string `json:"filename,omitempty"`
	Size         uint64 `json:"size,omitempty" jsonschema:"bytes"`
	DownloadPath string `json:"downloadPath,omitempty" jsonschema:"the same file on the server, for a short while: GET <server>/export-api/<doc>/<id>"`
	Note         string `json:"note,omitempty" jsonschema:"what the editor reported while making it (images that could not be read, problems found)"`
}

// writeResult stores data at outPath: a directory (existing, or ending in a separator) gets the file's own name.
func writeResult(outPath, filename string, data []byte) (string, error) {
	if outPath == "" {
		return "", nil
	}
	dest := outPath
	if st, err := os.Stat(outPath); (err == nil && st.IsDir()) || strings.HasSuffix(outPath, string(os.PathSeparator)) || strings.HasSuffix(outPath, "/") {
		dest = filepath.Join(outPath, filename)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return "", err
	}
	return dest, nil
}

// runJob runs `kind` with `opts` (a JSON object) and returns the raw response.
func (s *Session) runJob(ctx context.Context, tool, kind string, opts any) (*opendesignerv1.RunJobResponse, error) {
	return s.runJobWith(ctx, tool, kind, opts, "")
}

// maxInputFile is the biggest file sent to an editor (the server refuses more).
const maxInputFile = 32 << 20

// runJobWith is runJob with an input file read from inputPath ("" = none).
func (s *Session) runJobWith(ctx context.Context, tool, kind string, opts any, inputPath string) (*opendesignerv1.RunJobResponse, error) {
	var payload []byte
	if inputPath != "" {
		st, err := os.Stat(inputPath)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", tool, err)
		}
		if st.IsDir() || st.Size() > maxInputFile {
			return nil, fmt.Errorf("%s: path must be a file of at most 32 MiB", tool)
		}
		if payload, err = os.ReadFile(inputPath); err != nil {
			return nil, fmt.Errorf("%s: %w", tool, err)
		}
	}
	raw := []byte("{}")
	if opts != nil {
		var err error
		if raw, err = json.Marshal(opts); err != nil {
			return nil, fmt.Errorf("%s: %w", tool, err)
		}
	}
	resp, err := s.client.RunJob(ctx, connect.NewRequest(&opendesignerv1.RunJobRequest{DocId: s.docID, Kind: kind, OptionsJson: string(raw), Payload: payload, PayloadName: filepath.Base(inputPath)}))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", tool, err)
	}
	if !resp.Msg.GetOk() {
		return nil, fmt.Errorf("%s: %s", tool, resp.Msg.GetMessage())
	}
	return resp.Msg, nil
}

// runFileJob runs a job that produces a file and writes it to outPath.
func (s *Session) runFileJob(ctx context.Context, tool, kind, outPath string, opts any) (JobOutput, error) {
	r, err := s.runJob(ctx, tool, kind, opts)
	if err != nil {
		return JobOutput{}, err
	}
	out := JobOutput{Filename: r.GetFilename(), Size: r.GetSize(), Note: r.GetMessage()}
	if r.GetResultId() != "" {
		out.DownloadPath = "/export-api/" + s.docID + "/" + r.GetResultId()
	}
	path, err := writeResult(outPath, r.GetFilename(), r.GetData())
	if err != nil {
		return JobOutput{}, fmt.Errorf("%s: %w", tool, err)
	}
	out.Path = path
	return out, nil
}

// PrintOptionsIn are the options of a PDF for print (the editor's "Export PDF for print…" dialog).
type PrintOptionsIn struct {
	Standard    string `json:"standard,omitempty" jsonschema:"none (default) | x4 | x3 | x1a: PDF/X identification and output intent. X-1a forces CMYK and refuses transparency. 'Ready', not validated: no ICC profile is embedded"`
	Bleed       *bool  `json:"bleed,omitempty" jsonschema:"each sheet with its page's bleed (set with update_page)"`
	Marks       *bool  `json:"marks,omitempty" jsonschema:"crop marks and a page-information line outside the bleed"`
	Slug        *bool  `json:"slug,omitempty" jsonschema:"include each page's slug area"`
	Spreads     *bool  `json:"spreads,omitempty" jsonschema:"facing pages as one wide page per spread (needs facingPages in set_document_settings)"`
	Interactive *bool  `json:"interactive,omitempty" jsonschema:"bookmarks from headings and link annotations (default true)"`
	Booklet     *bool  `json:"booklet,omitempty" jsonschema:"booklet imposition: two pages per sheet side in saddle-stitch order (N-1|1, 2|N-2, ...), padded with blanks to a multiple of 4; overrides spreads"`
	Tagged      *bool  `json:"tagged,omitempty" jsonschema:"tagged PDF: marked content and a structure tree (headings from outline-level styles, paragraphs, figures with alt text from the node's meta alt or name), document language from the book metadata. Not validated as PDF/UA"`
}

type ExportPdfInput struct {
	OutPath string `json:"outPath,omitempty" jsonschema:"file path, or a directory to put the file in; empty = do not write, return downloadPath"`
	PrintOptionsIn
}

func (in PrintOptionsIn) json() map[string]any {
	m := map[string]any{}
	if in.Standard != "" {
		m["standard"] = in.Standard
	}
	for k, v := range map[string]*bool{"bleed": in.Bleed, "marks": in.Marks, "slug": in.Slug, "spreads": in.Spreads, "interactive": in.Interactive, "booklet": in.Booklet, "tagged": in.Tagged} {
		if v != nil {
			m[k] = *v
		}
	}
	return m
}

// ExportPdf makes the document's PDF in an editor.
func (s *Session) ExportPdf(ctx context.Context, in ExportPdfInput) (JobOutput, error) {
	return s.runFileJob(ctx, "export_pdf", "export_pdf", in.OutPath, in.PrintOptionsIn.json())
}

// ExportPackage makes the print package (PDF, fonts, placed images, report) in an editor.
func (s *Session) ExportPackage(ctx context.Context, in ExportPdfInput) (JobOutput, error) {
	return s.runFileJob(ctx, "export_package", "export_package", in.OutPath, in.PrintOptionsIn.json())
}

type ExportEpubInput struct {
	OutPath string `json:"outPath,omitempty" jsonschema:"file path, or a directory to put the file in; empty = do not write, return downloadPath"`
	Mode    string `json:"mode,omitempty" jsonschema:"fixed (default): every page as it looks, EPUB 3 fixed layout | reflowable: the stories as text with headings, styles as CSS, footnotes and a navigation. Book metadata (set_document_settings book) fills the package metadata"`
}

// ExportEpub makes the document's EPUB in an editor.
func (s *Session) ExportEpub(ctx context.Context, in ExportEpubInput) (JobOutput, error) {
	switch in.Mode {
	case "", "fixed":
		return s.runFileJob(ctx, "export_epub", "export_epub", in.OutPath, nil)
	case "reflowable":
		return s.runFileJob(ctx, "export_epub", "export_epub_reflow", in.OutPath, nil)
	}
	return JobOutput{}, fmt.Errorf("export_epub: mode must be fixed or reflowable, got %q", in.Mode)
}

type ExportFileInput struct {
	OutPath string `json:"outPath,omitempty" jsonschema:"file path, or a directory to put the file in; empty = do not write, return downloadPath"`
}

type ExportHtmlInput struct {
	OutPath string `json:"outPath,omitempty" jsonschema:"file path, or a directory to put the file in; empty = do not write, return downloadPath"`
	Mode    string `json:"mode,omitempty" jsonschema:"pages (default): every page as inline SVG | text: the stories as reflowable semantic HTML (headings, paragraphs, styles as CSS, a linked contents list, footnotes, images inlined)"`
}

// ExportHtml makes the document as one HTML file in an editor: every page as inline SVG, or the stories as text.
func (s *Session) ExportHtml(ctx context.Context, in ExportHtmlInput) (JobOutput, error) {
	switch in.Mode {
	case "", "pages":
		return s.runFileJob(ctx, "export_html", "export_html", in.OutPath, nil)
	case "text":
		return s.runFileJob(ctx, "export_html", "export_html_text", in.OutPath, nil)
	}
	return JobOutput{}, fmt.Errorf("export_html: mode must be pages or text, got %q", in.Mode)
}

// ExportPptx makes the document as a PowerPoint deck (one slide per page) in an editor.
func (s *Session) ExportPptx(ctx context.Context, in ExportFileInput) (JobOutput, error) {
	return s.runFileJob(ctx, "export_pptx", "export_pptx", in.OutPath, nil)
}

// ExportIdml makes the document as an InDesign IDML package in an editor.
func (s *Session) ExportIdml(ctx context.Context, in ExportFileInput) (JobOutput, error) {
	return s.runFileJob(ctx, "export_idml", "export_idml", in.OutPath, nil)
}

type ExportImageInput struct {
	OutPath string   `json:"outPath,omitempty" jsonschema:"file path, or a directory to put the file in; empty = do not write, return downloadPath"`
	Format  string   `json:"format,omitempty" jsonschema:"png (default) | svg"`
	PageId  string   `json:"pageId,omitempty" jsonschema:"the page to export (default: the page the editor is on)"`
	NodeIds []string `json:"nodeIds,omitempty" jsonschema:"export only these nodes (they must be on the page)"`
	Scale   int      `json:"scale,omitempty" jsonschema:"png only: 1 (default), 2 or 3"`
}

// ExportImage makes a PNG or SVG of a page or of nodes in an editor.
func (s *Session) ExportImage(ctx context.Context, in ExportImageInput) (JobOutput, error) {
	kind := "export_png"
	switch in.Format {
	case "", "png":
	case "svg":
		kind = "export_svg"
	default:
		return JobOutput{}, fmt.Errorf("export_image: format must be png or svg, got %q", in.Format)
	}
	o := map[string]any{}
	if in.PageId != "" {
		o["pageId"] = in.PageId
	}
	if len(in.NodeIds) > 0 {
		o["nodeIds"] = in.NodeIds
	}
	if in.Scale != 0 {
		o["scale"] = in.Scale
	}
	return s.runFileJob(ctx, "export_image", kind, in.OutPath, o)
}

type PreflightInput struct {
	PrintOptionsIn
}

// PreflightIssue is one finding.
type PreflightIssue struct {
	Severity string `json:"severity" jsonschema:"error | warning | info"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	NodeId   string `json:"nodeId,omitempty"`
	PageId   string `json:"pageId,omitempty"`
}

type PreflightOutput struct {
	Issues   []PreflightIssue `json:"issues"`
	Errors   int              `json:"errors"`
	Warnings int              `json:"warnings"`
}

// Preflight checks the document the way the editor's preflight does.
func (s *Session) Preflight(ctx context.Context, in PreflightInput) (PreflightOutput, error) {
	r, err := s.runJob(ctx, "preflight", "preflight", in.PrintOptionsIn.json())
	if err != nil {
		return PreflightOutput{}, err
	}
	var out PreflightOutput
	if err := json.Unmarshal([]byte(r.GetText()), &out); err != nil {
		return PreflightOutput{}, fmt.Errorf("preflight: the editor answered with something unreadable: %w", err)
	}
	if out.Issues == nil {
		out.Issues = []PreflightIssue{}
	}
	return out, nil
}

const jobNote = " Made by an editor: the document must be open in the editor (it runs the text layout and has the fonts); with none open this fails and says so. "

func registerJobTools(srv *mcp.Server, s *Session) {
	addTool(srv, "export_pdf", "Export the whole document as a real PDF (embedded fonts, images as uploaded, gradients, transparency, CMYK and spot colours, bookmarks and links). Options for print: standard (x4 | x3 | x1a, 'ready' not validated), bleed, marks, slug, spreads."+jobNote+"Writes to outPath."+" Run `preflight` with the same options first to see what a printer would flag.", s.ExportPdf)
	addTool(srv, "export_package", "Export a print package (zip): the PDF with the chosen options, the uploaded fonts, the placed image files and Report.txt (pages, standard, colours, fonts, links, preflight). Not an editable copy of the document."+jobNote+"Writes to outPath.", s.ExportPackage)
	addTool(srv, "export_html", "Export the document as ONE HTML file: every page as inline SVG (text stays selectable, images embedded, fonts not embedded). For text that reflows use mode text (semantic HTML) or export_epub mode reflowable."+jobNote+"Writes to outPath.", s.ExportHtml)
	addTool(srv, "export_pptx", "Export the document as a PowerPoint deck, one slide per page: rectangles, ellipses, vectors, text boxes, PNG/JPEG images, solid and linear-gradient fills, strokes, opacity, rotation. Effects, masks, auto layout and rich-text styles are not carried over; fonts are named, not embedded."+jobNote+"Writes to outPath.", s.ExportPptx)
	addTool(srv, "export_idml", "Export the document as an InDesign IDML package: one spread per page with rectangles, ellipses, vectors (bezier), text frames (font, size, bold/italic, colour, alignment) and RGB swatches. Images, effects, master pages' items, character styles and tables are not carried over. The structure follows the IDML specification but was checked by reading it back with import_idml, not by opening it in InDesign."+jobNote+"Writes to outPath.", s.ExportIdml)
	addTool(srv, "export_epub", "Export the document as EPUB 3: mode fixed (default, every page as it looks) or reflowable (the stories as text with headings, CSS from the styles, footnotes, navigation). Book metadata (set_document_settings book) fills the package metadata."+jobNote+"Writes to outPath.", s.ExportEpub)
	addTool(srv, "export_image", "Export a page, or some nodes of it, as PNG (scale 1-3) or SVG."+jobNote+"Writes to outPath.", s.ExportImage)
	addTool(srv, "preflight", "Check the document for print: fonts that cannot be embedded, overset text, pages without size or bleed, images under 150 ppi, missing glyphs, transparency under X-1a / X-3, RGB under X-1a, effects a PDF cannot reproduce. A checklist of known problems, not a PDF/X validator."+jobNote, s.Preflight)
}
