package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// COMMANDS RUN BY THE EDITOR. Generating a table of contents, building a table, finding and changing text,
// overriding a master item: the editor's own code builds the ops (one implementation, the one the menus use)
// and applies them as one undo step. The tools ask an editor that has the document open to run them.

// runCommand sends `name` with its arguments and returns the editor's JSON answer.
func (s *Session) runCommand(ctx context.Context, tool, name string, args map[string]any, out any) error {
	return s.runCommandWith(ctx, tool, name, args, "", out)
}

// runCommandWith is runCommand with an input file read from inputPath.
func (s *Session) runCommandWith(ctx context.Context, tool, name string, args map[string]any, inputPath string, out any) error {
	opts := map[string]any{"name": name}
	for k, v := range args {
		opts[k] = v
	}
	r, err := s.runJobWith(ctx, tool, "command", opts, inputPath)
	if err != nil {
		return err
	}
	if out != nil {
		if err := json.Unmarshal([]byte(r.GetText()), out); err != nil {
			return fmt.Errorf("%s: the editor answered with something unreadable: %w", tool, err)
		}
	}
	return nil
}

type GenerateContentsInput struct {
	Kind     string `json:"kind" jsonschema:"toc (table of contents from the heading styles) | index (from the [#term] and [#Parent:Child] marks in the text; sub-entries are indented) | endnotes (the notes written [*text])"`
	PageId   string `json:"pageId,omitempty" jsonschema:"where to create the frame if the document has none (default: the first page); an existing frame is refreshed in place"`
	MaxLevel int    `json:"maxLevel,omitempty" jsonschema:"toc only: deepest heading level listed, 1..9 (default 3)"`
}

type GenerateContentsOutput struct {
	Lines   int      `json:"lines"`
	NodeIds []string `json:"nodeIds" jsonschema:"the generated text frame"`
}

// GenerateContents writes or refreshes the contents or the index.
func (s *Session) GenerateContents(ctx context.Context, in GenerateContentsInput) (GenerateContentsOutput, error) {
	var out GenerateContentsOutput
	args := map[string]any{"kind": in.Kind}
	if in.PageId != "" {
		args["pageId"] = in.PageId
	}
	if in.MaxLevel != 0 {
		args["maxLevel"] = in.MaxLevel
	}
	return out, s.runCommand(ctx, "generate_contents", "generate_contents", args, &out)
}

type InsertTableInput struct {
	PageId     string  `json:"pageId,omitempty" jsonschema:"page to put it on (default: the first)"`
	ParentId   string  `json:"parentId,omitempty" jsonschema:"or a frame to put it in"`
	X          float64 `json:"x,omitempty"`
	Y          float64 `json:"y,omitempty"`
	Rows       int     `json:"rows" jsonschema:"1..100"`
	Cols       int     `json:"cols" jsonschema:"1..100"`
	CellWidth  float64 `json:"cellWidth,omitempty" jsonschema:"default 120"`
	CellHeight float64 `json:"cellHeight,omitempty" jsonschema:"default 36"`
	HeaderRows *int    `json:"headerRows,omitempty" jsonschema:"default 1"`
}

type InsertTableOutput struct {
	TableId string `json:"tableId" jsonschema:"the table's group node; its cells are rectangles and texts under it"`
	Cells   int    `json:"cells"`
}

// InsertTable builds a table of equal cells.
func (s *Session) InsertTable(ctx context.Context, in InsertTableInput) (InsertTableOutput, error) {
	args := map[string]any{"rows": in.Rows, "cols": in.Cols, "x": in.X, "y": in.Y}
	if in.PageId != "" {
		args["pageId"] = in.PageId
	}
	if in.ParentId != "" {
		args["parentId"] = in.ParentId
	}
	if in.CellWidth != 0 {
		args["cellWidth"] = in.CellWidth
	}
	if in.CellHeight != 0 {
		args["cellHeight"] = in.CellHeight
	}
	if in.HeaderRows != nil {
		args["headerRows"] = *in.HeaderRows
	}
	var out InsertTableOutput
	return out, s.runCommand(ctx, "insert_table", "insert_table", args, &out)
}

type EditTableInput struct {
	TableId string  `json:"tableId" jsonschema:"the table's group node, or any of its cells"`
	Action  string  `json:"action" jsonschema:"add_row | add_column (after index; -1 = before the first) | delete_row | delete_column | resize_row | resize_column (set to size)"`
	Index   int     `json:"index"`
	Size    float64 `json:"size,omitempty" jsonschema:"resize only: the new height or width"`
}

type EditTableOutput struct {
	TableId string `json:"tableId"`
}

// EditTable adds, removes or resizes rows and columns.
func (s *Session) EditTable(ctx context.Context, in EditTableInput) (EditTableOutput, error) {
	args := map[string]any{"tableId": in.TableId, "action": in.Action, "index": in.Index}
	if in.Size != 0 {
		args["size"] = in.Size
	}
	var out EditTableOutput
	return out, s.runCommand(ctx, "edit_table", "edit_table", args, &out)
}

