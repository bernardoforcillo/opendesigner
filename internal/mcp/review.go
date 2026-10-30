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

type ReviewConsistencyOutput struct {
	Issues []review.Issue `json:"issues" jsonschema:"suggestions, grouped by rule; empty when the document is consistent"`
}

// ReviewConsistency looks for the same thing said two slightly different ways.
func (s *Session) ReviewConsistency(_ context.Context, _ struct{}) (ReviewConsistencyOutput, error) {
	s.mu.Lock()
	issues := review.ReviewConsistency(s.doc)
	s.mu.Unlock()
	if issues == nil {
		issues = []review.Issue{}
	}
	return ReviewConsistencyOutput{Issues: issues}, nil
}

// TokenUsage reports where tokens and shared styles are used.
func (s *Session) TokenUsage(_ context.Context, _ struct{}) (review.TokenUsageReport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return review.TokenUsage(s.doc), nil
}

func registerReviewTools(srv *mcp.Server, s *Session) {
	addTool(srv, "review_consistency", "Find the same thing said two slightly different ways: colors a few steps apart (near-color), a font size or corner radius one step from a commoner one (near-size, near-radius), and text with no text style in a document that has text styles (unstyled). These are suggestions, not failures: pick the main value and set_properties / bind_variable / set_text_style the odd ones to it, then review again.", s.ReviewConsistency)
	addTool(srv, "token_usage", "Where the design tokens are used: every variable and every text, paint and effect style with the number of properties that use it, the ones nothing uses (unused), and colors written by value three or more times that no variable has (candidates: create a color variable with set_variable and bind_variable it).", s.TokenUsage)
	addTool(srv, "review_design", "Review the design against rules that can be checked mechanically: text contrast (WCAG AA, 4.5:1 or 3:1 for large text), tap targets of interactive elements (>= 44px) and use of design tokens (a literal color that a color variable already has). Each issue names the node; fix them with set_properties or bind_variable, then review again.", s.ReviewDesign)
}
