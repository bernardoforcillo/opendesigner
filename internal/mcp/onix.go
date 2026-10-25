package mcp

import (
	"context"
	"fmt"
	"time"

	"github.com/bernardoforcillo/opendesigner/internal/onix"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// export_onix: the book record (set_document_settings book) as an ONIX for Books message. Made here, by the
// server, with the same code path as the editor's byte for byte (internal/onix and web/src/export/onix.ts share
// fixtures), so it needs no editor open.

type ExportOnixInput struct {
	OutPath string `json:"outPath,omitempty" jsonschema:"file path, or a directory (the file is then <isbn>.onix.xml); empty = do not write, return the xml"`
	Release string `json:"release,omitempty" jsonschema:"3.1 (default) | 3.0"`
}

type ExportOnixOutput struct {
	Path     string         `json:"path,omitempty"`
	Xml      string         `json:"xml,omitempty" jsonschema:"the message, when no outPath was given"`
	Problems []onix.Problem `json:"problems" jsonschema:"what a trade partner will miss (errors would have stopped the export)"`
}

// ExportOnix builds the ONIX message from the document's book record.
func (s *Session) ExportOnix(ctx context.Context, in ExportOnixInput) (ExportOnixOutput, error) {
	switch in.Release {
	case "", "3.1", "3.0":
	default:
		return ExportOnixOutput{}, fmt.Errorf("export_onix: release must be 3.1 or 3.0, got %q", in.Release)
	}
	s.mu.Lock()
	book := s.doc.GetSettings().GetBook()
	s.mu.Unlock()
	problems := onix.Problems(book)
	for _, p := range problems {
		if p.Severity == "error" {
			return ExportOnixOutput{Problems: problems}, fmt.Errorf("export_onix: %s (set the book record with set_document_settings)", p.Message)
		}
	}
	xml := onix.Build(book, time.Now(), in.Release)
	out := ExportOnixOutput{Problems: problems}
	if in.OutPath == "" {
		out.Xml = xml
		return out, nil
	}
	path, err := writeResult(in.OutPath, book.GetIsbn13()+".onix.xml", []byte(xml))
	if err != nil {
		return ExportOnixOutput{}, fmt.Errorf("export_onix: %w", err)
	}
	out.Path = path
	return out, nil
}

func registerOnixTools(srv *mcp.Server, s *Session) {
	addTool(srv, "export_onix", "Export the document's book record as an ONIX for Books message (release 3.1 default, or 3.0; reference tag names). Needs at least an ISBN-13 and a title in the record (set_document_settings { book }). Returns what a trade partner will still miss. The shape of codes is checked, not their membership in the EDItEUR code lists, and the file is not validated against the XSD: validate before sending it to a partner. No editor needs to be open.", s.ExportOnix)
}
