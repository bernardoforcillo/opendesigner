package mcp

import (
	"context"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
)

// verticalName is the name the tools report: an unset vertical is "product".
func verticalName(v string) string {
	if v == "" {
		return "product"
	}
	return v
}

type SetDocumentSettingsInput struct {
	Vertical          *string  `json:"vertical,omitempty" jsonschema:"publishing (books, magazines, reports: pages, masters, text frames, PDF/EPUB) | design (illustration, UI design, boards) | product (design and development together: flows, prototype, code). Shapes the editor, never limits what the document can hold"`
	BaselineIncrement *float64 `json:"baselineIncrement,omitempty" jsonschema:"distance between baseline grid lines, 0..1000; 0 = no grid"`
	BaselineStart     *float64 `json:"baselineStart,omitempty" jsonschema:"where the first baseline grid line sits, from the top of the page"`
}

// SetDocumentSettings changes the vertical and / or the baseline grid; fields left out keep their value.
func (s *Session) SetDocumentSettings(ctx context.Context, in SetDocumentSettingsInput) (SeqOutput, error) {
	s.mu.Lock()
	next := &opendesignerv1.DocSettings{}
	if cur := s.doc.GetSettings(); cur != nil {
		next = proto.Clone(cur).(*opendesignerv1.DocSettings)
	}
	s.mu.Unlock()
	if in.Vertical != nil {
		v := *in.Vertical
		if v == "product" {
			v = "" // the default is stored as nothing
		}
		next.Vertical = v
	}
	if in.BaselineIncrement != nil {
		next.BaselineIncrement = *in.BaselineIncrement
	}
	if in.BaselineStart != nil {
		next.BaselineStart = *in.BaselineStart
	}
	if err := core.ValidateDocSettings(next); err != nil {
		return SeqOutput{}, fmt.Errorf("set_document_settings: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetDocSettings{SetDocSettings: &opendesignerv1.SetDocSettings{Settings: next}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

func registerDocSettingsTools(srv *mcp.Server, s *Session) {
	addTool(srv, "set_document_settings", "Set the document's vertical (publishing | design | product: it shapes which modes, tools and menu entries the editor offers) and its baseline grid. Page size, margins, columns and bleed are set per page with create_page / update_page.", s.SetDocumentSettings)
}
