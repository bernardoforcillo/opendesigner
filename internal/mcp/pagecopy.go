package mcp

import (
	"context"
	"fmt"
	"sort"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/datamerge"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
)

// duplicate_page and data_merge: a page copied with every node under it (new ids), and a template page
// repeated once per record of a table. The copy keeps the sheet, the master and the guides; a text thread inside the
// page stays linked in the copy.

const (
	maxCopies  = 50
	maxRecords = 500
	metaNext   = "text.next"
)

// pageCopy is a page with the nodes under it, parents before children.
type pageCopy struct {
	page  *opendesignerv1.Page
	nodes []*opendesignerv1.Node
	index int
}

func (s *Session) snapshotPage(pageID string) (*pageCopy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.doc.GetPages() {
		if p.GetId() != pageID {
			continue
		}
		pc := &pageCopy{page: proto.Clone(p).(*opendesignerv1.Page), index: i}
		kids := map[string][]*opendesignerv1.Node{}
		for _, n := range s.doc.GetNodes() {
			kids[n.GetParentId()] = append(kids[n.GetParentId()], n)
		}
		for _, list := range kids {
			sort.Slice(list, func(a, b int) bool {
				if list[a].GetOrderKey() != list[b].GetOrderKey() {
					return list[a].GetOrderKey() < list[b].GetOrderKey()
				}
				return list[a].GetId() < list[b].GetId()
			})
		}
		queue := append([]*opendesignerv1.Node(nil), kids[pageID]...)
		for len(queue) > 0 {
			n := queue[0]
			queue = queue[1:]
			pc.nodes = append(pc.nodes, proto.Clone(n).(*opendesignerv1.Node))
			queue = append(queue, kids[n.GetId()]...)
		}
		return pc, nil
	}
	return nil, fmt.Errorf("no page %q", pageID)
}

// place writes a copy of pc as a new page called name at index; edit may change each copied node first.
func (s *Session) place(ctx context.Context, pc *pageCopy, name string, index int, edit func(*opendesignerv1.Node)) (string, error) {
	newID := uuid.NewString()
	page := proto.Clone(pc.page).(*opendesignerv1.Page)
	page.Id, page.Name = newID, name
	if _, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: page}}}); err != nil {
		return "", err
	}
	ids := map[string]string{}
	for _, n := range pc.nodes {
		ids[n.GetId()] = uuid.NewString()
	}
	for _, n := range pc.nodes {
		c := proto.Clone(n).(*opendesignerv1.Node)
		c.Id = ids[n.GetId()]
		if np, ok := ids[n.GetParentId()]; ok {
			c.ParentId = np
		} else {
			c.ParentId = newID
		}
		if next, ok := c.GetMeta()[metaNext]; ok {
			if nn, in := ids[next]; in {
				c.Meta[metaNext] = nn
			} else {
				delete(c.Meta, metaNext) // a link to a frame on another page is dropped
			}
		}
		if edit != nil {
			edit(c)
		}
		if _, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: c}}}); err != nil {
			return "", err
		}
	}
	if _, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_MovePage{MovePage: &opendesignerv1.MovePage{Id: newID, Index: uint32(index)}}}); err != nil {
		return "", err
	}
	return newID, nil
}

type DuplicatePageInput struct {
	Id     string `json:"id" jsonschema:"the page to copy"`
	Name   string `json:"name,omitempty" jsonschema:"name of the copy (default '<name> copy'; with several copies, numbered)"`
	Copies int    `json:"copies,omitempty" jsonschema:"how many copies, 1..50 (default 1); each follows the previous"`
}

type PagesOutput struct {
	PageIds []string `json:"pageIds"`
}

// DuplicatePage copies a page right after itself.
func (s *Session) DuplicatePage(ctx context.Context, in DuplicatePageInput) (PagesOutput, error) {
	n := in.Copies
	if n == 0 {
		n = 1
	}
	if n < 1 || n > maxCopies {
		return PagesOutput{}, fmt.Errorf("duplicate_page: copies must be 1..%d", maxCopies)
	}
	pc, err := s.snapshotPage(in.Id)
	if err != nil {
		return PagesOutput{}, fmt.Errorf("duplicate_page: %w", err)
	}
	out := PagesOutput{PageIds: []string{}}
	for k := 0; k < n; k++ {
		name := in.Name
		if name == "" {
			name = pc.page.GetName() + " copy"
		}
		if n > 1 {
			name = fmt.Sprintf("%s %d", name, k+1)
		}
		id, err := s.place(ctx, pc, name, pc.index+1+k, nil)
		if err != nil {
			return out, fmt.Errorf("duplicate_page: %w", err)
		}
		out.PageIds = append(out.PageIds, id)
	}
	return out, nil
}