type FindChangeInput struct {
	Query     string  `json:"query"`
	Replace   *string `json:"replace,omitempty" jsonschema:"set it to replace every match (formatting stays on its characters; with regex, $1 and $& work); leave it out to only list the matches"`
	MatchCase bool    `json:"matchCase,omitempty"`
	WholeWord bool    `json:"wholeWord,omitempty"`
	Regex     bool    `json:"regex,omitempty"`
	Limit     int     `json:"limit,omitempty" jsonschema:"matches listed, 1..500 (default 100)"`
}

type FindMatch struct {
	NodeId  string `json:"nodeId"`
	PageId  string `json:"pageId"`
	Start   int    `json:"start" jsonschema:"UTF-16 offset in the node's content"`
	End     int    `json:"end"`
	Text    string `json:"text"`
	Context string `json:"context"`
}

type FindChangeOutput struct {
	Count    int         `json:"count,omitempty" jsonschema:"matches in the whole document (when only listing)"`
	Matches  []FindMatch `json:"matches,omitempty"`
	Replaced int         `json:"replaced,omitempty"`
}

// FindChange searches the text of the whole document and optionally changes it.
func (s *Session) FindChange(ctx context.Context, in FindChangeInput) (FindChangeOutput, error) {
	args := map[string]any{"query": in.Query, "matchCase": in.MatchCase, "wholeWord": in.WholeWord, "regex": in.Regex}
	if in.Replace != nil {
		args["replace"] = *in.Replace
	}
	if in.Limit != 0 {
		args["limit"] = in.Limit
	}
	var out FindChangeOutput
	return out, s.runCommand(ctx, "find_change", "find_change", args, &out)
}

type OverrideMasterItemInput struct {
	PageId       string `json:"pageId" jsonschema:"a regular page"`
	MasterNodeId string `json:"masterNodeId" jsonschema:"the id of the item ON THE MASTER (not of its copy on the page)"`
}

type OverrideMasterItemOutput struct {
	CopiedNodeIds []string `json:"copiedNodeIds"`
}

// OverrideMasterItem gives a page its own editable copy of a master item.
func (s *Session) OverrideMasterItem(ctx context.Context, in OverrideMasterItemInput) (OverrideMasterItemOutput, error) {
	var out OverrideMasterItemOutput
	return out, s.runCommand(ctx, "override_master_item", "override_master_item", map[string]any{"pageId": in.PageId, "masterNodeId": in.MasterNodeId}, &out)
}

// --- commands that take a file ---------------------------------------------------------------------------

// PlaceInput places or imports a file the agent has on disk.
type FileAtInput struct {
	Path   string  `json:"path" jsonschema:"a file on the machine the MCP server runs on, at most 32 MiB"`
	PageId string  `json:"pageId,omitempty" jsonschema:"the page it lands on (the editor goes to that page); default: the page the editor is on"`
	X      float64 `json:"x,omitempty" jsonschema:"where the centre goes, in the page's coordinates"`
	Y      float64 `json:"y,omitempty"`
}

type NodeIdOutput struct {
	NodeId  string `json:"nodeId"`
	Message string `json:"message,omitempty" jsonschema:"what the importer reported (what it could not carry over)"`
}

func (in FileAtInput) args() map[string]any {
	a := map[string]any{"x": in.X, "y": in.Y}
	if in.PageId != "" {
		a["pageId"] = in.PageId
	}
	return a
}

// PlaceImage uploads an image file and places it as an image node.
func (s *Session) PlaceImage(ctx context.Context, in FileAtInput) (NodeIdOutput, error) {
	var out NodeIdOutput
	return out, s.runCommandWith(ctx, "place_image", "place_image", in.args(), in.Path, &out)
}

// ImportSvg imports an SVG file as editable nodes.
func (s *Session) ImportSvg(ctx context.Context, in FileAtInput) (NodeIdOutput, error) {
	var out NodeIdOutput
	return out, s.runCommandWith(ctx, "import_svg", "import_svg", in.args(), in.Path, &out)
}

type PlaceDocumentInput struct {
	FileAtInput
	Width float64 `json:"width,omitempty" jsonschema:"width of the text frame for .docx/.rtf (default 400)"`
}

type PlaceDocumentOutput struct {
	NodeId     string `json:"nodeId"`
	Kind       string `json:"kind" jsonschema:"text (Word, RTF) | table (Excel)"`
	Paragraphs int    `json:"paragraphs,omitempty"`
	Message    string `json:"message,omitempty"`
}

// PlaceDocument places a Word, RTF or Excel file: text with headings and bold/italic, or a table.
func (s *Session) PlaceDocument(ctx context.Context, in PlaceDocumentInput) (PlaceDocumentOutput, error) {
	a := in.args()
	if in.Width != 0 {
		a["width"] = in.Width
	}
	var out PlaceDocumentOutput
	return out, s.runCommandWith(ctx, "place_document", "place_document", a, in.Path, &out)
}

type ImportIdmlInput struct {
	Path string `json:"path" jsonschema:"an .idml file on the machine the MCP server runs on, at most 32 MiB"`
}

type ImportIdmlOutput struct {
	Pages   int    `json:"pages"`
	Nodes   int    `json:"nodes"`
	Message string `json:"message,omitempty"`
}

