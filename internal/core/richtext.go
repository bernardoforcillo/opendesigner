package core

import (
	"errors"
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// RICH TEXT -- paragraph styles per paragraph and character styles over ranges. The Go half (the
// authority) of web/src/store/richText.ts. A text node's `paragraph_styles` and `runs` are written by
// SetText with rich_present; a SetText without it keeps them adjusted to the new content.
//
//	1. a paragraph is a piece of the content between "\n" (a "\r\n" or "\r" counts as one "\n");
//	   paragraph_styles has at most one entry per paragraph, "" or the id of an existing PARAGRAPH style;
//	2. runs are sorted, non-overlapping, 0 <= start < end <= length of the content in UTF-16 code units,
//	   and name an existing CHARACTER style.
//
// A style that is deleted later leaves its id behind: it is ignored when drawing (and comes back to
// life if the style does, which is what makes undo of a style deletion exact).

var ErrBadRichText = errors.New("core: invalid rich text (paragraph styles or runs)")

// utf16Len is the length of s in UTF-16 code units, the unit of JavaScript string indices.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// paragraphCount is how many paragraphs content has.
func paragraphCount(content string) int {
	c := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	return strings.Count(c, "\n") + 1
}

func validateRich(doc *opendesignerv1.Document, content string, paras []string, runs []*opendesignerv1.TextRun) error {
	if len(paras) > paragraphCount(content) {
		return fmt.Errorf("%w: %d paragraph styles for %d paragraphs", ErrBadRichText, len(paras), paragraphCount(content))
	}
	for _, id := range paras {
		if id == "" {
			continue
		}
		d, ok := doc.GetTextStyles()[id]
		if !ok || d.GetKind() != opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_PARAGRAPH {
			return fmt.Errorf("%w: %q is not a paragraph style", ErrBadRichText, id)
		}
	}
	size := utf16Len(content)
	prev := 0
	for _, r := range runs {
		if r == nil || int(r.GetStart()) < prev || r.GetStart() >= r.GetEnd() || int(r.GetEnd()) > size {
			return fmt.Errorf("%w: run %d..%d", ErrBadRichText, r.GetStart(), r.GetEnd())
		}
		d, ok := doc.GetTextStyles()[r.GetStyleId()]
		if !ok || d.GetKind() != opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER {
			return fmt.Errorf("%w: %q is not a character style", ErrBadRichText, r.GetStyleId())
		}
		prev = int(r.GetEnd())
	}
	return nil
}

// clampRich adjusts what a node already has to new content: runs are cut to its length (and dropped
// when nothing is left), paragraph styles to the paragraph count.
func clampRich(t *opendesignerv1.TextNode) {
	if len(t.Runs) > 0 {
		size := int32(utf16Len(t.Content))
		kept := t.Runs[:0:0]
		for _, r := range t.Runs {
			if r.GetStart() >= size {
				break
			}
			if r.GetEnd() > size {
				r = &opendesignerv1.TextRun{Start: r.GetStart(), End: size, StyleId: r.GetStyleId()}
			}
			kept = append(kept, r)
		}
		t.Runs = kept
	}
	if n := paragraphCount(t.Content); len(t.ParagraphStyles) > n {
		t.ParagraphStyles = t.ParagraphStyles[:n]
	}
}

// ValidateRichText is validateRich for the MCP tools, which run the authority's own check before submitting.
func ValidateRichText(doc *opendesignerv1.Document, content string, paras []string, runs []*opendesignerv1.TextRun) error {
	return validateRich(doc, content, paras, runs)
}