type DataMergeInput struct {
	PageId string `json:"pageId" jsonschema:"the template page: its text (and a node's link.url meta) holds {{Field}} placeholders"`
	Table  string `json:"table" jsonschema:"the records as CSV, semicolon or tab separated text; the first row names the fields"`
}

type DataMergeOutput struct {
	PageIds       []string `json:"pageIds" jsonschema:"the merged pages, one per record, after the template"`
	MissingFields []string `json:"missingFields,omitempty" jsonschema:"placeholders with no column: left as written"`
	UnusedFields  []string `json:"unusedFields,omitempty" jsonschema:"columns no placeholder uses"`
}

// DataMerge adds one page per record of the table after the template page, with the values in place of the placeholders.
func (s *Session) DataMerge(ctx context.Context, in DataMergeInput) (DataMergeOutput, error) {
	tbl := datamerge.ParseTable(in.Table)
	if len(tbl.Headers) == 0 || len(tbl.Rows) == 0 {
		return DataMergeOutput{}, fmt.Errorf("data_merge: the table needs a header row and at least one record")
	}
	if len(tbl.Rows) > maxRecords {
		return DataMergeOutput{}, fmt.Errorf("data_merge: at most %d records at a time", maxRecords)
	}
	pc, err := s.snapshotPage(in.PageId)
	if err != nil {
		return DataMergeOutput{}, fmt.Errorf("data_merge: %w", err)
	}
	if pc.page.GetIsMaster() {
		return DataMergeOutput{}, fmt.Errorf("data_merge: a master page cannot be the template")
	}
	used := map[string]bool{}
	var order []string
	for _, n := range pc.nodes {
		fields := datamerge.FieldsIn(n.GetMeta()["link.url"])
		if t := n.GetText(); t != nil {
			fields = append(fields, datamerge.FieldsIn(t.GetContent())...)
		}
		for _, f := range fields {
			if !used[f] {
				used[f] = true
				order = append(order, f)
			}
		}
	}
	has := map[string]bool{}
	for _, h := range tbl.Headers {
		has[h] = true
	}
	out := DataMergeOutput{PageIds: []string{}}
	for _, f := range order {
		if !has[f] {
			out.MissingFields = append(out.MissingFields, f)
		}
	}
	for _, h := range tbl.Headers {
		if h != "" && !used[h] {
			out.UnusedFields = append(out.UnusedFields, h)
		}
	}
	for k, row := range tbl.Rows {
		rec := tbl.Record(row)
		id, err := s.place(ctx, pc, fmt.Sprintf("%s %d", pc.page.GetName(), k+1), pc.index+1+k, func(n *opendesignerv1.Node) { mergeNode(n, rec) })
		if err != nil {
			return out, fmt.Errorf("data_merge: record %d: %w", k+1, err)
		}
		out.PageIds = append(out.PageIds, id)
	}
	return out, nil
}

// mergeNode puts a record into a node's text, its style runs and its link.
func mergeNode(n *opendesignerv1.Node, rec map[string]string) {
	if t := n.GetText(); t != nil {
		sub := datamerge.Substitute(t.GetContent(), rec)
		if sub.Text != t.GetContent() {
			t.Content = sub.Text
			runs := t.Runs[:0:0]
			for _, r := range t.GetRuns() {
				start, end := sub.Map(int(r.GetStart())), sub.Map(int(r.GetEnd()))
				if end > start {
					runs = append(runs, &opendesignerv1.TextRun{Start: int32(start), End: int32(end), StyleId: r.GetStyleId()})
				}
			}
			t.Runs = runs
		}
	}
	if url, ok := n.GetMeta()["link.url"]; ok && utf8.ValidString(url) {
		n.Meta["link.url"] = datamerge.Substitute(url, rec).Text
	}
}

func registerPageCopyTools(srv *mcp.Server, s *Session) {
	addTool(srv, "duplicate_page", "Copy a page with every node under it (new ids) right after itself, keeping its sheet, master and guides; a text thread inside the page stays linked in the copy.", s.DuplicatePage)
	addTool(srv, "data_merge", "Data merge: a template page with {{Field}} placeholders in its text (and in a node's link.url meta) is repeated once per record of a CSV table (first row = field names), each copy with the record's values; line breaks in a value become spaces; style runs follow the replaced text. A placeholder with no column stays as written and is reported. Images are not merged. Up to 500 records.", s.DataMerge)
}