// ImportIdml adds the pages of an InDesign IDML file to the document.
func (s *Session) ImportIdml(ctx context.Context, in ImportIdmlInput) (ImportIdmlOutput, error) {
	var out ImportIdmlOutput
	return out, s.runCommandWith(ctx, "import_idml", "import_idml", map[string]any{}, in.Path, &out)
}

type RelinkImageInput struct {
	NodeId string `json:"nodeId" jsonschema:"an image node"`
	Path   string `json:"path" jsonschema:"the new image file; the node keeps its width and takes the new image's shape"`
}

// RelinkImage points an image node at another file.
func (s *Session) RelinkImage(ctx context.Context, in RelinkImageInput) (NodeIdOutput, error) {
	var out NodeIdOutput
	return out, s.runCommandWith(ctx, "relink_image", "relink_image", map[string]any{"nodeId": in.NodeId}, in.Path, &out)
}

type ImportPdfInput struct {
	Path string `json:"path"`
	Mode string `json:"mode,omitempty" jsonschema:"editable (default): text, shapes and images become nodes, fonts are extracted | image: each page becomes one picture"`
}

type ImportPdfOutput struct {
	Pages   int    `json:"pages"`
	Message string `json:"message,omitempty"`
}

// ImportPdf imports a PDF as pages.
func (s *Session) ImportPdf(ctx context.Context, in ImportPdfInput) (ImportPdfOutput, error) {
	a := map[string]any{}
	if in.Mode != "" {
		a["mode"] = in.Mode
	}
	var out ImportPdfOutput
	return out, s.runCommandWith(ctx, "import_pdf", "import_pdf", a, in.Path, &out)
}

type ImportFigInput struct {
	Path   string `json:"path" jsonschema:"a Figma .fig file (experimental reader)"`
	PageId string `json:"pageId,omitempty"`
}

type ImportFigOutput struct {
	Message  string   `json:"message"`
	Warnings []string `json:"warnings,omitempty"`
}

// ImportFig imports a .fig file.
func (s *Session) ImportFig(ctx context.Context, in ImportFigInput) (ImportFigOutput, error) {
	a := map[string]any{}
	if in.PageId != "" {
		a["pageId"] = in.PageId
	}
	var out ImportFigOutput
	return out, s.runCommandWith(ctx, "import_fig", "import_fig", a, in.Path, &out)
}

type UploadFontInput struct {
	Path   string `json:"path" jsonschema:"a TTF, OTF, WOFF or WOFF2 file"`
	Family string `json:"family" jsonschema:"the family name text styles will use"`
	Weight string `json:"weight,omitempty" jsonschema:"100..900 (default 400)"`
	Italic bool   `json:"italic,omitempty"`
}

type UploadFontOutput struct {
	FontId    string `json:"fontId"`
	AssetHash string `json:"assetHash"`
}

// UploadFont uploads a font file and registers it as a document font.
func (s *Session) UploadFont(ctx context.Context, in UploadFontInput) (UploadFontOutput, error) {
	a := map[string]any{"family": in.Family, "italic": in.Italic}
	if in.Weight != "" {
		a["weight"] = in.Weight
	}
	var out UploadFontOutput
	return out, s.runCommandWith(ctx, "upload_font", "upload_font", a, in.Path, &out)
}

// --- structure ---------------------------------------------------------------------------------------------

type NodeIdsInput struct {
	NodeIds []string `json:"nodeIds" jsonschema:"the nodes (a node inside a selected container is carried by the container)"`
}

type SelectionOutput struct {
	Selection []string `json:"selection,omitempty" jsonschema:"the nodes the operation produced or kept selected"`
}

// GroupNodes wraps nodes in a group.
func (s *Session) GroupNodes(ctx context.Context, in NodeIdsInput) (SelectionOutput, error) {
	var out SelectionOutput
	return out, s.runCommand(ctx, "group_nodes", "group_nodes", map[string]any{"nodeIds": in.NodeIds}, &out)
}

// UngroupNodes dissolves groups, keeping their children in place.
func (s *Session) UngroupNodes(ctx context.Context, in NodeIdsInput) (SelectionOutput, error) {
	var out SelectionOutput
	return out, s.runCommand(ctx, "ungroup_nodes", "ungroup_nodes", map[string]any{"nodeIds": in.NodeIds}, &out)
}

type AlignNodesInput struct {
	NodeIds []string `json:"nodeIds"`
	Command string   `json:"command" jsonschema:"left | hcenter | right | top | middle | bottom (to the selection's box, or the parent frame for one node) | distribute-h | distribute-v (equal gaps, three or more nodes)"`
}

type AlignOutput struct {
	Moved int `json:"moved" jsonschema:"how many nodes changed position"`
}

// AlignNodes aligns or distributes nodes.
func (s *Session) AlignNodes(ctx context.Context, in AlignNodesInput) (AlignOutput, error) {
	var out AlignOutput
	return out, s.runCommand(ctx, "align_nodes", "align_nodes", map[string]any{"nodeIds": in.NodeIds, "command": in.Command}, &out)
}

type BooleanInput struct {
	NodeIds []string `json:"nodeIds" jsonschema:"two or more shapes (rectangles, ellipses, vectors), or ONE live boolean group to change its operation"`
	Op      string   `json:"op" jsonschema:"union | subtract (the bottom shape minus the others) | intersect | exclude"`
}

