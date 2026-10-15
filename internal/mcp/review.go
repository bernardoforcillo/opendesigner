package mcp

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/bernardoforcillo/opendesigner/internal/review"
)

type ReviewDesignOutput struct {
	Issues []review.Issue `json:"issues" jsonschema:"errors first; empty when the design passes"`
	Errors int            `json:"errors"`
	Warns  int            `json:"warnings"`
}

// ReviewDesign runs the mechanical design review on the session's current document.
func (s *Session) ReviewDesign(_ context.Context, _ struct{}) (ReviewDesignOutput, error) {
	s.mu.Lock()
	issues := review.Review(s.doc)
	s.mu.Unlock()
	out := ReviewDesignOutput{Issues: issues}
	if out.Issues == nil {
		out.Issues = []review.Issue{}
	}
	for _, i := range issues {
		if i.Severity == review.Error {
			out.Errors++
		} else {
			out.Warns++
		}
	}
	return out, nil
}

func registerReviewTools(srv *mcp.Server, s *Session) {
	addTool(srv, "review_design", "Review the design against rules that can be checked mechanically: text contrast (WCAG AA, 4.5:1 or 3:1 for large text), tap targets of interactive elements (>= 44px) and use of design tokens (a literal color that a color variable already has). Each issue names the node; fix them with set_properties or bind_variable, then review again.", s.ReviewDesign)
}
