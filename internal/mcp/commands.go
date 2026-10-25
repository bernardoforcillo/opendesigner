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
	Kind     string `json:"kind" jsonschema:"toc (table of contents from the heading styles) | index (from the [#term] marks in the text)"`
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
	addTool(srv, "relink_image", "Point an image node at another file (the document's 'Relink'): the node keeps its width and takes the new image's shape."+jobNote, s.RelinkImage)
	addTool(srv, "import_pdf", "Import a PDF: every page becomes a page of the document; mode editable (default) turns text, shapes and images into nodes and extracts the embedded fonts, mode image makes one picture per page. Up to 200 pages."+jobNote, s.ImportPdf)
	addTool(srv, "import_fig", "Import a Figma .fig file (experimental reader; says what it could not carry over)."+jobNote, s.ImportFig)
	addTool(srv, "upload_font", "Upload a font file and register it as a document font (family, weight, style); text styles whose fontFamily is that family then draw with it, and the PDF export embeds it."+jobNote, s.UploadFont)
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