type GroupIdOutput struct {
	GroupId string `json:"groupId"`
}

// BooleanOperation combines shapes into a live boolean group.
func (s *Session) BooleanOperation(ctx context.Context, in BooleanInput) (GroupIdOutput, error) {
	var out GroupIdOutput
	return out, s.runCommand(ctx, "boolean_operation", "boolean_operation", map[string]any{"nodeIds": in.NodeIds, "op": in.Op}, &out)
}

type FlattenInput struct {
	GroupId string `json:"groupId" jsonschema:"a live boolean group (or any group of shapes)"`
}

type NodeOnlyOutput struct {
	NodeId string `json:"nodeId"`
}

// FlattenBoolean turns a boolean group into one plain vector.
func (s *Session) FlattenBoolean(ctx context.Context, in FlattenInput) (NodeOnlyOutput, error) {
	var out NodeOnlyOutput
	return out, s.runCommand(ctx, "flatten_boolean", "flatten_boolean", map[string]any{"groupId": in.GroupId}, &out)
}

type OutlineStrokeInput struct {
	NodeId string `json:"nodeId"`
}

// OutlineStroke turns a node's stroke into a filled vector.
func (s *Session) OutlineStroke(ctx context.Context, in OutlineStrokeInput) (NodeOnlyOutput, error) {
	var out NodeOnlyOutput
	return out, s.runCommand(ctx, "outline_stroke", "outline_stroke", map[string]any{"nodeId": in.NodeId}, &out)
}

type DuplicateNodesOutput struct {
	NodeIds []string `json:"nodeIds" jsonschema:"the copies, offset from the originals like a paste"`
}

// DuplicateNodes copies nodes next to themselves.
func (s *Session) DuplicateNodes(ctx context.Context, in NodeIdsInput) (DuplicateNodesOutput, error) {
	var out DuplicateNodesOutput
	return out, s.runCommand(ctx, "duplicate_nodes", "duplicate_nodes", map[string]any{"nodeIds": in.NodeIds}, &out)
}

type ReorderInput struct {
	NodeId string `json:"nodeId"`
	To     string `json:"to" jsonschema:"front | back | forward | backward: its place in the stack among its siblings (the last is drawn on top)"`
}

type MovedOutput struct {
	Moved bool `json:"moved" jsonschema:"false when it was already there"`
}

// ReorderNode moves a node in the stacking order.
func (s *Session) ReorderNode(ctx context.Context, in ReorderInput) (MovedOutput, error) {
	var out MovedOutput
	return out, s.runCommand(ctx, "reorder_node", "reorder_node", map[string]any{"nodeId": in.NodeId, "to": in.To}, &out)
}

// --- long documents -----------------------------------------------------------------------------------------

type ApplyTableStyleInput struct {
	TableId string `json:"tableId" jsonschema:"the table's group node, or any of its cells"`
	StyleId string `json:"styleId" jsonschema:"a table style from set_document_settings tableStyles"`
}

type ApplyTableStyleOutput struct {
	TableId string `json:"tableId"`
	Changed int    `json:"changed" jsonschema:"how many operations it took (0 = the table already looked like that)"`
}

// ApplyTableStyle gives a table the object and text styles of a table style.
func (s *Session) ApplyTableStyle(ctx context.Context, in ApplyTableStyleInput) (ApplyTableStyleOutput, error) {
	var out ApplyTableStyleOutput
	return out, s.runCommand(ctx, "apply_table_style", "apply_table_style", map[string]any{"tableId": in.TableId, "styleId": in.StyleId}, &out)
}

type CheckTextInput struct {
	Checks []string `json:"checks,omitempty" jsonschema:"limit to: repeated-word | double-space | space-before-punctuation | straight-quote | three-dots | spaced-hyphen (default: all)"`
	Limit  int      `json:"limit,omitempty" jsonschema:"1..2000 (default 200)"`
}

type TextIssueView struct {
	Code    string `json:"code"`
	NodeId  string `json:"nodeId"`
	PageId  string `json:"pageId"`
	Start   int    `json:"start" jsonschema:"UTF-16 offset in the node's content (with hidden conditional text removed)"`
	End     int    `json:"end"`
	Text    string `json:"text"`
	Message string `json:"message"`
}

type CheckTextOutput struct {
	Count  int             `json:"count"`
	Issues []TextIssueView `json:"issues"`
}

// CheckText finds typographic slips in the document's text.
func (s *Session) CheckText(ctx context.Context, in CheckTextInput) (CheckTextOutput, error) {
	a := map[string]any{}
	if len(in.Checks) > 0 {
		a["checks"] = in.Checks
	}
	if in.Limit != 0 {
		a["limit"] = in.Limit
	}
	var out CheckTextOutput
	return out, s.runCommand(ctx, "check_text", "check_text", a, &out)
}

type EditorialNoteView struct {
	NodeId  string `json:"nodeId"`
	PageId  string `json:"pageId"`
	At      int    `json:"at" jsonschema:"offset of the [!...] marker in the node's content"`
	Text    string `json:"text"`
	Context string `json:"context" jsonschema:"the words just before the marker"`
}

type ListEditorialNotesOutput struct {
	Notes []EditorialNoteView `json:"notes"`
}

// ListEditorialNotes lists the [!comment] notes of the document.
func (s *Session) ListEditorialNotes(ctx context.Context, _ struct{}) (ListEditorialNotesOutput, error) {
	var out ListEditorialNotesOutput
	return out, s.runCommand(ctx, "list_editorial_notes", "list_editorial_notes", nil, &out)
}

// --- object tools ---------------------------------------------------------------------------------------

func rgbaArg(c *RGBA) map[string]any {
	return map[string]any{"r": c.R, "g": c.G, "b": c.B, "a": c.A}
}

type StepAndRepeatInput struct {
	NodeIds []string `json:"nodeIds"`
	Count   int      `json:"count" jsonschema:"how many further copies, 1..200"`
	Dx      float64  `json:"dx" jsonschema:"offset of each copy from the previous one, in document units"`
	Dy      float64  `json:"dy"`
}

// StepAndRepeat makes a row, column or grid of copies.
func (s *Session) StepAndRepeat(ctx context.Context, in StepAndRepeatInput) (DuplicateNodesOutput, error) {
	var out DuplicateNodesOutput
	return out, s.runCommand(ctx, "step_and_repeat", "step_and_repeat", map[string]any{"nodeIds": in.NodeIds, "count": in.Count, "dx": in.Dx, "dy": in.Dy}, &out)
}

type SetGapInput struct {
	NodeIds []string `json:"nodeIds" jsonschema:"two or more nodes; the first (left or top) stays where it is"`
	Axis    string   `json:"axis" jsonschema:"x (side by side) | y (stacked)"`
	Gap     float64  `json:"gap" jsonschema:"the space between neighbouring objects, in document units (may be negative to overlap)"`
}

type MovedCountOutput struct {
	Moved int `json:"moved"`
}

// SetGap is the Gap tool: it sets the space between neighbours.
func (s *Session) SetGap(ctx context.Context, in SetGapInput) (MovedCountOutput, error) {
	var out MovedCountOutput
	return out, s.runCommand(ctx, "set_gap", "set_gap", map[string]any{"nodeIds": in.NodeIds, "axis": in.Axis, "gap": in.Gap}, &out)
}

type FitFrameInput struct {
	NodeId string `json:"nodeId"`
	Mode   string `json:"mode" jsonschema:"fill (image fill covers the frame) | fit (whole image inside the frame) | tile | frame-to-content (resize an image node to the image's own proportions, keeping its width)"`
}

type ChangedOutput struct {
	Changed int `json:"changed" jsonschema:"operations applied (0 = already so)"`
}

// FitFrame fits an image to its frame, or the frame to its image.
func (s *Session) FitFrame(ctx context.Context, in FitFrameInput) (ChangedOutput, error) {
	var out ChangedOutput
	return out, s.runCommand(ctx, "fit_frame", "fit_frame", map[string]any{"nodeId": in.NodeId, "mode": in.Mode}, &out)
}

type ClipWithShapeInput struct {
	ShapeId    string   `json:"shapeId" jsonschema:"a rectangle, ellipse, frame or vector whose outline is the clipping path"`
	ContentIds []string `json:"contentIds,omitempty" jsonschema:"what to clip; ignored when release is true"`
	Release    bool     `json:"release,omitempty" jsonschema:"true: stop using shapeId as a clipping path (the group stays)"`
}

type ClipOutput struct {
	GroupId  string `json:"groupId,omitempty"`
	Released bool   `json:"released,omitempty"`
}

// ClipWithShape clips content to a shape's outline.
func (s *Session) ClipWithShape(ctx context.Context, in ClipWithShapeInput) (ClipOutput, error) {
	a := map[string]any{"shapeId": in.ShapeId}
	if in.Release {
		a["release"] = true
	} else {
		a["contentIds"] = in.ContentIds
	}
	var out ClipOutput
	return out, s.runCommand(ctx, "clip_with_shape", "clip_with_shape", a, &out)
}

type CreateQRCodeInput struct {
	Text     string  `json:"text" jsonschema:"UTF-8 text or a URL, up to 271 bytes at level L (fewer at higher levels)"`
	Level    string  `json:"level,omitempty" jsonschema:"error correction L | M (default) | Q | H"`
	X        float64 `json:"x,omitempty"`
	Y        float64 `json:"y,omitempty"`
	Size     float64 `json:"size,omitempty" jsonschema:"side of the square including its quiet zone (default 128)"`
	PageId   string  `json:"pageId,omitempty"`
	ParentId string  `json:"parentId,omitempty"`
	Dark     *RGBA   `json:"dark,omitempty" jsonschema:"module colour (default black)"`
	Light    *RGBA   `json:"light,omitempty" jsonschema:"background colour (default white)"`
}

// CreateQRCode draws a QR code as vectors.
func (s *Session) CreateQRCode(ctx context.Context, in CreateQRCodeInput) (GroupIdOutput, error) {
	a := map[string]any{"text": in.Text, "x": in.X, "y": in.Y}
	if in.Level != "" {
		a["level"] = in.Level
	}
	if in.Size != 0 {
		a["size"] = in.Size
	}
	if in.PageId != "" {
		a["pageId"] = in.PageId
	}
	if in.ParentId != "" {
		a["parentId"] = in.ParentId
	}
	if in.Dark != nil {
		a["dark"] = rgbaArg(in.Dark)
	}
	if in.Light != nil {
		a["light"] = rgbaArg(in.Light)
	}
	var out GroupIdOutput
	return out, s.runCommand(ctx, "create_qr_code", "create_qr_code", a, &out)
}

type ObjectQueryInput struct {
	Kind        string `json:"kind,omitempty" jsonschema:"rect | ellipse | text | image | vector | group | frame | instance"`
	NameMatches string `json:"nameMatches,omitempty" jsonschema:"regular expression on the layer name, case-insensitive"`
	Fill        *RGBA  `json:"fill,omitempty" jsonschema:"nodes with a solid fill of this colour"`
	Stroke      *RGBA  `json:"stroke,omitempty"`
	PageId      string `json:"pageId,omitempty"`
}

func (q ObjectQueryInput) args() map[string]any {
	a := map[string]any{}
	if q.Kind != "" {
		a["kind"] = q.Kind
	}
	if q.NameMatches != "" {
		a["nameMatches"] = q.NameMatches
	}
	if q.Fill != nil {
		a["fill"] = rgbaArg(q.Fill)
	}
	if q.Stroke != nil {
		a["stroke"] = rgbaArg(q.Stroke)
	}
	if q.PageId != "" {
		a["pageId"] = q.PageId
	}
	return a
}

type FoundObject struct {
	Id   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type FindObjectsOutput struct {
	Count int           `json:"count"`
	Nodes []FoundObject `json:"nodes" jsonschema:"up to 500"`
}

// FindObjects finds nodes by kind, name or colour (give at least one criterion).
func (s *Session) FindObjects(ctx context.Context, in ObjectQueryInput) (FindObjectsOutput, error) {
	var out FindObjectsOutput
	return out, s.runCommand(ctx, "find_objects", "find_objects", in.args(), &out)
}

type ObjectChangeIO struct {
	Fill         *RGBA    `json:"fill,omitempty" jsonschema:"replaces the matching solid fill (all solid fills when the query names no fill colour)"`
	Stroke       *RGBA    `json:"stroke,omitempty"`
	StrokeWeight *float64 `json:"strokeWeight,omitempty"`
	Opacity      *float64 `json:"opacity,omitempty" jsonschema:"0..1"`
	Visible      *bool    `json:"visible,omitempty"`
	Rename       *string  `json:"rename,omitempty"`
}

type ChangeObjectsInput struct {
	ObjectQueryInput
	Change ObjectChangeIO `json:"change"`
}

type ChangeObjectsOutput struct {
	Matched int `json:"matched"`
	Changed int `json:"changed"`
}

// ChangeObjects finds nodes and changes their appearance in one undo step.
func (s *Session) ChangeObjects(ctx context.Context, in ChangeObjectsInput) (ChangeObjectsOutput, error) {
	a := in.ObjectQueryInput.args()
	c := map[string]any{}
	if in.Change.Fill != nil {
		c["fill"] = rgbaArg(in.Change.Fill)
	}
	if in.Change.Stroke != nil {
		c["stroke"] = rgbaArg(in.Change.Stroke)
	}
	if in.Change.StrokeWeight != nil {
		c["strokeWeight"] = *in.Change.StrokeWeight
	}
	if in.Change.Opacity != nil {
		c["opacity"] = *in.Change.Opacity
	}
	if in.Change.Visible != nil {
		c["visible"] = *in.Change.Visible
	}
	if in.Change.Rename != nil {
		c["rename"] = *in.Change.Rename
	}
	a["change"] = c
	var out ChangeObjectsOutput
	return out, s.runCommand(ctx, "change_objects", "change_objects", a, &out)
}

type ExportSnippetOutput struct {
	Snippet string `json:"snippet" jsonschema:"opaque text to keep and pass to place_snippet (in this or another document)"`
}

// ExportSnippet turns nodes (and their children) into a reusable snippet.
func (s *Session) ExportSnippet(ctx context.Context, in NodeIdsInput) (ExportSnippetOutput, error) {
	var out ExportSnippetOutput
	return out, s.runCommand(ctx, "export_snippet", "export_snippet", map[string]any{"nodeIds": in.NodeIds}, &out)
}

type PlaceSnippetInput struct {
	Snippet  string  `json:"snippet"`
	X        float64 `json:"x,omitempty" jsonschema:"where its top-left corner goes"`
	Y        float64 `json:"y,omitempty"`
	PageId   string  `json:"pageId,omitempty"`
	ParentId string  `json:"parentId,omitempty"`
}

// PlaceSnippet places a snippet made by export_snippet.
func (s *Session) PlaceSnippet(ctx context.Context, in PlaceSnippetInput) (DuplicateNodesOutput, error) {
	a := map[string]any{"snippet": in.Snippet, "x": in.X, "y": in.Y}
	if in.PageId != "" {
		a["pageId"] = in.PageId
	}
	if in.ParentId != "" {
		a["parentId"] = in.ParentId
	}
	var out DuplicateNodesOutput
	return out, s.runCommand(ctx, "place_snippet", "place_snippet", a, &out)
}

// --- vectors ------------------------------------------------------------------------------------------

type AnchorIO struct {
	X    float64 `json:"x" jsonschema:"in the parent's coordinates"`
	Y    float64 `json:"y"`
	InX  float64 `json:"inX,omitempty" jsonschema:"incoming handle, RELATIVE to the anchor; 0,0 = none (a straight segment)"`
	InY  float64 `json:"inY,omitempty"`
	OutX float64 `json:"outX,omitempty" jsonschema:"outgoing handle, relative to the anchor"`
	OutY float64 `json:"outY,omitempty"`
}

type PathIO struct {
	Closed  bool       `json:"closed,omitempty" jsonschema:"closed paths are filled; an open one is a line"`
	Anchors []AnchorIO `json:"anchors"`
}

type StrokeIO struct {
	Color  RGBA    `json:"color"`
	Weight float64 `json:"weight"`
}

type CreateVectorInput struct {
	PageId   string    `json:"pageId,omitempty"`
	ParentId string    `json:"parentId,omitempty" jsonschema:"a frame or group to put it in (default: the page)"`
	Name     string    `json:"name,omitempty"`
	Paths    []PathIO  `json:"paths" jsonschema:"one or more paths (an outline and its holes, or several shapes as one object)"`
	Fill     *RGBA     `json:"fill,omitempty"`
	Stroke   *StrokeIO `json:"stroke,omitempty"`
}

type VectorOutput struct {
	NodeId string  `json:"nodeId"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width" jsonschema:"the true bounds of the curve, which the editor computes"`
	Height float64 `json:"height"`
}

// CreateVector draws a vector node from anchors and handles.
func (s *Session) CreateVector(ctx context.Context, in CreateVectorInput) (VectorOutput, error) {
	args := map[string]any{"paths": in.Paths}
	if in.PageId != "" {
		args["pageId"] = in.PageId
	}
	if in.ParentId != "" {
		args["parentId"] = in.ParentId
	}
	if in.Name != "" {
		args["nodeName"] = in.Name
	}
	if in.Fill != nil {
		args["fill"] = map[string]any{"r": in.Fill.R, "g": in.Fill.G, "b": in.Fill.B, "a": in.Fill.A}
	}
	if in.Stroke != nil {
		args["stroke"] = map[string]any{"color": map[string]any{"r": in.Stroke.Color.R, "g": in.Stroke.Color.G, "b": in.Stroke.Color.B, "a": in.Stroke.Color.A}, "weight": in.Stroke.Weight}
	}
	var out VectorOutput
	return out, s.runCommand(ctx, "create_vector", "create_vector", args, &out)
}

type SetVectorPathInput struct {
	NodeId string   `json:"nodeId" jsonschema:"a vector node"`
	Paths  []PathIO `json:"paths" jsonschema:"replaces the geometry; the node's box follows it"`
}

// SetVectorPath replaces a vector's geometry.
func (s *Session) SetVectorPath(ctx context.Context, in SetVectorPathInput) (VectorOutput, error) {
	var out VectorOutput
	return out, s.runCommand(ctx, "set_vector_path", "set_vector_path", map[string]any{"nodeId": in.NodeId, "paths": in.Paths}, &out)
}

func registerCommandTools(srv *mcp.Server, s *Session) {
	addTool(srv, "generate_contents", "Write (or refresh) the document's table of contents or index into a generated text frame. The contents lists the headings (paragraphs whose paragraph style has an outline level, set_text_style outlineLevel) with page numbers; the index lists the terms marked [#term] in the text."+jobNote, s.GenerateContents)
	addTool(srv, "insert_table", "Build a table (rows x cols of equal cells, header rows) on a page. A table is a group of rectangles and texts; edit it with edit_table and set_text on its cells."+jobNote, s.InsertTable)
	addTool(srv, "edit_table", "Add, delete or resize a row or column of a table made with insert_table."+jobNote, s.EditTable)
	addTool(srv, "find_change", "Find (and optionally change) text across every text of the document, master pages included, in reading order: plain, whole word or regular expression, with or without case. Without `replace` it lists the matches; with it, it replaces them all in one undo step and keeps the formatting."+jobNote, s.FindChange)
	addTool(srv, "place_image", "Upload an image file (PNG, JPEG, GIF, WebP) and place it as an image node, scaled down to at most 512 px on its long side. An SVG is imported as editable nodes instead (import_svg)."+jobNote, s.PlaceImage)
	addTool(srv, "import_svg", "Import an SVG file as editable nodes (shapes, text, gradients, embedded images), centred at x, y."+jobNote, s.ImportSvg)
	addTool(srv, "place_document", "Place a Word (.docx), RTF or Excel (.xlsx) file: Word/RTF become one text frame with paragraph styles (Heading 1-3 get an outline level, so the contents list them) and bold/italic runs; the first Excel sheet becomes a table. Images, tables and footnotes inside Word files, fonts, colours and formulas are not carried over (Excel gives cached values)."+jobNote, s.PlaceDocument)
	addTool(srv, "import_idml", "Import an InDesign IDML file: its pages (with their sizes) are added to the document with rectangles, ovals, polygons, lines (as vectors with their handles) and text frames with their story text, solid fills and strokes (CMYK converted to RGB, naively). Images, effects, styles, master pages, tables and gradients are not carried over; rotation of boxes is not kept. INDD files cannot be opened."+jobNote, s.ImportIdml)
	addTool(srv, "relink_image", "Point an image node at another file (the document's 'Relink'): the node keeps its width and takes the new image's shape."+jobNote, s.RelinkImage)
	addTool(srv, "import_pdf", "Import a PDF: every page becomes a page of the document; mode editable (default) turns text, shapes and images into nodes and extracts the embedded fonts, mode image makes one picture per page. Up to 200 pages."+jobNote, s.ImportPdf)
	addTool(srv, "import_fig", "Import a Figma .fig file (experimental reader; says what it could not carry over)."+jobNote, s.ImportFig)
	addTool(srv, "upload_font", "Upload a font file and register it as a document font (family, weight, style); text styles whose fontFamily is that family then draw with it, and the PDF export embeds it."+jobNote, s.UploadFont)
	addTool(srv, "apply_table_style", "Give a table the object styles (cell rectangles) and text styles (cell texts) of a table style: header rows, body rows, every second body row. Define table styles with set_document_settings tableStyles."+jobNote, s.ApplyTableStyle)
	addTool(srv, "check_text", "Typographic slips in the text of the whole document: repeated words, double spaces, a space before , . ; :, straight quotes, three dots instead of an ellipsis, a spaced hyphen instead of an en dash. NOT a dictionary spell check (no word list ships with the editor; the browser's spell check marks misspellings while you type)."+jobNote, s.CheckText)
	addTool(srv, "list_editorial_notes", "The editorial notes written [!comment] in the text: never drawn, exported or printed. Write one with set_text; remove it by editing the text."+jobNote, s.ListEditorialNotes)
	addTool(srv, "step_and_repeat", "Step and Repeat: make N copies of nodes, each offset (dx, dy) from the previous (a row, a column, a staircase). Groups are copied with their children."+jobNote, s.StepAndRepeat)
	addTool(srv, "set_gap", "The Gap tool: set the exact space between neighbouring objects along x or y, keeping the first one in place."+jobNote, s.SetGap)
	addTool(srv, "fit_frame", "Frame fitting: make an image fill cover or fit inside its frame, tile it, or resize an image node to the image's own proportions."+jobNote, s.FitFrame)
	addTool(srv, "clip_with_shape", "Clipping path: use a shape's outline to clip other nodes (they are grouped with it, the shape as a mask below them); release it with release=true."+jobNote, s.ClipWithShape)
	addTool(srv, "create_qr_code", "Draw a QR code (ISO 18004, byte mode, versions 1-10) as vectors: a background square and one vector for the dark modules, so it prints sharp at any size."+jobNote, s.CreateQRCode)
	addTool(srv, "find_objects", "Find nodes by kind, layer name (regex) or solid fill/stroke colour."+jobNote, s.FindObjects)
	addTool(srv, "change_objects", "Find/change on objects: find nodes as find_objects does and change fill, stroke, stroke weight, opacity, visibility or name in one undo step. With a fill colour in the query, only fills of that colour are replaced."+jobNote, s.ChangeObjects)
	addTool(srv, "export_snippet", "Turn nodes and their children into a snippet (text) to keep in a library and place later, here or in another document. Images keep their asset reference, so they show only where that asset exists."+jobNote, s.ExportSnippet)
	addTool(srv, "place_snippet", "Place a snippet made by export_snippet with its top-left corner at x, y."+jobNote, s.PlaceSnippet)
	addTool(srv, "create_vector", "Draw a vector from paths of anchors with optional bezier handles (handles are offsets from their anchor). The editor computes the curve's true bounds for the node's box (one implementation of that geometry), so use this rather than writing a vector by hand."+jobNote, s.CreateVector)
	addTool(srv, "set_vector_path", "Replace a vector node's geometry; its box follows the new curve in the same step."+jobNote, s.SetVectorPath)
	addTool(srv, "group_nodes", "Wrap nodes in a group (they keep their stacking order inside it)."+jobNote, s.GroupNodes)
	addTool(srv, "ungroup_nodes", "Dissolve groups, leaving their children in place."+jobNote, s.UngroupNodes)
	addTool(srv, "align_nodes", "Align (left, hcenter, right, top, middle, bottom) or distribute (distribute-h, distribute-v) nodes."+jobNote, s.AlignNodes)
	addTool(srv, "boolean_operation", "Union, subtract, intersect or exclude shapes into a LIVE boolean group (the shapes stay editable children); pass one existing boolean group to change its operation."+jobNote, s.BooleanOperation)
	addTool(srv, "flatten_boolean", "Turn a boolean group into one plain vector node (the shapes go)."+jobNote, s.FlattenBoolean)
	addTool(srv, "outline_stroke", "Turn a node's stroke into a filled vector outline."+jobNote, s.OutlineStroke)
	addTool(srv, "duplicate_nodes", "Copy nodes, offset from the originals like a paste."+jobNote, s.DuplicateNodes)
	addTool(srv, "reorder_node", "Move a node in the stacking order among its siblings: front, back, forward one, backward one."+jobNote, s.ReorderNode)
	addTool(srv, "override_master_item", "Give a page its own editable copy of an item that comes from its master (the master's item stops being drawn on that page)."+jobNote, s.OverrideMasterItem)
}
